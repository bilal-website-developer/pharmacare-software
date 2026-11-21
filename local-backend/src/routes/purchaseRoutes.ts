import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { canViewCost } from '../services/costRedactor';
import { localIsoDate } from '../services/fefoEngine';

export function registerPurchaseRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. Purchase Catalog (Select medicines to buy)
  app.get('/api/purchases/catalog', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const medicines = db.prepare(`
        SELECT m.id, m.code, m.brand_name, m.generic_name, m.strength,
               COALESCE(c.name, '') as category_name,
               COALESCE(b.name, '') as brand_name_company,
               COALESCE((SELECT SUM(sb.quantity_smallest_unit) FROM stock_batches sb
                         WHERE sb.medicine_id = m.id AND sb.status IN ('ACTIVE', 'NEAR_EXPIRY')
                           AND sb.quantity_smallest_unit > 0), 0) AS stock,
               (SELECT sb.cost_price_paisa FROM stock_batches sb
                WHERE sb.medicine_id = m.id AND sb.quantity_smallest_unit > 0
                ORDER BY sb.received_date DESC, sb.created_at DESC LIMIT 1) AS last_cost_base_paisa,
               m.barcode
        FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN brands b ON m.brand_id = b.id
        WHERE m.is_active = 1 AND m.deleted_at IS NULL
        ORDER BY m.brand_name ASC
      `).all() as any[];

      const units = db.prepare(`
        SELECT id, medicine_id, name, conversion_factor, price_per_unit_paisa, is_default_sale_unit
        FROM medicine_units
        WHERE is_active = 1
      `).all() as any[];

      const unitsByMed = new Map<string, any[]>();
      for (const u of units) {
        if (!unitsByMed.has(u.medicine_id)) unitsByMed.set(u.medicine_id, []);
        unitsByMed.get(u.medicine_id)!.push({
          id: u.id,
          name: u.name,
          conversionFactor: u.conversion_factor,
          pricePerUnitPaisa: u.price_per_unit_paisa,
          isDefaultSaleUnit: u.is_default_sale_unit === 1,
        });
      }

      const catalog = medicines.map((m) => ({
        id: m.id,
        code: m.code,
        brandName: m.brand_name,
        genericName: m.generic_name,
        strength: m.strength || '',
        category: m.category_name,
        company: m.brand_name_company,
        stock: m.stock,
        lastCostBasePaisa: m.last_cost_base_paisa,
        barcode: m.barcode || null,
        units: unitsByMed.get(m.id) || [],
      }));

      return reply.send(catalog);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. Post Purchase (Atomic Transaction)
  app.post('/api/purchases', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { userId: string; username: string; role: string; permissions: string[] };

      if (!canViewCost(user.role, user.permissions)) {
        return reply.status(403).send({ error: 'Permission denied for purchasing.' });
      }

      const body = request.body as {
        supplierId: string;
        invoiceNumber: string;
        purchaseDate?: string;
        items: Array<{
          medicineId: string;
          unitName: string;
          quantity: number;
          packSize: number;
          costPerPackPaisa: number;
          mrpPaisa: number;
          batchNumber: string;
          expiryDate: string;
          bonusQty?: number;
        }>;
        paidAmountPaisa?: number;
        paymentMethod?: string;
        discountPaisa?: number;
        notes?: string;
      };

      if (!body.supplierId || !Array.isArray(body.items) || body.items.length === 0) {
        return reply.status(400).send({ error: 'Supplier and at least one item are required.' });
      }

      const today = body.purchaseDate || localIsoDate();
      const now = Math.floor(Date.now() / 1000);

      const transaction = db.transaction(() => {
        const supplier = db.prepare('SELECT id, name, balance_paisa FROM suppliers WHERE id = ?').get(body.supplierId) as any;
        if (!supplier) throw new Error('Supplier not found.');

        // Generate sequential purchase number PR-0001
        const countRow = db.prepare('SELECT COUNT(*) as cnt FROM purchases').get() as { cnt: number };
        const prSeq = (countRow.cnt + 1).toString().padStart(4, '0');
        const purchaseNumber = `PR-${prSeq}`;
        const purchaseId = crypto.randomUUID();
        const subtotalPaisa = body.items.reduce(
          (subtotal, item) => subtotal + item.quantity * item.costPerPackPaisa,
          0,
        );
        const discountPaisa = body.discountPaisa || 0;
        if (!Number.isSafeInteger(discountPaisa) || discountPaisa < 0 || discountPaisa > subtotalPaisa) {
          throw new Error('Discount must be a non-negative amount no greater than the subtotal.');
        }
        const totalAmountPaisa = subtotalPaisa - discountPaisa;
        const requestedPaid = body.paidAmountPaisa || 0;
        if (!Number.isSafeInteger(requestedPaid) || requestedPaid < 0) {
          throw new Error('Paid amount must be a non-negative whole number of paisa.');
        }
        const paidAmountPaisa = Math.min(totalAmountPaisa, requestedPaid);
        const paymentStatus = paidAmountPaisa === totalAmountPaisa ? 'PAID' : (paidAmountPaisa > 0 ? 'PARTIAL' : 'CREDIT');
        const unpaidPaisa = totalAmountPaisa - paidAmountPaisa;
        const paymentMethod = body.paymentMethod === 'CASH' ? 'CASH' : 'CREDIT';

        db.prepare(`
          INSERT INTO purchases (
            id, purchase_number, supplier_id, invoice_number, purchase_date, total_amount_paisa,
            subtotal_amount_paisa, discount_amount_paisa, paid_amount_paisa, payment_method,
            payment_status, notes, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          purchaseId,
          purchaseNumber,
          supplier.id,
          body.invoiceNumber,
          today,
          totalAmountPaisa,
          subtotalPaisa,
          discountPaisa,
          paidAmountPaisa,
          paymentMethod,
          paymentStatus,
          body.notes || null,
          user.userId,
          now
        );

        for (const item of body.items) {
          const itemTotal = item.quantity * item.costPerPackPaisa;
          const bonusQty = item.bonusQty || 0;

          const purchaseItemId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO purchase_items (
              id, purchase_id, medicine_id, unit_name, quantity, bonus_qty, pack_size,
              cost_per_pack_paisa, total_cost_paisa, mrp_paisa, batch_number, expiry_date, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            purchaseItemId,
            purchaseId,
            item.medicineId,
            item.unitName,
            item.quantity,
            bonusQty,
            item.packSize || 1,
            item.costPerPackPaisa,
            itemTotal,
            item.mrpPaisa || 0,
            item.batchNumber.trim(),
            item.expiryDate,
            now
          );

          // Add / update stock batch
          const totalSmallestUnits = (item.quantity + bonusQty) * (item.packSize || 1);
          const costPricePaisaPerSmallest = Math.round(item.costPerPackPaisa / Math.max(1, item.packSize || 1));
          const batchId = crypto.randomUUID();

          db.prepare(`
            INSERT INTO stock_batches (
              id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa, mrp_paisa, quantity_smallest_unit, status, supplier_id, supplier_name, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
          `).run(
            batchId,
            item.medicineId,
            item.batchNumber.trim(),
            item.expiryDate,
            today,
            costPricePaisaPerSmallest,
            item.mrpPaisa || 0,
            totalSmallestUnits,
            supplier.id,
            supplier.name,
            now,
            now
          );

          // Record stock movement
          db.prepare(`
            INSERT INTO stock_movements (
              id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after, reference_id, notes, created_by, created_at
            ) VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            item.medicineId,
            batchId,
            totalSmallestUnits,
            totalSmallestUnits,
            purchaseId,
            `Purchase ${purchaseNumber}`,
            user.userId,
            now
          );
        }

        // Update supplier balance if there is unpaid credit
        if (unpaidPaisa > 0) {
          db.prepare(`
            UPDATE suppliers
            SET balance_paisa = balance_paisa + ?, updated_at = ?
            WHERE id = ?
          `).run(unpaidPaisa, now, supplier.id);

          db.prepare(`
            INSERT INTO supplier_ledger (
              id, supplier_id, date, type, reference_no, description, debit_paisa, credit_paisa, running_balance_paisa, created_at
            ) VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, 0, (SELECT balance_paisa FROM suppliers WHERE id = ?), ?)
          `).run(
            crypto.randomUUID(),
            supplier.id,
            today,
            purchaseNumber,
            `Purchase Invoice ${body.invoiceNumber}`,
            unpaidPaisa,
            supplier.id,
            now
          );
        }

        // If paid with cash, record outflow in cash_transactions
        if (paidAmountPaisa > 0 && paymentMethod === 'CASH') {
          db.prepare(`
            INSERT INTO cash_transactions (
              id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at
            ) VALUES (?, ?, ?, 'SUPPLIER_PAYMENT', ?, ?, 1, ?, ?)
          `).run(
            crypto.randomUUID(),
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            today,
            `Purchase ${purchaseNumber} payment to ${supplier.name}`,
            paidAmountPaisa,
            user.username,
            now
          );
        }

        return { purchaseId, purchaseNumber, totalAmountPaisa };
      });

      const result = transaction();
      return reply.status(201).send({ success: true, ...result });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  const purchaseItems = (purchaseId: string) => db.prepare(`
    SELECT pi.medicine_id, m.brand_name AS product_name, m.generic_name, pi.unit_name,
           pi.batch_number, pi.expiry_date, pi.quantity, pi.bonus_qty,
           pi.pack_size AS conversion_factor, pi.cost_per_pack_paisa AS unit_cost_paisa,
           pi.mrp_paisa, pi.total_cost_paisa AS line_total_paisa
    FROM purchase_items pi
    JOIN medicines m ON m.id = pi.medicine_id
    WHERE pi.purchase_id = ?
    ORDER BY pi.created_at, pi.id
  `).all(purchaseId) as any[];

  const mapPurchase = (row: any, includeItems: boolean) => ({
    id: row.id,
    pr_no: row.purchase_number,
    supplier_name: row.supplier_name,
    supplier_contact: row.supplier_contact || '',
    supplier_address: row.supplier_address || '',
    invoice_number: row.invoice_number || null,
    purchase_date: row.purchase_date,
    subtotal_paisa: row.subtotal_amount_paisa || row.total_amount_paisa,
    discount_paisa: row.discount_amount_paisa || 0,
    total_paisa: row.total_amount_paisa,
    paid_paisa: row.paid_amount_paisa,
    due_paisa: row.total_amount_paisa - row.paid_amount_paisa,
    payment_type: row.payment_method === 'CASH' ? 'cash' : 'credit',
    status: row.is_voided === 1 ? 'void' : 'posted',
    notes: row.notes || null,
    void_reason: row.void_reason || null,
    created_by: row.created_by || '',
    created_at: new Date(row.created_at * 1000).toISOString(),
    item_count: row.item_count,
    ...(includeItems ? { items: purchaseItems(row.id) } : {}),
  });

  app.get('/api/purchases/history', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user as { role: string; permissions: string[] };
      if (!canViewCost(user.role, user.permissions)) {
        return reply.status(403).send({ error: 'Permission denied.' });
      }
      const query = request.query as {
        p_search?: string;
        p_payment_type?: string;
        p_date_from?: string;
        p_date_to?: string;
        p_page?: string;
        p_page_size?: string;
        p_export?: string;
      };
      let where = 'WHERE 1 = 1';
      const params: unknown[] = [];
      if (query.p_search?.trim()) {
        where += ' AND (p.purchase_number LIKE ? OR p.invoice_number LIKE ? OR s.name LIKE ? OR COALESCE(p.notes, \'\') LIKE ?)';
        const search = `%${query.p_search.trim()}%`;
        params.push(search, search, search, search);
      }
      if (query.p_payment_type === 'cash' || query.p_payment_type === 'credit') {
        where += ' AND p.payment_method = ?';
        params.push(query.p_payment_type === 'cash' ? 'CASH' : 'CREDIT');
      }
      if (query.p_date_from && /^\d{4}-\d{2}-\d{2}$/.test(query.p_date_from)) {
        where += ' AND p.purchase_date >= ?';
        params.push(query.p_date_from);
      }
      if (query.p_date_to && /^\d{4}-\d{2}-\d{2}$/.test(query.p_date_to)) {
        where += ' AND p.purchase_date <= ?';
        params.push(query.p_date_to);
      }
      const from = `
        FROM purchases p
        JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN users u ON p.created_by = u.id
        ${where}
      `;
      const count = (db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...params) as { count: number }).count;
      const totals = db.prepare(`
        SELECT COALESCE(SUM(p.total_amount_paisa), 0) AS total_paisa,
               COALESCE(SUM(CASE WHEN p.payment_method = 'CASH' THEN p.total_amount_paisa ELSE 0 END), 0) AS cash_paisa,
               SUM(CASE WHEN p.payment_method = 'CASH' THEN 1 ELSE 0 END) AS cash_count,
               COALESCE(SUM(CASE WHEN p.payment_method = 'CREDIT' THEN p.total_amount_paisa ELSE 0 END), 0) AS credit_paisa,
               SUM(CASE WHEN p.payment_method = 'CREDIT' THEN 1 ELSE 0 END) AS credit_count
        ${from}
      `).get(...params) as any;
      const page = Math.max(1, Number.parseInt(query.p_page || '1', 10) || 1);
      const exporting = query.p_export === 'true';
      const pageSize = exporting ? count : Math.max(1, Math.min(500, Number.parseInt(query.p_page_size || '25', 10) || 25));
      const rows = db.prepare(`
        SELECT p.*, s.name AS supplier_name, s.contact_person AS supplier_contact,
               s.phone AS supplier_phone, s.address AS supplier_address, u.username AS created_by,
               (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
        ${from}
        ORDER BY p.created_at DESC, p.id
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, exporting ? 0 : (page - 1) * pageSize) as any[];
      const mappedRows = rows.map((row) => {
        if (!row.supplier_contact) row.supplier_contact = row.supplier_phone;
        return mapPurchase(row, exporting);
      });
      return reply.send({
        rows: mappedRows,
        total_count: count,
        total_paisa: Number(totals.total_paisa),
        cash_paisa: Number(totals.cash_paisa),
        cash_count: Number(totals.cash_count || 0),
        credit_paisa: Number(totals.credit_paisa),
        credit_count: Number(totals.credit_count || 0),
        page,
        page_size: exporting ? null : pageSize,
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load purchase history.' });
    }
  });

  app.get('/api/purchases/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const row = db.prepare(`
        SELECT p.*, s.name AS supplier_name, s.contact_person AS supplier_contact,
               s.phone AS supplier_phone, s.address AS supplier_address, u.username AS created_by,
               (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
        FROM purchases p
        JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN users u ON p.created_by = u.id
        WHERE p.id = ?
      `).get(id) as any;
      if (!row) return reply.status(404).send({ error: 'Purchase not found.' });
      if (!row.supplier_contact) row.supplier_contact = row.supplier_phone;
      return reply.send(mapPurchase(row, true));
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load purchase details.' });
    }
  });

  app.post('/api/purchases/:id/void', async (request, reply) => {
    try {
      const user = request.user as { userId: string; username: string; role: string };
      if (user.role !== 'admin') return reply.status(403).send({ error: 'Only admins can void purchases.' });
      const { id } = request.params as { id: string };
      const body = request.body as { reason?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) return reply.status(400).send({ error: 'A reason is required to void this purchase.' });
      const now = Math.floor(Date.now() / 1000);
      const transaction = db.transaction(() => {
        const purchase = db.prepare(`
          SELECT id, purchase_number, supplier_id, total_amount_paisa, paid_amount_paisa,
                 payment_method, is_voided
          FROM purchases WHERE id = ?
        `).get(id) as any;
        if (!purchase) throw new Error('Purchase not found.');
        if (purchase.is_voided === 1) throw new Error('This purchase is already voided.');
        const movements = db.prepare(`
          SELECT sm.batch_id, sm.quantity_smallest_units, sb.quantity_smallest_unit,
                 sb.medicine_id, sb.batch_number
          FROM stock_movements sm
          JOIN stock_batches sb ON sb.id = sm.batch_id
          WHERE sm.reference_id = ? AND sm.movement_type = 'PURCHASE'
        `).all(id) as any[];
        if (movements.some((movement) => movement.quantity_smallest_unit < movement.quantity_smallest_units)) {
          throw new Error('This purchase cannot be voided because some of its stock has already been used.');
        }
        for (const movement of movements) {
          const balance = movement.quantity_smallest_unit - movement.quantity_smallest_units;
          db.prepare('UPDATE stock_batches SET quantity_smallest_unit = ?, updated_at = ? WHERE id = ?')
            .run(balance, now, movement.batch_id);
          db.prepare(`
            INSERT INTO stock_movements (
              id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after,
              reference_id, notes, created_by, created_at
            ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            movement.medicine_id,
            movement.batch_id,
            -movement.quantity_smallest_units,
            balance,
            id,
            `Voided purchase ${purchase.purchase_number}`,
            user.userId,
            now,
          );
        }
        const due = purchase.total_amount_paisa - purchase.paid_amount_paisa;
        const supplier = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(purchase.supplier_id) as { balance_paisa: number };
        const nextBalance = supplier.balance_paisa - due;
        db.prepare('UPDATE suppliers SET balance_paisa = ?, updated_at = ? WHERE id = ?')
          .run(nextBalance, now, purchase.supplier_id);
        if (due > 0) {
          db.prepare(`
            INSERT INTO supplier_ledger (
              id, supplier_id, date, type, reference_no, description, debit_paisa, credit_paisa,
              running_balance_paisa, created_at
            ) VALUES (?, ?, date('now'), 'RETURN', ?, ?, 0, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            purchase.supplier_id,
            purchase.purchase_number,
            `Voided purchase: ${reason}`,
            due,
            nextBalance,
            now,
          );
        }
        if (purchase.payment_method === 'CASH' && purchase.paid_amount_paisa > 0) {
          db.prepare(`
            INSERT INTO cash_transactions (
              id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at
            ) VALUES (?, ?, date('now'), 'SUPPLIER_REFUND', ?, ?, 0, ?, ?)
          `).run(
            crypto.randomUUID(),
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            `Refund for voided purchase ${purchase.purchase_number}`,
            purchase.paid_amount_paisa,
            user.username,
            now,
          );
        }
        db.prepare(`
          UPDATE purchases SET is_voided = 1, voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?
        `).run(now, user.username, reason, id);
        db.prepare(`
          INSERT INTO trash_bin_events (
            id, entity_type, entity_id, entity_name, action, reason,
            performed_by, performed_by_name, created_at
          ) VALUES (?, 'purchase', ?, ?, 'void', ?, ?, ?, ?)
        `).run(crypto.randomUUID(), id, purchase.purchase_number, reason, user.userId, user.username, now);
      });
      transaction();
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not void purchase.' });
    }
  });

  // 4. Suppliers List & Create
  app.get('/api/suppliers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = db.prepare(`
        SELECT id, name, contact_person, phone, email, address, licence_or_tax_number,
               payment_terms, balance_paisa, is_active, created_at
        FROM suppliers
        WHERE deleted_at IS NULL
        ORDER BY name ASC
      `).all() as any[];

      return reply.send(rows.map((r) => ({
        id: r.id,
        name: r.name,
        contactPerson: r.contact_person || '',
        contact: r.contact_person || r.phone || r.email || '',
        phone: r.phone || '',
        email: r.email || '',
        address: r.address || '',
        licence_or_tax_number: r.licence_or_tax_number || '',
        payment_terms: r.payment_terms || 'CASH',
        balancePaisa: r.balance_paisa,
        isActive: r.is_active === 1,
        created_at: new Date(r.created_at * 1000).toISOString(),
      })));
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  app.post('/api/suppliers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const body = request.body as any;
      if (!body.name) return reply.status(400).send({ error: 'Supplier name is required.' });

      const now = Math.floor(Date.now() / 1000);
      const user = request.user as { userId: string; username: string };
      const isNew = !body.id;
      const supplierId = body.id || crypto.randomUUID();

      if (isNew) {
        db.prepare(`
            INSERT INTO suppliers (
              id, name, contact_person, phone, email, address, licence_or_tax_number,
              payment_terms, balance_paisa, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        `).run(
          supplierId,
          body.name.trim(),
            body.contact || body.contactPerson || null,
          body.phone || null,
          body.email || null,
          body.address || null,
            body.licence_or_tax_number || '',
            body.payment_terms || 'CASH',
          now,
          now
        );
      } else {
        db.prepare(`
          UPDATE suppliers
          SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
              licence_or_tax_number = ?, payment_terms = ?, updated_at = ?
          WHERE id = ?
        `).run(
          body.name.trim(),
          body.contact || body.contactPerson || null,
          body.phone || null,
          body.email || null,
          body.address || null,
          body.licence_or_tax_number || '',
          body.payment_terms || 'CASH',
          now,
          supplierId
        );
      }

      return reply.send({ id: supplierId, success: true });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.put('/api/suppliers/:id/status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { isActive?: unknown };
      const user = request.user as { userId: string; username: string };
      if (typeof body.isActive !== 'boolean') return reply.status(400).send({ error: 'isActive must be a boolean.' });
      const now = Math.floor(Date.now() / 1000);
      const transaction = db.transaction(() => {
        const supplier = db.prepare('SELECT name, is_active FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string; is_active: number } | undefined;
        if (!supplier) return false;
        db.prepare('UPDATE suppliers SET is_active = ?, updated_at = ? WHERE id = ?')
          .run(body.isActive ? 1 : 0, now, id);
        if (!body.isActive && supplier.is_active === 1) {
          db.prepare(`
            INSERT INTO trash_bin_events (
              id, entity_type, entity_id, entity_name, action, reason,
              performed_by, performed_by_name, created_at
            ) VALUES (?, 'supplier', ?, ?, 'deactivate', 'Supplier deactivated.', ?, ?, ?)
          `).run(crypto.randomUUID(), id, supplier.name, user.userId, user.username, now);
        }
        return true;
      });
      if (!transaction()) return reply.status(404).send({ error: 'Supplier not found.' });
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not change supplier status.' });
    }
  });

  app.get('/api/suppliers/:id/ledger', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!supplier) return reply.status(404).send({ error: 'Supplier not found.' });
      const rows = db.prepare(`
        SELECT id, date, reference_no, description, debit_paisa, credit_paisa, running_balance_paisa
        FROM supplier_ledger WHERE supplier_id = ? ORDER BY created_at, id
      `).all(id) as any[];
      return reply.send(rows.map((row) => ({
        id: row.id,
        supplier_id: id,
        date: row.date,
        description: row.description || row.reference_no || '',
        debit: row.debit_paisa,
        credit: row.credit_paisa,
        balance: row.running_balance_paisa,
      })));
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load supplier ledger.' });
    }
  });

  app.post('/api/suppliers/:id/ledger', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { date?: unknown; description?: unknown; debit?: unknown; credit?: unknown };
      const date = typeof body.date === 'string' ? body.date : '';
      const debit = body.debit;
      const credit = body.credit;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isSafeInteger(debit) || (debit as number) < 0
        || !Number.isSafeInteger(credit) || (credit as number) < 0
        || ((debit as number) > 0) === ((credit as number) > 0)) {
        return reply.status(400).send({ error: 'Enter a valid date and exactly one positive debit or credit amount.' });
      }
      const now = Math.floor(Date.now() / 1000);
      const transaction = db.transaction(() => {
        const supplier = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id) as { balance_paisa: number } | undefined;
        if (!supplier) throw new Error('Supplier not found.');
        const nextBalance = supplier.balance_paisa + (debit as number) - (credit as number);
        const entryId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO supplier_ledger (
            id, supplier_id, date, type, reference_no, description, debit_paisa, credit_paisa,
            running_balance_paisa, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entryId,
          id,
          date,
          (debit as number) > 0 ? 'PURCHASE' : 'PAYMENT',
          'MANUAL',
          typeof body.description === 'string' ? body.description.trim() : '',
          debit,
          credit,
          nextBalance,
          now,
        );
        db.prepare('UPDATE suppliers SET balance_paisa = ?, updated_at = ? WHERE id = ?')
          .run(nextBalance, now, id);
        return entryId;
      });
      return reply.send({ id: transaction(), success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not save supplier ledger entry.' });
    }
  });
}
