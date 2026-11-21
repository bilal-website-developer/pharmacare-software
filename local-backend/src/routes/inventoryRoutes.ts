import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { canViewCost } from '../services/costRedactor';
import { localIsoDate } from '../services/fefoEngine';

function createUniqueBarcode(db: Database.Database): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const barcode = crypto.randomBytes(6).toString('hex').toUpperCase();
    const exists = db.prepare('SELECT 1 FROM medicines WHERE barcode = ?').get(barcode);
    if (!exists) return barcode;
  }
  throw new Error('Could not generate a unique barcode.');
}

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
        drugClass?: string;
        status?: string;
        lowStockOnly?: string;
        sortColumn?: string;
        sortDirection?: string;
      };

      const requestedPage = Number.parseInt(query.page || '1', 10);
      const requestedLimit = Number.parseInt(query.limit || '50', 10);
      const page = Number.isSafeInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
      const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 50;
      const offset = (page - 1) * limit;

      let whereClause = 'WHERE m.deleted_at IS NULL';
      const params: any[] = [];
      const activeStock = `
        SELECT SUM(sb.quantity_smallest_unit)
        FROM stock_batches sb
        WHERE sb.medicine_id = m.id AND sb.quantity_smallest_unit > 0
          AND sb.status IN ('ACTIVE', 'NEAR_EXPIRY')
      `;

      if (query.search) {
        whereClause += ' AND (m.brand_name LIKE ? OR m.generic_name LIKE ? OR m.code LIKE ? OR m.barcode LIKE ?)';
        const term = `%${query.search.trim()}%`;
        params.push(term, term, term, term);
      }
      if (query.category) {
        whereClause += ' AND c.name = ?';
        params.push(query.category);
      }
      if (query.brand) {
        whereClause += ' AND b.name = ?';
        params.push(query.brand);
      }
      if (query.drugClass) {
        whereClause += ' AND m.drug_class = ?';
        params.push(query.drugClass);
      }
      if (query.status === 'active' || query.status === 'inactive') {
        whereClause += ' AND m.is_active = ?';
        params.push(query.status === 'active' ? 1 : 0);
      }
      if (query.lowStockOnly === 'true') {
        whereClause += ` AND COALESCE((${activeStock}), 0) <= m.min_stock_alert`;
      }

      const countRow = db.prepare(`
        SELECT COUNT(*) as total FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN brands b ON m.brand_id = b.id
        ${whereClause}
      `).get(...params) as { total: number };

      const sortColumns: Record<string, string> = {
        name: 'm.brand_name',
        stock: 'current_stock_smallest_unit',
        expiry: 'nearest_expiry',
        mrp: 'mrp_paisa',
      };
      const sortColumn = sortColumns[query.sortColumn ?? 'name'] ?? sortColumns.name;
      const sortDirection = query.sortDirection === 'desc' ? 'DESC' : 'ASC';
      const rows = db.prepare(`
        SELECT m.id, m.code, m.barcode, m.brand_name, m.generic_name, m.strength,
               m.category_id, c.name as category_name,
               m.brand_id, b.name as brand_name_company,
               m.drug_class, m.storage_condition, m.rack_location,
               m.min_stock_alert, m.requires_prescription, m.is_active,
               COALESCE((${activeStock}), 0) AS current_stock_smallest_unit,
               (SELECT MIN(sb.expiry_date) FROM stock_batches sb
                WHERE sb.medicine_id = m.id AND sb.quantity_smallest_unit > 0
                  AND sb.status IN ('ACTIVE', 'NEAR_EXPIRY')) AS nearest_expiry,
               COALESCE((SELECT u.price_per_unit_paisa FROM medicine_units u
                         WHERE u.medicine_id = m.id AND u.is_active = 1
                         ORDER BY u.is_default_sale_unit DESC, u.id LIMIT 1), 0) AS mrp_paisa,
               COALESCE((SELECT u.conversion_factor FROM medicine_units u
                         WHERE u.medicine_id = m.id AND u.is_active = 1
                         ORDER BY u.is_default_sale_unit DESC, u.id LIMIT 1), 1) AS default_unit_conversion,
               (SELECT sb.cost_price_paisa FROM stock_batches sb
                WHERE sb.medicine_id = m.id AND sb.quantity_smallest_unit > 0
                ORDER BY sb.received_date DESC, sb.created_at DESC LIMIT 1) AS latest_cost_paisa
        FROM medicines m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN brands b ON m.brand_id = b.id
        ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection}, m.id
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      // Get units for these products
      const medIds = rows.map((r) => r.id);
      const units = medIds.length > 0 ? db.prepare(`
        SELECT id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa, barcode
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
          barcode: u.barcode || null,
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
        nearestExpiry: r.nearest_expiry,
        mrpPaisa: r.mrp_paisa,
        defaultUnitConversion: r.default_unit_conversion,
        latestCostPaisa: showCost ? r.latest_cost_paisa : null,
        marginPercent: showCost && r.latest_cost_paisa && r.mrp_paisa
          ? ((r.mrp_paisa - r.latest_cost_paisa * r.default_unit_conversion) / r.mrp_paisa) * 100
          : null,
        units: unitsByMed.get(r.id) || [],
      }));

      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN m.is_active = 1 THEN 1 ELSE 0 END) AS total_active,
          SUM(CASE WHEN COALESCE(stock.quantity, 0) > 0 AND COALESCE(stock.quantity, 0) <= m.min_stock_alert THEN 1 ELSE 0 END) AS low_stock,
          SUM(CASE WHEN COALESCE(stock.quantity, 0) = 0 THEN 1 ELSE 0 END) AS out_of_stock,
          SUM(CASE WHEN stock.expiring > 0 THEN 1 ELSE 0 END) AS expiring_90,
          ${showCost ? 'SUM(COALESCE(stock.stock_value, 0))' : 'NULL'} AS stock_value_cost_paisa
        FROM medicines m
        LEFT JOIN (
          SELECT medicine_id,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY') THEN quantity_smallest_unit ELSE 0 END) AS quantity,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY')
                           AND expiry_date >= date('now') AND expiry_date < date('now', '+91 days')
                           AND quantity_smallest_unit > 0 THEN 1 ELSE 0 END) AS expiring,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY')
                           THEN quantity_smallest_unit * cost_price_paisa ELSE 0 END) AS stock_value
          FROM stock_batches GROUP BY medicine_id
        ) stock ON stock.medicine_id = m.id
        WHERE m.deleted_at IS NULL
      `).get() as any;
      return reply.send({
        products,
        total: countRow.total,
        page,
        limit,
        canViewCost: showCost,
        stats: {
          totalActive: Number(stats.total_active || 0),
          lowStock: Number(stats.low_stock || 0),
          outOfStock: Number(stats.out_of_stock || 0),
          expiring90: Number(stats.expiring_90 || 0),
          stockValueCostPaisa: stats.stock_value_cost_paisa === null ? null : Number(stats.stock_value_cost_paisa || 0),
        },
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
            SET code = ?, barcode = ?, brand_name = ?, generic_name = ?, strength = ?, category_id = ?, brand_id = ?,
                drug_class = ?, storage_condition = ?, rack_location = ?, min_stock_alert = ?,
                requires_prescription = ?, updated_at = ?
            WHERE id = ?
          `).run(
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
            medicineId
          );
        }

        // Units update
        if (Array.isArray(body.units) && body.units.length > 0) {
          const unitIds = body.units
            .filter((unit: any) => typeof unit.id === 'string')
            .map((unit: any) => unit.id as string);
          if (unitIds.length > 0) {
            db.prepare(`
              DELETE FROM medicine_units
              WHERE medicine_id = ? AND id NOT IN (${unitIds.map(() => '?').join(',')})
            `).run(medicineId, ...unitIds);
          } else {
            db.prepare('DELETE FROM medicine_units WHERE medicine_id = ?').run(medicineId);
          }
          for (const u of body.units) {
            const values = [
              u.name,
              Math.max(1, u.conversionFactor || 1),
              u.isDefaultSaleUnit ? 1 : 0,
              u.pricePerUnitPaisa || 0,
              u.barcode || null,
              now,
            ];
            if (typeof u.id === 'string') {
              const updated = db.prepare(`
                UPDATE medicine_units
                SET name = ?, conversion_factor = ?, is_default_sale_unit = ?,
                    price_per_unit_paisa = ?, barcode = ?, updated_at = ?
                WHERE id = ? AND medicine_id = ?
              `).run(...values, u.id, medicineId);
              if (updated.changes === 0) throw new Error('A product unit could not be updated.');
            } else {
              db.prepare(`
                INSERT INTO medicine_units (
                  id, medicine_id, name, conversion_factor, is_default_sale_unit,
                  price_per_unit_paisa, barcode, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
              `).run(
                crypto.randomUUID(),
                medicineId,
                ...values.slice(0, 5),
                now,
                now,
              );
            }
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

      app.post('/api/inventory/products/import-preview', async (request, reply) => {
        const body = request.body as { rows?: unknown };
        if (!Array.isArray(body?.rows) || body.rows.length > 2000) {
          return reply.status(400).send({ error: 'Import preview must contain no more than 2000 rows.' });
        }
        const rows = body.rows as Array<Record<string, unknown>>;
        const duplicateCodes = new Set<string>();
        const duplicateBarcodes = new Set<string>();
        return reply.send(rows.map((raw) => {
          if (!raw || typeof raw !== 'object' || typeof raw.line !== 'number') {
            return { line: -1, duplicate_in_database: true };
          }
          const code = typeof raw.code === 'string' ? raw.code.trim() : '';
          const barcode = typeof raw.barcode === 'string' ? raw.barcode.trim() : '';
          const duplicate = !code
            || duplicateCodes.has(code.toLowerCase())
            || (barcode !== '' && duplicateBarcodes.has(barcode.toLowerCase()))
            || Boolean(db.prepare('SELECT 1 FROM medicines WHERE code = ? OR (? <> \'\' AND barcode = ?)').get(
              code, barcode, barcode,
            ));
          if (code) duplicateCodes.add(code.toLowerCase());
          if (barcode) duplicateBarcodes.add(barcode.toLowerCase());
          return { line: raw.line, duplicate_in_database: duplicate };
        }));
      });

      app.post('/api/inventory/products/import', async (request, reply) => {
        try {
          await request.jwtVerify();
          const body = request.body as { rows?: unknown };
          if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 2000) {
            return reply.status(400).send({ error: 'Import must contain between 1 and 2000 product rows.' });
          }
          const now = Math.floor(Date.now() / 1000);
          const boolValue = (value: unknown, fallback: boolean) => {
            if (value === undefined || value === null || value === '') return fallback;
            const normalized = String(value).trim().toLowerCase();
            if (['true', 't', 'yes', 'y', '1'].includes(normalized)) return true;
            if (['false', 'f', 'no', 'n', '0'].includes(normalized)) return false;
            throw new Error('An import row contains an invalid boolean value.');
          };
          const transaction = db.transaction(() => {
            for (const raw of body.rows as Array<Record<string, unknown>>) {
              if (!raw || typeof raw !== 'object') throw new Error('Every import row must be an object.');
              const value = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
              const code = value('code');
              const name = value('brand_name');
              const genericName = value('generic_name');
              const categoryName = value('category');
              const companyName = value('company');
              const unitName = value('unit_name');
              const conversionFactor = Number(value('conversion_factor'));
              const pricePaisa = Number(value('price_paisa'));
              const minStock = Number(value('min_stock_alert') || 0);
              if (!code || !name || !genericName || !categoryName || !companyName || !unitName) {
                throw new Error('Every import row requires code, product name, generic name, category, manufacturer, and unit.');
              }
              if (!Number.isSafeInteger(conversionFactor) || conversionFactor < 1
                || !Number.isSafeInteger(pricePaisa) || pricePaisa < 0
                || !Number.isSafeInteger(minStock) || minStock < 0) {
                throw new Error(`Import row ${String(raw.line ?? '')} contains an invalid unit, price, or stock level.`);
              }
              const drugClass = value('drug_class') || 'OTC';
              const storageCondition = value('storage_condition') || 'ROOM_TEMPERATURE';
              if (!['OTC', 'RX', 'CONTROLLED', 'NARCOTIC'].includes(drugClass)
                || !['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED'].includes(storageCondition)) {
                throw new Error(`Import row ${String(raw.line ?? '')} contains an unsupported classification or storage condition.`);
              }
              const barcode = value('barcode') || null;
              if (db.prepare('SELECT 1 FROM medicines WHERE code = ? OR (? IS NOT NULL AND barcode = ?)').get(code, barcode, barcode)) {
                throw new Error(`Import row ${String(raw.line ?? '')} duplicates an existing product code or barcode.`);
              }
              let category = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(categoryName) as { id: string } | undefined;
              if (!category) {
                const id = crypto.randomUUID();
                db.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
                  .run(id, categoryName, now, now);
                category = { id };
              }
              let brand = db.prepare('SELECT id FROM brands WHERE name = ? COLLATE NOCASE').get(companyName) as { id: string } | undefined;
              if (!brand) {
                const id = crypto.randomUUID();
                db.prepare('INSERT INTO brands (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
                  .run(id, companyName, now, now);
                brand = { id };
              }
              const medicineId = crypto.randomUUID();
              db.prepare(`
                INSERT INTO medicines (
                  id, code, barcode, brand_name, generic_name, strength, category_id, brand_id,
                  drug_class, storage_condition, rack_location, min_stock_alert, requires_prescription,
                  is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                medicineId,
                code,
                barcode,
                name,
                genericName,
                value('strength') || null,
                category.id,
                brand.id,
                drugClass,
                storageCondition,
                value('rack_location') || null,
                minStock,
                boolValue(raw.requires_prescription, false) ? 1 : 0,
                boolValue(raw.is_active, true) ? 1 : 0,
                now,
                now,
              );
              db.prepare(`
                INSERT INTO medicine_units (
                  id, medicine_id, name, conversion_factor, is_default_sale_unit,
                  price_per_unit_paisa, barcode, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?)
              `).run(
                crypto.randomUUID(),
                medicineId,
                unitName,
                conversionFactor,
                pricePaisa,
                value('unit_barcode') || null,
                now,
                now,
              );
            }
          });
          transaction();
          return reply.send({ importedCount: body.rows.length });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not import products.' });
        }
      });

      app.post('/api/inventory/products/bulk-update', async (request, reply) => {
        try {
          await request.jwtVerify();
          const user = request.user as { userId: string; username: string };
          const body = request.body as { ids?: unknown; action?: unknown; value?: unknown };
          if (!Array.isArray(body.ids) || body.ids.length === 0
            || body.ids.some((id) => typeof id !== 'string')
            || (body.action !== 'category' && body.action !== 'deactivate' && body.action !== 'activate')) {
            return reply.status(400).send({ error: 'Choose products and a valid bulk action.' });
          }
          const ids = [...new Set(body.ids as string[])];
          const now = Math.floor(Date.now() / 1000);
          const transaction = db.transaction(() => {
            if (body.action === 'deactivate' || body.action === 'activate') {
              if (body.action === 'deactivate') {
                const products = db.prepare(`
                  SELECT id, brand_name FROM medicines
                  WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active = 1 AND deleted_at IS NULL
                `).all(...ids) as Array<{ id: string; brand_name: string }>;
                for (const product of products) {
                  db.prepare(`
                    INSERT INTO trash_bin_events (
                      id, entity_type, entity_id, entity_name, action, reason,
                      performed_by, performed_by_name, created_at
                    ) VALUES (?, 'product', ?, ?, 'deactivate', 'Product deactivated.', ?, ?, ?)
                  `).run(crypto.randomUUID(), product.id, product.brand_name, user.userId, user.username, now);
                }
              }
              return db.prepare(`
                UPDATE medicines SET is_active = ?, updated_at = ?
                WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL
              `).run(body.action === 'activate' ? 1 : 0, now, ...ids).changes;
            }
            if (typeof body.value !== 'string' || !body.value.trim()) {
              throw new Error('Choose a category before applying the bulk action.');
            }
            const category = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(body.value.trim()) as { id: string } | undefined;
            if (!category) throw new Error('The selected category was not found.');
            return db.prepare(`
              UPDATE medicines SET category_id = ?, updated_at = ?
              WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL
            `).run(category.id, now, ...ids).changes;
          });
          return reply.send(transaction());
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not update products.' });
        }
      });

      app.post('/api/inventory/products/:id/barcode', async (request, reply) => {
        try {
          await request.jwtVerify();
          const { id } = request.params as { id: string };
          const product = db.prepare('SELECT id, barcode FROM medicines WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; barcode: string | null } | undefined;
          if (!product) return reply.status(404).send({ error: 'Product not found.' });
          if (product.barcode) return reply.status(409).send({ error: 'This product already has a barcode.' });
          const barcode = createUniqueBarcode(db);
          db.prepare('UPDATE medicines SET barcode = ?, updated_at = ? WHERE id = ?')
            .run(barcode, Math.floor(Date.now() / 1000), id);
          return reply.send({ barcode });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not generate a barcode.' });
        }
      });

      app.post('/api/inventory/products/barcodes', async (request, reply) => {
        try {
          await request.jwtVerify();
          const body = request.body as { ids?: unknown };
          if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
            return reply.status(400).send({ error: 'A list of product IDs is required.' });
          }
          const ids = [...new Set(body.ids as string[])];
          let assigned = 0;
          let skipped = 0;
          const transaction = db.transaction(() => {
            for (const id of ids) {
              const product = db.prepare('SELECT barcode FROM medicines WHERE id = ? AND deleted_at IS NULL').get(id) as { barcode: string | null } | undefined;
              if (!product || product.barcode) {
                skipped += 1;
                continue;
              }
              db.prepare('UPDATE medicines SET barcode = ?, updated_at = ? WHERE id = ?')
                .run(createUniqueBarcode(db), Math.floor(Date.now() / 1000), id);
              assigned += 1;
            }
          });
          transaction();
          return reply.send({ assigned, skipped, failed: 0 });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not generate product barcodes.' });
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
      return reply.send({
        success: true,
        message: 'Stock adjusted successfully.',
        adjustedQuantitySmallestUnit: body.adjustedQuantitySmallestUnit,
      });
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
