import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { canViewCost } from '../services/costRedactor';
import { localIsoDate } from '../services/fefoEngine';

export function registerInventoryRoutes(app: FastifyInstance, db: Database.Database): void {
  // Products list with paging, search, category/brand filters
  app.get('/api/inventory/products', async (request: FastifyRequest, reply: FastifyReply) => {
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
      const query = request.query as {
        page?: string;
        limit?: string;
        search?: string;
        category?: string;
        brand?: string;
      };

      const page = Math.max(1, parseInt(query.page || '1', 10));
      const limit = Math.max(1, Math.min(500, parseInt(query.limit || '50', 10)));
      const offset = (page - 1) * limit;

      let whereClause = 'WHERE m.deleted_at IS NULL';
      const params: any[] = [];

      if (query.search) {
        whereClause += ' AND (m.brand_name LIKE ? OR m.generic_name LIKE ? OR m.code LIKE ? OR m.barcode LIKE ?)';
        const term = `%${query.search.trim()}%`;
        params.push(term, term, term, term);
      }
      if (query.category) {
        whereClause += ' AND m.category_id = ?';
        params.push(query.category);
      }
      if (query.brand) {
        whereClause += ' AND m.brand_id = ?';
        params.push(query.brand);
      }

      const countRow = db.prepare(`
        SELECT COUNT(*) as total FROM medicines m ${whereClause}
      `).get(...params) as { total: number };

      const rows = db.prepare(`
        SELECT m.id, m.code, m.barcode, m.brand_name, m.generic_name, m.strength,
               m.category_id, c.name as category_name,
               m.brand_id, b.name as brand_name_company,
               m.drug_class, m.storage_condition, m.rack_location,
               m.min_stock_alert, m.requires_prescription, m.is_active,
               COALESCE((
                 SELECT SUM(sb.quantity_smallest_unit)
                 FROM stock_batches sb
                 WHERE sb.medicine_id = m.id AND sb.quantity_smallest_unit > 0
               ), 0) as current_stock_smallest_unit
        FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN brands b ON m.brand_id = b.id
        ${whereClause}
        ORDER BY m.brand_name ASC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      // Get units for these products
      const medIds = rows.map((r) => r.id);
      const units = medIds.length > 0 ? db.prepare(`
        SELECT id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa
        FROM medicine_units
        WHERE medicine_id IN (${medIds.map(() => '?').join(',')}) AND is_active = 1
      `).all(...medIds) as any[] : [];

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

      const products = rows.map((r) => ({
        id: r.id,
        code: r.code,
        barcode: r.barcode || '',
        brandName: r.brand_name,
        genericName: r.generic_name,
        strength: r.strength || '',
        category: r.category_name || '',
        categoryId: r.category_id,
        company: r.brand_name_company || '',
        brandId: r.brand_id,
        drugClass: r.drug_class,
        storageCondition: r.storage_condition,
        rackLocation: r.rack_location || '',
        minStockAlert: r.min_stock_alert,
        requiresPrescription: r.requires_prescription === 1,
        isActive: r.is_active === 1,
        currentStockSmallestUnit: r.current_stock_smallest_unit,
        units: unitsByMed.get(r.id) || [],
      }));

      return reply.send({
        products,
        total: countRow.total,
        page,
        limit,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Save / Update Medicine
  app.post('/api/inventory/products', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const body = request.body as any;
      if (!body.brandName || !body.genericName) {
        return reply.status(400).send({ error: 'Brand name and generic name are required.' });
      }

      const now = Math.floor(Date.now() / 1000);
      const isNew = !body.id;
      const medicineId = body.id || crypto.randomUUID();
      const code = body.code || `MED-${Date.now().toString(36).toUpperCase()}`;

      const transaction = db.transaction(() => {
        if (isNew) {
          db.prepare(`
            INSERT INTO medicines (
              id, code, barcode, brand_name, generic_name, strength, category_id, brand_id,
              drug_class, storage_condition, rack_location, min_stock_alert, requires_prescription,
              is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            medicineId,
            code,
            body.barcode || null,
            body.brandName.trim(),
            body.genericName.trim(),
            body.strength || null,
            body.categoryId || null,
            body.brandId || null,
            body.drugClass || 'OTC',
            body.storageCondition || 'ROOM_TEMPERATURE',
            body.rackLocation || null,
            body.minStockAlert || 0,
            body.requiresPrescription ? 1 : 0,
            now,
            now
          );
        } else {
          db.prepare(`
            UPDATE medicines
            SET barcode = ?, brand_name = ?, generic_name = ?, strength = ?, category_id = ?, brand_id = ?,
                drug_class = ?, storage_condition = ?, rack_location = ?, min_stock_alert = ?,
                requires_prescription = ?, updated_at = ?
            WHERE id = ?
          `).run(
            body.barcode || null,
            body.brandName.trim(),
            body.genericName.trim(),
            body.strength || null,
            body.categoryId || null,
            body.brandId || null,
            body.drugClass || 'OTC',
            body.storageCondition || 'ROOM_TEMPERATURE',
            body.rackLocation || null,
            body.minStockAlert || 0,
            body.requiresPrescription ? 1 : 0,
            now,
            medicineId
          );
        }

        // Units update
        if (Array.isArray(body.units) && body.units.length > 0) {
          db.prepare('DELETE FROM medicine_units WHERE medicine_id = ?').run(medicineId);
          for (const u of body.units) {
            db.prepare(`
              INSERT INTO medicine_units (
                id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa, is_active, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            `).run(
              u.id || crypto.randomUUID(),
              medicineId,
              u.name,
              Math.max(1, u.conversionFactor || 1),
              u.isDefaultSaleUnit ? 1 : 0,
              u.pricePerUnitPaisa || 0,
              now,
              now
            );
          }
        }

        return medicineId;
      });

      const savedId = transaction();
      return reply.status(201).send({ id: savedId, success: true });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Stock Batches list
  app.get('/api/inventory/batches', async (request: FastifyRequest, reply: FastifyReply) => {
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
      const query = request.query as { medicineId?: string; status?: string };

      let whereClause = 'WHERE sb.quantity_smallest_unit > 0';
      const params: any[] = [];

      if (query.medicineId) {
        whereClause += ' AND sb.medicine_id = ?';
        params.push(query.medicineId);
      }
      if (query.status) {
        whereClause += ' AND sb.status = ?';
        params.push(query.status);
      }

      const rows = db.prepare(`
        SELECT sb.id, sb.medicine_id, m.brand_name, m.generic_name, sb.batch_number,
               sb.expiry_date, sb.received_date, sb.cost_price_paisa, sb.mrp_paisa,
               sb.quantity_smallest_unit, sb.status, sb.supplier_name
        FROM stock_batches sb
        JOIN medicines m ON sb.medicine_id = m.id
        ${whereClause}
        ORDER BY sb.expiry_date ASC
      `).all(...params) as any[];

      const batches = rows.map((r) => ({
        id: r.id,
        productId: r.medicine_id,
        productName: r.brand_name,
        genericName: r.generic_name,
        batchNumber: r.batch_number,
        expiryDate: r.expiry_date,
        receivedDate: r.received_date,
        costPricePaisa: showCost ? r.cost_price_paisa : null,
        mrpPaisa: r.mrp_paisa,
        quantitySmallestUnit: r.quantity_smallest_unit,
        status: r.status,
        supplierName: r.supplier_name || '',
      }));

      return reply.send(batches);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Adjust stock batch
  app.post('/api/inventory/adjust', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { userId: string; role: string };
      if (user.role !== 'admin' && user.role !== 'manager') {
        return reply.status(403).send({ error: 'Permission denied for stock adjustment.' });
      }

      const body = request.body as {
        batchId: string;
        adjustedQuantitySmallestUnit: number;
        reason?: string;
      };

      if (!body.batchId || !Number.isSafeInteger(body.adjustedQuantitySmallestUnit) || body.adjustedQuantitySmallestUnit < 0) {
        return reply.status(400).send({ error: 'Valid batchId and non-negative quantity required.' });
      }

      const now = Math.floor(Date.now() / 1000);

      const transaction = db.transaction(() => {
        const batch = db.prepare('SELECT medicine_id, quantity_smallest_unit FROM stock_batches WHERE id = ?').get(body.batchId) as any;
        if (!batch) throw new Error('Batch not found.');

        const diff = body.adjustedQuantitySmallestUnit - batch.quantity_smallest_unit;

        db.prepare(`
          UPDATE stock_batches
          SET quantity_smallest_unit = ?, updated_at = ?
          WHERE id = ?
        `).run(body.adjustedQuantitySmallestUnit, now, body.batchId);

        db.prepare(`
          INSERT INTO stock_movements (
            id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after, reference_id, notes, created_by, created_at
          ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          batch.medicine_id,
          body.batchId,
          diff,
          body.adjustedQuantitySmallestUnit,
          null,
          body.reason || 'Manual stock adjustment',
          user.userId,
          now
        );
      });

      transaction();
      return reply.send({ success: true, message: 'Stock adjusted successfully.' });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Write off expired batch
  app.post('/api/inventory/write-off', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { userId: string; role: string };
      if (user.role !== 'admin' && user.role !== 'manager') {
        return reply.status(403).send({ error: 'Permission denied for stock write-off.' });
      }

      const body = request.body as { batchId: string; reason?: string };
      const now = Math.floor(Date.now() / 1000);

      const transaction = db.transaction(() => {
        const batch = db.prepare('SELECT medicine_id, quantity_smallest_unit FROM stock_batches WHERE id = ?').get(body.batchId) as any;
        if (!batch) throw new Error('Batch not found.');

        const qty = batch.quantity_smallest_unit;

        db.prepare(`
          UPDATE stock_batches
          SET quantity_smallest_unit = 0, status = 'EXPIRED', updated_at = ?
          WHERE id = ?
        `).run(now, body.batchId);

        db.prepare(`
          INSERT INTO stock_movements (
            id, medicine_id, batch_id, movement_type, quantity_smallest_units, balance_after, reference_id, notes, created_by, created_at
          ) VALUES (?, ?, ?, 'WRITE_OFF', ?, 0, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          batch.medicine_id,
          body.batchId,
          -qty,
          null,
          body.reason || 'Expired batch write-off',
          user.userId,
          now
        );
      });

      transaction();
      return reply.send({ success: true, message: 'Batch written off successfully.' });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
