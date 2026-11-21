import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { canViewCost } from '../services/costRedactor';
import { localIsoDate, restoreBatchStock } from '../services/fefoEngine';

export function registerReportRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. Sales History
  app.get('/api/reports/sales', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let userRole = 'cashier';
      let userPermissions: string[] = [];
      try {
        await request.jwtVerify();
        const decoded = request.user as { role: string; permissions: string[] };
        userRole = decoded.role;
        userPermissions = decoded.permissions || [];
      } catch {}

      const showCost = canViewCost(userRole, userPermissions);
      const query = request.query as { from?: string; to?: string; limit?: string };
      const limit = Math.max(1, Math.min(1000, parseInt(query.limit || '100', 10)));

      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (query.from && query.to) {
        whereClause += ' AND s.created_at >= ? AND s.created_at < ?';
        params.push(
          Math.floor(new Date(query.from).getTime() / 1000),
          Math.floor(new Date(query.to).getTime() / 1000)
        );
      }

      const sales = db.prepare(`
        SELECT s.* FROM sales s
        ${whereClause}
        ORDER BY s.created_at DESC
        LIMIT ?
      `).all(...params, limit) as any[];

      const saleIds = sales.map((s) => s.id);
      const items = saleIds.length > 0 ? db.prepare(`
        SELECT si.* FROM sale_items si
        WHERE si.sale_id IN (${saleIds.map(() => '?').join(',')})
      `).all(...saleIds) as any[] : [];

      const itemsBySale = new Map<string, any[]>();
      const itemIds = items.map((item) => item.id);
      const allocations = itemIds.length > 0 ? db.prepare(`
        SELECT sale_item_id, batch_id, batch_number, expiry_date, quantity_smallest_unit
        FROM sale_item_batch_allocations
        WHERE sale_item_id IN (${itemIds.map(() => '?').join(',')})
        ORDER BY created_at ASC
      `).all(...itemIds) as any[] : [];
      const allocationsByItem = new Map<string, any[]>();
      for (const allocation of allocations) {
        const bucket = allocationsByItem.get(allocation.sale_item_id) || [];
        bucket.push({
          batchId: allocation.batch_id,
          batchNumber: allocation.batch_number,
          expiryDate: allocation.expiry_date,
          quantityBaseUnits: allocation.quantity_smallest_unit,
        });
        allocationsByItem.set(allocation.sale_item_id, bucket);
      }

      for (const item of items) {
        if (!itemsBySale.has(item.sale_id)) itemsBySale.set(item.sale_id, []);
        itemsBySale.get(item.sale_id)!.push({
          medicineId: item.medicine_id,
          productName: item.medicine_name,
          genericName: item.generic_name,
          drugClass: item.drug_class,
          unitId: item.unit_id,
          unitName: item.unit_name,
          conversionFactor: item.conversion_factor,
          quantityInUnit: item.quantity_in_unit,
          pricePaisaPerUnit: item.mrp_paisa_per_unit,
          lineTotalPaisa: item.line_total_paisa,
          batchAllocations: allocationsByItem.get(item.id) || [],
        });
      }

      const payments = saleIds.length > 0 ? db.prepare(`
        SELECT sale_id, payment_method, provider_id, amount_paisa, reference
        FROM sale_payments
        WHERE sale_id IN (${saleIds.map(() => '?').join(',')})
        ORDER BY created_at ASC
      `).all(...saleIds) as any[] : [];
      const paymentsBySale = new Map<string, any[]>();
      for (const payment of payments) {
        const bucket = paymentsBySale.get(payment.sale_id) || [];
        bucket.push({
          paymentMethod: payment.payment_method,
          providerId: payment.provider_id || undefined,
          amountPaisa: payment.amount_paisa,
          reference: payment.reference || undefined,
        });
        paymentsBySale.set(payment.sale_id, bucket);
      }

      const formattedSales = sales.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoice_number,
        timestamp: new Date(s.created_at * 1000).toISOString(),
        customerId: s.customer_id,
        customerName: s.customer_name,
        customerType: s.customer_type,
        customerPhone: s.customer_phone || '',
        customerWhatsapp: s.customer_whatsapp || '',
        customerAddress: s.customer_address || '',
        customerNotes: s.customer_notes || '',
        subtotalPaisa: s.subtotal_paisa,
        discountPaisa: s.discount_paisa,
        roundingPaisa: s.rounding_paisa,
        totalPaisa: s.total_paisa,
        amountTenderedPaisa: s.tendered_paisa,
        changePaisa: s.change_paisa,
        paymentMethod: s.payment_method,
        paymentDetails: paymentsBySale.get(s.id) || [],
        cashierName: s.cashier_name,
        items: itemsBySale.get(s.id) || [],
      }));

      return reply.send(formattedSales);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. Profit Analytics (Strictly role-protected)
  app.get('/api/reports/profit-summary', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string; permissions: string[] };

      if (!canViewCost(user.role, user.permissions)) {
        return reply.status(403).send({ error: 'Permission denied: Cashiers cannot view cost or profit data.' });
      }

      const query = request.query as { from?: string; to?: string };
      const fromTime = query.from ? Math.floor(new Date(query.from).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400;
      const toTime = query.to ? Math.floor(new Date(query.to).getTime() / 1000) : Math.floor(Date.now() / 1000);

      // Aggregate revenue
      const revRow = db.prepare(`
        SELECT COALESCE(SUM(total_paisa), 0) as total_rev
        FROM sales
        WHERE created_at >= ? AND created_at <= ?
      `).get(fromTime, toTime) as { total_rev: number };

      // Aggregate COGS
      const cogsRow = db.prepare(`
        SELECT COALESCE(SUM(si.cost_paisa_per_unit * si.quantity_in_unit), 0) as total_cogs
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        WHERE s.created_at >= ? AND s.created_at <= ?
      `).get(fromTime, toTime) as { total_cogs: number };

      // Subtract returns
      const returnRow = db.prepare(`
        SELECT COALESCE(SUM(total_refund_paisa), 0) as total_returns
        FROM sale_returns
        WHERE created_at >= ? AND created_at <= ?
      `).get(fromTime, toTime) as { total_returns: number };

      const netRevenuePaisa = Math.max(0, revRow.total_rev - returnRow.total_returns);
      const grossProfitPaisa = Math.max(0, netRevenuePaisa - cogsRow.total_cogs);
      const marginPercent = netRevenuePaisa > 0 ? (grossProfitPaisa / netRevenuePaisa) * 100 : 0;

      return reply.send({
        netRevenuePaisa,
        cogsPaisa: cogsRow.total_cogs,
        grossProfitPaisa,
        grossMarginPercent: Math.round(marginPercent * 10) / 10,
        returnRefundsPaisa: returnRow.total_returns,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 3. Process Sale Return
  app.post('/api/reports/returns', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { userId: string; username: string; role: string };

      if (user.role !== 'admin' && user.role !== 'manager') {
        return reply.status(403).send({ error: 'Permission denied: Only managers or admins can approve returns.' });
      }

      const body = request.body as {
        saleId: string;
        reason: string;
        disposition: 'RESTOCK' | 'QUARANTINE' | 'WRITE_OFF';
        items: Array<{
          saleItemId: string;
          quantityInUnit: number;
        }>;
      };

      if (!body.saleId || !body.items || body.items.length === 0) {
        return reply.status(400).send({ error: 'Sale ID and at least one item required.' });
      }

      const today = localIsoDate();
      const now = Math.floor(Date.now() / 1000);

      const transaction = db.transaction(() => {
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(body.saleId) as any;
        if (!sale) throw new Error('Sale not found.');

        const returnId = crypto.randomUUID();
        const countRow = db.prepare('SELECT COUNT(*) as cnt FROM sale_returns').get() as { cnt: number };
        const returnNumber = `RET-${(countRow.cnt + 1).toString().padStart(4, '0')}`;

        let totalRefundPaisa = 0;

        for (const returnItem of body.items) {
          const item = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(returnItem.saleItemId) as any;
          if (!item) throw new Error(`Sale item ${returnItem.saleItemId} not found.`);

          const unitRefund = returnItem.quantityInUnit * item.mrp_paisa_per_unit;
          totalRefundPaisa += unitRefund;

          // Find allocations for this item to restore batches
          const allocations = db.prepare(`
            SELECT batch_id, quantity_smallest_unit
            FROM sale_item_batch_allocations
            WHERE sale_item_id = ?
          `).all(item.id) as Array<{ batch_id: string; quantity_smallest_unit: number }>;

          const smallestUnitsToRestore = returnItem.quantityInUnit * item.conversion_factor;
          let remainingToRestore = smallestUnitsToRestore;

          for (const alloc of allocations) {
            const take = Math.min(remainingToRestore, alloc.quantity_smallest_unit);
            if (take <= 0) continue;

            db.prepare(`
              INSERT INTO sale_return_items (
                id, return_id, sale_item_id, batch_id, quantity_smallest_unit, refund_paisa, disposition, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              crypto.randomUUID(),
              returnId,
              item.id,
              alloc.batch_id,
              take,
              Math.round((take / smallestUnitsToRestore) * unitRefund),
              body.disposition || 'RESTOCK',
              now
            );

            // Restore batch inventory if RESTOCK
            if (body.disposition === 'RESTOCK') {
              restoreBatchStock(db, [{ batchId: alloc.batch_id, quantitySmallestUnit: take }], 'RESTOCK');

              db.prepare(`
                INSERT INTO stock_movements (
                  id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after, reference_id, notes, created_by, created_at
                ) VALUES (?, ?, ?, 'RETURN_RESTOCK', ?, (SELECT quantity_smallest_unit FROM stock_batches WHERE id = ?), ?, ?, ?, ?)
              `).run(
                crypto.randomUUID(),
                item.medicine_id,
                alloc.batch_id,
                take,
                alloc.batch_id,
                returnId,
                `Return ${returnNumber}`,
                user.userId,
                now
              );
            }

            remainingToRestore -= take;
            if (remainingToRestore <= 0) break;
          }
        }

        // Insert return record
        db.prepare(`
          INSERT INTO sale_returns (
            id, return_number, sale_id, invoice_number, customer_id, reason, total_refund_paisa, payment_method, approved_by, created_by, auto_processed, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CASH', ?, ?, 0, ?)
        `).run(
          returnId,
          returnNumber,
          sale.id,
          sale.invoice_number,
          sale.customer_id,
          body.reason.trim(),
          totalRefundPaisa,
          user.userId,
          user.userId,
          now
        );

        // Record cash outflow for refund
        db.prepare(`
          INSERT INTO cash_transactions (
            id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at
          ) VALUES (?, ?, ?, 'RETURN_REFUND', ?, ?, 1, ?, ?)
        `).run(
          crypto.randomUUID(),
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          today,
          `Return refund for ${sale.invoice_number}`,
          totalRefundPaisa,
          user.username,
          now
        );

        return { returnId, returnNumber, totalRefundPaisa };
      });

      const result = transaction();
      return reply.status(201).send({ success: true, ...result });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
