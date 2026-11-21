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
               COALESCE(b.name, '') as brand_name_company
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
        }>;
        paidAmountPaisa?: number;
        paymentMethod?: string;
        notes?: string;
      };

      if (!body.supplierId || !body.invoiceNumber || !body.items || body.items.length === 0) {
        return reply.status(400).send({ error: 'Supplier, invoice number, and at least one item required.' });
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

        let totalAmountPaisa = 0;

        for (const item of body.items) {
          const itemTotal = item.quantity * item.costPerPackPaisa;
          totalAmountPaisa += itemTotal;

          const purchaseItemId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO purchase_items (
              id, purchase_id, medicine_id, unit_name, quantity, pack_size, cost_per_pack_paisa, total_cost_paisa, batch_number, expiry_date, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            purchaseItemId,
            purchaseId,
            item.medicineId,
            item.unitName,
            item.quantity,
            item.packSize || 1,
            item.costPerPackPaisa,
            itemTotal,
            item.batchNumber.trim(),
            item.expiryDate,
            now
          );

          // Add / update stock batch
          const totalSmallestUnits = item.quantity * (item.packSize || 1);
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

        const paidAmountPaisa = Math.max(0, Math.min(totalAmountPaisa, body.paidAmountPaisa || 0));
        const paymentStatus = paidAmountPaisa === totalAmountPaisa ? 'PAID' : (paidAmountPaisa > 0 ? 'PARTIAL' : 'CREDIT');
        const unpaidPaisa = totalAmountPaisa - paidAmountPaisa;

        // Insert purchase record
        db.prepare(`
          INSERT INTO purchases (
            id, purchase_number, supplier_id, invoice_number, purchase_date, total_amount_paisa, paid_amount_paisa, payment_status, notes, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          purchaseId,
          purchaseNumber,
          supplier.id,
          body.invoiceNumber,
          today,
          totalAmountPaisa,
          paidAmountPaisa,
          paymentStatus,
          body.notes || null,
          user.userId,
          now
        );

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
        if (paidAmountPaisa > 0 && body.paymentMethod === 'CASH') {
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

  // 3. Purchase History
  app.get('/api/purchases/history', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string; permissions: string[] };
      if (!canViewCost(user.role, user.permissions)) {
        return reply.status(403).send({ error: 'Permission denied.' });
      }

      const rows = db.prepare(`
        SELECT p.id, p.purchase_number, p.invoice_number, p.purchase_date, p.total_amount_paisa,
               p.paid_amount_paisa, p.payment_status, p.notes, p.is_voided, p.void_reason,
               s.name as supplier_name, s.id as supplier_id
        FROM purchases p
        JOIN suppliers s ON p.supplier_id = s.id
        ORDER BY p.created_at DESC
      `).all() as any[];

      const purchases = rows.map((r) => ({
        id: r.id,
        purchaseNumber: r.purchase_number,
        invoiceNumber: r.invoice_number,
        purchaseDate: r.purchase_date,
        totalAmountPaisa: r.total_amount_paisa,
        paidAmountPaisa: r.paid_amount_paisa,
        paymentStatus: r.payment_status,
        notes: r.notes || '',
        isVoided: r.is_voided === 1,
        voidReason: r.void_reason || '',
        supplierName: r.supplier_name,
        supplierId: r.supplier_id,
      }));

      return reply.send(purchases);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 4. Suppliers List & Create
  app.get('/api/suppliers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = db.prepare(`
        SELECT id, name, contact_person, phone, email, address, balance_paisa, is_active
        FROM suppliers
        WHERE deleted_at IS NULL
        ORDER BY name ASC
      `).all() as any[];

      return reply.send(rows.map((r) => ({
        id: r.id,
        name: r.name,
        contactPerson: r.contact_person || '',
        phone: r.phone || '',
        email: r.email || '',
        address: r.address || '',
        balancePaisa: r.balance_paisa,
        isActive: r.is_active === 1,
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
      const isNew = !body.id;
      const supplierId = body.id || crypto.randomUUID();

      if (isNew) {
        db.prepare(`
          INSERT INTO suppliers (id, name, contact_person, phone, email, address, balance_paisa, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        `).run(
          supplierId,
          body.name.trim(),
          body.contactPerson || null,
          body.phone || null,
          body.email || null,
          body.address || null,
          now,
          now
        );
      } else {
        db.prepare(`
          UPDATE suppliers
          SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, updated_at = ?
          WHERE id = ?
        `).run(
          body.name.trim(),
          body.contactPerson || null,
          body.phone || null,
          body.email || null,
          body.address || null,
          now,
          supplierId
        );
      }

      return reply.send({ id: supplierId, success: true });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
