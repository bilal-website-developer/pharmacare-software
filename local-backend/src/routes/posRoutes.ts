import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { allocateFefoStock, localIsoDate } from '../services/fefoEngine';
import { canViewCost } from '../services/costRedactor';
import { checkLicenseStatus } from '../services/licenseService';

export function registerPosRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. POS Catalog (List sellable products with active batches and units)
  app.get('/api/pos/catalog', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let userRole = 'cashier';
      let userPermissions: string[] = [];
      try {
        await request.jwtVerify();
        const decoded = request.user as { role: string; permissions: string[] };
        userRole = decoded.role;
        userPermissions = decoded.permissions || [];
      } catch {
        // If unauthenticated or token expired, default to cashier redaction
      }

      const showCost = canViewCost(userRole, userPermissions);
      const today = localIsoDate();

      // Get all active medicines
      const medicines = db.prepare(`
        SELECT id, code, barcode, brand_name, generic_name, strength, category_id, brand_id,
               drug_class, storage_condition, rack_location, min_stock_alert, requires_prescription
        FROM medicines
        WHERE is_active = 1 AND deleted_at IS NULL
        ORDER BY brand_name ASC
      `).all() as any[];

      // Get all units
      const units = db.prepare(`
        SELECT id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa
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
          isDefaultSaleUnit: u.is_default_sale_unit === 1,
          pricePerUnitPaisa: u.price_per_unit_paisa,
        });
      }

      // Get sellable batches (quantity > 0, unexpired, active/near_expiry)
      const batches = db.prepare(`
        SELECT id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa,
               mrp_paisa, quantity_smallest_unit, status, supplier_name
        FROM stock_batches
        WHERE quantity_smallest_unit > 0
          AND status IN ('ACTIVE', 'NEAR_EXPIRY')
          AND expiry_date >= ?
        ORDER BY expiry_date ASC, received_date ASC, id ASC
      `).all(today) as any[];

      const batchesByMed = new Map<string, any[]>();
      for (const b of batches) {
        if (!batchesByMed.has(b.medicine_id)) batchesByMed.set(b.medicine_id, []);
        batchesByMed.get(b.medicine_id)!.push({
          id: b.id,
          productId: b.medicine_id,
          batchNumber: b.batch_number,
          expiryDate: b.expiry_date,
          receivedDate: b.received_date,
          costPricePaisa: showCost ? b.cost_price_paisa : null,
          mrpPaisa: b.mrp_paisa,
          quantitySmallestUnit: b.quantity_smallest_unit,
          status: b.status,
          supplierName: b.supplier_name || '',
        });
      }

      // Assemble products that have units and batches
      const catalog = medicines.map((m) => {
        const medUnits = unitsByMed.get(m.id) || [
          {
            id: `unit-${m.id}-base`,
            name: 'Unit',
            conversionFactor: 1,
            isDefaultSaleUnit: true,
            pricePerUnitPaisa: 0,
          },
        ];
        const medBatches = batchesByMed.get(m.id) || [];

        return {
          id: m.id,
          code: m.code,
          barcode: m.barcode || '',
          brandName: m.brand_name,
          genericName: m.generic_name,
          strength: m.strength || '',
          category: m.category_id || '',
          company: m.brand_id || '',
          drugClass: m.drug_class,
          storageCondition: m.storage_condition,
          rackLocation: m.rack_location || '',
          units: medUnits,
          batches: medBatches,
          minStockAlert: m.min_stock_alert,
          requiresPrescription: m.requires_prescription === 1,
        };
      });

      return reply.send(catalog);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. POS Checkout / Post Sale (Atomic Transaction)
  app.post('/api/pos/checkout', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { userId: string; username: string; role: string; permissions: string[] };

      // License Check
      const license = checkLicenseStatus(db);
      if (!license.allowNewTransactions) {
        return reply.status(403).send({
          error: license.message || 'New sales are restricted until license verification succeeds.',
        });
      }

      const body = request.body as {
        customerId?: string | null;
        customerName?: string;
        customerType?: string;
        customerPhone?: string;
        customerWhatsapp?: string;
        customerAddress?: string;
        customerNotes?: string;
        items: Array<{
          medicineId: string;
          unitId: string;
          quantityInUnit: number;
        }>;
        discountPaisa?: number;
        roundingPaisa?: number;
        tenderedPaisa?: number;
        payments: Array<{
          paymentMethod: string;
          amountPaisa: number;
          providerId?: string;
          reference?: string;
        }>;
      };

      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
        return reply.status(400).send({ error: 'Checkout must contain at least one item.' });
      }
      if (
        !Array.isArray(body.payments)
        || body.payments.length === 0
        || body.payments.length > 5
        || body.payments.some((payment) => (
          !['CASH', 'CARD', 'EASYPAISA', 'JAZZCASH', 'CREDIT'].includes(payment.paymentMethod)
          || !Number.isSafeInteger(payment.amountPaisa)
          || payment.amountPaisa <= 0
        ))
      ) {
        return reply.status(400).send({ error: 'Add one to five valid payment methods and amounts.' });
      }
      if (body.items.some((item) => (
        typeof item.medicineId !== 'string'
        || typeof item.unitId !== 'string'
        || !Number.isSafeInteger(item.quantityInUnit)
        || item.quantityInUnit <= 0
      ))) {
        return reply.status(400).send({ error: 'Each item must have a valid medicine, unit, and positive quantity.' });
      }
      if (
        !Number.isSafeInteger(body.discountPaisa || 0)
        || (body.discountPaisa || 0) < 0
        || !Number.isSafeInteger(body.roundingPaisa || 0)
        || !Number.isSafeInteger(body.tenderedPaisa || 0)
        || (body.tenderedPaisa || 0) < 0
      ) {
        return reply.status(400).send({ error: 'Discount, rounding, and tendered amounts must be valid whole paisa values.' });
      }
      if (body.payments.some((payment) => payment.paymentMethod === 'CREDIT') && !body.customerId) {
        return reply.status(400).send({ error: 'Credit sales require a registered customer.' });
      }
      if (body.customerId && !db.prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1').get(body.customerId)) {
        return reply.status(400).send({ error: 'The selected customer is not available.' });
      }

      const showCost = canViewCost(user.role, user.permissions);

      // Execute in a SQLite transaction
      const transaction = db.transaction(() => {
        const today = localIsoDate();
        const dateStamp = today.replace(/-/g, '');
        const now = Math.floor(Date.now() / 1000);

        // Generate sequential short and full invoice number
        const countRow = db.prepare(`
          SELECT COUNT(*) as cnt FROM sales WHERE invoice_number LIKE ?
        `).get(`INV-${dateStamp}-%`) as { cnt: number };

        const seq = (countRow.cnt + 1).toString().padStart(4, '0');
        const invoiceNumber = `INV-${dateStamp}-${seq}`;
        const shortInvoiceNumber = seq;
        const saleId = crypto.randomUUID();
        const primaryPayment = body.payments[0].paymentMethod;
        db.prepare(`
          INSERT INTO sales (
            id, invoice_number, short_invoice_number, customer_id, customer_name, customer_type,
            customer_phone, customer_whatsapp, customer_address, customer_notes,
            subtotal_paisa, discount_paisa, rounding_paisa, total_paisa, tendered_paisa, change_paisa,
            payment_method, cashier_id, cashier_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)
        `).run(
          saleId,
          invoiceNumber,
          shortInvoiceNumber,
          body.customerId || null,
          body.customerName || 'Walk-in Customer',
          body.customerType || 'WALK_IN',
          body.customerPhone || null,
          body.customerWhatsapp || null,
          body.customerAddress || null,
          body.customerNotes || null,
          body.payments.length > 1 ? 'SPLIT' : primaryPayment,
          user.userId,
          user.username,
          now,
        );

        let subtotalPaisa = 0;
        const processedItems: any[] = [];
        const allAllocations: any[] = [];

        for (const item of body.items) {
          const med = db.prepare(`
            SELECT id, brand_name, generic_name, drug_class
            FROM medicines
            WHERE id = ? AND is_active = 1 AND deleted_at IS NULL
          `).get(item.medicineId) as any;
          if (!med) throw new Error(`Medicine ${item.medicineId} not found.`);

          const unit = db.prepare(`
            SELECT id, name, conversion_factor, price_per_unit_paisa
            FROM medicine_units
            WHERE id = ? AND medicine_id = ? AND is_active = 1
          `).get(item.unitId, item.medicineId) as any;
          if (!unit) throw new Error('The selected sale unit is not available for this medicine.');

          const conversionFactor = unit ? unit.conversion_factor : 1;
          const unitName = unit ? unit.name : 'Unit';
          const pricePaisa = unit ? unit.price_per_unit_paisa : 0;
          const requiredSmallestUnits = item.quantityInUnit * conversionFactor;

          // Allocate batches via FEFO
          const allocations = allocateFefoStock(db, item.medicineId, requiredSmallestUnits, today);
          const lineTotalPaisa = item.quantityInUnit * pricePaisa;
          subtotalPaisa += lineTotalPaisa;

          const saleItemId = crypto.randomUUID();

          // Calculate average cost paisa per unit for reporting
          const totalCostPaisa = allocations.reduce((sum, a) => sum + (a.costPricePaisa * a.quantitySmallestUnit), 0);
          const costPaisaPerUnit = Math.round(totalCostPaisa / Math.max(1, item.quantityInUnit));

          db.prepare(`
            INSERT INTO sale_items (
              id, sale_id, medicine_id, medicine_name, generic_name, drug_class,
              unit_id, unit_name, conversion_factor, quantity_in_unit, mrp_paisa_per_unit,
              cost_paisa_per_unit, discount_percent, line_total_paisa, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            saleItemId,
            saleId,
            med.id,
            med.brand_name,
            med.generic_name,
            med.drug_class,
            unit ? unit.id : null,
            unitName,
            conversionFactor,
            item.quantityInUnit,
            pricePaisa,
            costPaisaPerUnit,
            0,
            lineTotalPaisa,
            now
          );

          // Insert allocations
          for (const alloc of allocations) {
            const allocId = crypto.randomUUID();
            db.prepare(`
              INSERT INTO sale_item_batch_allocations (
                id, sale_item_id, batch_id, batch_number, expiry_date, quantity_smallest_unit, cost_price_paisa, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              allocId,
              saleItemId,
              alloc.batchId,
              alloc.batchNumber,
              alloc.expiryDate,
              alloc.quantitySmallestUnit,
              alloc.costPricePaisa,
              now
            );

            // Record stock movement
            db.prepare(`
              INSERT INTO stock_movements (
                id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after, reference_id, notes, created_by, created_at
              ) VALUES (?, ?, ?, 'SALE', ?, (SELECT quantity_smallest_unit FROM stock_batches WHERE id = ?), ?, ?, ?, ?)
            `).run(
              crypto.randomUUID(),
              med.id,
              alloc.batchId,
              -alloc.quantitySmallestUnit,
              alloc.batchId,
              saleId,
              `Sale ${invoiceNumber}`,
              user.userId,
              now
            );
          }

          processedItems.push({
            productId: med.id,
            productName: med.brand_name,
            genericName: med.generic_name,
            batchId: allocations[0]?.batchId || '',
            batchNumber: allocations[0]?.batchNumber || '',
            expiryDate: allocations[0]?.expiryDate || '',
            drugClass: med.drug_class,
            unitId: unit?.id,
            unitName,
            conversionFactor,
            quantityInUnit: item.quantityInUnit,
            mrpPaisaPerUnit: pricePaisa,
            costPaisaPerUnit: showCost ? costPaisaPerUnit : null,
            discountPercent: 0,
            lineTotalPaisa,
            batchAllocations: allocations.map((a) => ({
              batchId: a.batchId,
              batchNumber: a.batchNumber,
              expiryDate: a.expiryDate,
              quantitySmallestUnit: a.quantitySmallestUnit,
            })),
          });

          allAllocations.push(...allocations);
        }

        const discountPaisa = Math.max(0, body.discountPaisa || 0);
        const roundingPaisa = body.roundingPaisa || 0;
        if (discountPaisa > subtotalPaisa) throw new Error('Discount cannot exceed the subtotal.');
        const settingsRow = db.prepare('SELECT operational_settings FROM shop_settings WHERE id = 1').get() as {
          operational_settings: string;
        };
        const operationalSettings = JSON.parse(settingsRow.operational_settings || '{}') as Record<string, unknown>;
        const caps = operationalSettings.roleDiscountPercentCap;
        if (
          caps !== undefined
          && (typeof caps !== 'object' || caps === null || Array.isArray(caps))
        ) {
          throw new Error('The saved discount settings are invalid.');
        }
        const totalPaisa = Math.max(0, subtotalPaisa - discountPaisa + roundingPaisa);
        const roleDefaults: Record<string, number> = {
          admin: 30,
          manager: 15,
          seller: 10,
          cashier: 10,
          accountant: 0,
        };
        const capRole = user.role === 'seller' ? 'cashier' : user.role;
        const maxDiscountPaisa = operationalSettings.maxDiscountPaisa ?? 20000;
        const roleDiscountCap = (caps as Record<string, number> | undefined)?.[capRole]
          ?? roleDefaults[user.role]
          ?? 0;
        if (
          typeof maxDiscountPaisa !== 'number'
          || !Number.isSafeInteger(maxDiscountPaisa)
          || maxDiscountPaisa < 0
          || !Number.isFinite(roleDiscountCap)
          || roleDiscountCap < 0
        ) {
          throw new Error('The saved discount settings are invalid.');
        }
        const allowedDiscount = Math.min(maxDiscountPaisa, Math.floor(subtotalPaisa * roleDiscountCap / 100));
        if (discountPaisa > allowedDiscount) {
          const error = new Error('The discount exceeds the permission granted to this account.');
          Object.assign(error, { statusCode: 403 });
          throw error;
        }
        const tenderedPaisa = body.tenderedPaisa || totalPaisa;
        const paymentsTotal = body.payments.reduce((sum, payment) => sum + payment.amountPaisa, 0);
        if (paymentsTotal !== totalPaisa) throw new Error('Payment amounts must equal the sale total.');
        if (tenderedPaisa < totalPaisa) throw new Error('Tendered amount cannot be less than the sale total.');
        const changePaisa = Math.max(0, tenderedPaisa - totalPaisa);

        db.prepare(`
          UPDATE sales SET
            subtotal_paisa = ?,
            discount_paisa = ?,
            rounding_paisa = ?,
            total_paisa = ?,
            tendered_paisa = ?,
            change_paisa = ?
          WHERE id = ?
        `).run(
          subtotalPaisa,
          discountPaisa,
          roundingPaisa,
          totalPaisa,
          tenderedPaisa,
          changePaisa,
          saleId,
        );
        db.prepare(`
          INSERT INTO audit_logs (id, actor_id, actor_name, action, details, created_at)
          VALUES (?, ?, ?, 'SALE_POSTED', ?, ?)
        `).run(
          crypto.randomUUID(),
          user.userId,
          user.username,
          `Sale ${invoiceNumber} completed for ${totalPaisa} paisa.`,
          now,
        );

        // Record payments
        for (const payment of (body.payments || [])) {
          db.prepare(`
            INSERT INTO sale_payments (id, sale_id, payment_method, provider_id, amount_paisa, reference, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            saleId,
            payment.paymentMethod,
            payment.providerId || null,
            payment.amountPaisa,
            payment.reference || null,
            now
          );

          // If payment was cash, log inflow to cash_transactions
          if (payment.paymentMethod === 'CASH') {
            const netCashPaisa = Math.min(payment.amountPaisa, totalPaisa);
            db.prepare(`
              INSERT INTO cash_transactions (id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at)
              VALUES (?, ?, ?, 'SALE', ?, ?, 0, ?, ?)
            `).run(
              crypto.randomUUID(),
              new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              today,
              `POS Bill ${invoiceNumber}`,
              netCashPaisa,
              user.username,
              now
            );
          }

          // If payment was CREDIT and customer exists, record in customer_ledger
          if (payment.paymentMethod === 'CREDIT' && body.customerId) {
            db.prepare(`
              UPDATE customers
              SET current_balance_paisa = current_balance_paisa + ?,
                  updated_at = ?
              WHERE id = ?
            `).run(payment.amountPaisa, now, body.customerId);

            db.prepare(`
              INSERT INTO customer_ledger (id, customer_id, date, type, reference_no, description, debit_paisa, credit_paisa, running_balance_paisa, created_at)
              VALUES (?, ?, ?, 'INVOICE', ?, ?, ?, 0, (SELECT current_balance_paisa FROM customers WHERE id = ?), ?)
            `).run(
              crypto.randomUUID(),
              body.customerId,
              today,
              invoiceNumber,
              `Bill ${invoiceNumber}`,
              payment.amountPaisa,
              body.customerId,
              now
            );
          }
        }

        return {
          id: saleId,
          invoiceNumber,
          shortInvoiceNumber,
          dateTime: new Date(now * 1000).toLocaleString('en-PK'),
          customerId: body.customerId || null,
          items: processedItems,
          subtotalPaisa,
          discountPaisa,
          roundingPaisa,
          totalPaisa,
          tenderedPaisa,
          changePaisa,
          paymentMethod: body.payments?.length > 1 ? 'SPLIT' : primaryPayment,
          paymentDetails: (body.payments || []).map((payment) => ({
            paymentMethod: payment.paymentMethod,
            providerId: payment.providerId,
            amountPaisa: payment.amountPaisa,
            reference: payment.reference,
          })),
          cashierName: user.username,
          customerName: body.customerName || 'Walk-in Customer',
          customerPhone: body.customerPhone || '',
          customerWhatsapp: body.customerWhatsapp || '',
          customerAddress: body.customerAddress || '',
          customerNotes: body.customerNotes || '',
          customerType: body.customerType || 'WALK_IN',
        };
      });

      const completedSale = transaction();
      return reply.status(201).send(completedSale);
    } catch (error: any) {
      return reply.status(error?.statusCode === 403 ? 403 : 400).send({ error: error.message });
    }
  });
}
