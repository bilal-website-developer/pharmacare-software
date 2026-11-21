import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { canViewCost } from '../services/costRedactor';

type MasterKind = 'category' | 'brand';

interface LocalUser {
  userId: string;
  role: string;
  permissions: string[];
}

function isMasterKind(value: unknown): value is MasterKind {
  return value === 'category' || value === 'brand';
}

function masterTable(kind: MasterKind): 'categories' | 'brands' {
  return kind === 'category' ? 'categories' : 'brands';
}

function requireMasterPermission(request: FastifyRequest, reply: FastifyReply): LocalUser | null {
  const user = request.user as LocalUser;
  if (user.role !== 'admin' && !user.permissions.includes('categories')) {
    void reply.status(403).send({ error: 'Categories permission is required.' });
    return null;
  }
  return user;
}

export function registerMasterDataRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/master-data/overview', async (request, reply) => {
    try {
      const user = request.user as LocalUser;
      const showCost = canViewCost(user.role, user.permissions);
      const query = (table: 'categories' | 'brands') => db.prepare(`
        SELECT d.id, d.name, d.is_active,
               COUNT(DISTINCT m.id) AS product_count,
               SUM(CASE WHEN COALESCE(stock.quantity, 0) = 0 THEN 1 ELSE 0 END) AS out_count,
               SUM(CASE WHEN COALESCE(stock.quantity, 0) > 0
                         AND COALESCE(stock.quantity, 0) <= m.min_stock_alert THEN 1 ELSE 0 END) AS low_count,
               SUM(CASE WHEN COALESCE(stock.expiring, 0) > 0 THEN 1 ELSE 0 END) AS expiring_count,
               ${showCost ? 'SUM(COALESCE(stock.stock_value_paisa, 0))' : 'NULL'} AS stock_value_paisa
        FROM ${table} d
        LEFT JOIN medicines m ON ${table === 'categories' ? 'm.category_id' : 'm.brand_id'} = d.id
          AND m.deleted_at IS NULL
        LEFT JOIN (
          SELECT medicine_id,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY') THEN quantity_smallest_unit ELSE 0 END) AS quantity,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY')
                           AND expiry_date >= date('now')
                           AND expiry_date < date('now', '+91 days')
                           AND quantity_smallest_unit > 0 THEN 1 ELSE 0 END) AS expiring,
                 SUM(CASE WHEN status IN ('ACTIVE', 'NEAR_EXPIRY')
                           THEN quantity_smallest_unit * cost_price_paisa ELSE 0 END) AS stock_value_paisa
          FROM stock_batches
          GROUP BY medicine_id
        ) stock ON stock.medicine_id = m.id
        GROUP BY d.id
        ORDER BY d.name COLLATE NOCASE
      `).all() as Array<Record<string, unknown>>;
      const categories = query('categories');
      const manufacturers = query('brands');
      const productCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM medicines WHERE deleted_at IS NULL
      `).get() as { count: number }).count;
      const unitCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM medicine_units u
        JOIN medicines m ON m.id = u.medicine_id
        WHERE u.is_active = 1 AND m.deleted_at IS NULL
      `).get() as { count: number }).count;
      const mapValue = (row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        is_active: row.is_active === 1,
        product_count: Number(row.product_count ?? 0),
        low_count: Number(row.low_count ?? 0),
        out_count: Number(row.out_count ?? 0),
        expiring_count: Number(row.expiring_count ?? 0),
        stock_value_paisa: row.stock_value_paisa === null ? null : Number(row.stock_value_paisa ?? 0),
      });
      return reply.send({
        categories: categories.map(mapValue),
        manufacturers: manufacturers.map(mapValue),
        summary: {
          category_count: categories.length,
          active_category_count: categories.filter((row) => row.is_active === 1).length,
          manufacturer_count: manufacturers.length,
          active_manufacturer_count: manufacturers.filter((row) => row.is_active === 1).length,
          product_count: productCount,
          unit_count: unitCount,
        },
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load master data.' });
    }
  });

  app.get('/api/master-data/units', async (_request, reply) => {
    try {
      const units = db.prepare(`
        SELECT u.id, u.medicine_id, u.name, u.conversion_factor,
               u.is_default_sale_unit, u.price_per_unit_paisa AS price_paisa, u.barcode,
               m.brand_name || ' · ' || m.generic_name || ' (' || m.code || ')' AS medicine_name
        FROM medicine_units u
        JOIN medicines m ON m.id = u.medicine_id
        WHERE m.deleted_at IS NULL
        ORDER BY u.name COLLATE NOCASE, u.id
      `).all() as Array<Record<string, unknown>>;
      return reply.send(units.map((unit) => ({
        ...unit,
        is_default_sale_unit: unit.is_default_sale_unit === 1,
      })));
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load medicine units.' });
    }
  });

  app.post('/api/master-data/values', async (request, reply) => {
    const user = requireMasterPermission(request, reply);
    if (!user) return;
    try {
      const body = request.body as { kind?: unknown; id?: unknown; name?: unknown; isActive?: unknown };
      if (!isMasterKind(body.kind)) return reply.status(400).send({ error: 'A valid master-data kind is required.' });
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) {
        return reply.status(400).send({ error: 'Name must contain 1 to 120 characters.' });
      }
      if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
        return reply.status(400).send({ error: 'Active status must be a boolean.' });
      }
      const table = masterTable(body.kind);
      const id = typeof body.id === 'string' ? body.id : null;
      const duplicate = db.prepare(`
        SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id != ?)
      `).get(body.name.trim(), id, id);
      if (duplicate) return reply.status(409).send({ error: 'A record with this name already exists.' });
      const now = Math.floor(Date.now() / 1000);
      const savedId = id ?? crypto.randomUUID();
      if (id) {
        const result = db.prepare(`
          UPDATE ${table} SET name = ?, is_active = ?, updated_at = ? WHERE id = ?
        `).run(body.name.trim(), body.isActive === false ? 0 : 1, now, id);
        if (result.changes === 0) return reply.status(404).send({ error: 'Master-data record not found.' });
      } else {
        db.prepare(`
          INSERT INTO ${table} (id, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        `).run(savedId, body.name.trim(), body.isActive === false ? 0 : 1, now, now);
      }
      return reply.send({ id: savedId });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not save master data.' });
    }
  });

  app.delete('/api/master-data/values/:kind/:id', async (request, reply) => {
    if (!requireMasterPermission(request, reply)) return;
    try {
      const { kind, id } = request.params as { kind: string; id: string };
      if (!isMasterKind(kind)) return reply.status(400).send({ error: 'A valid master-data kind is required.' });
      const table = masterTable(kind);
      const row = db.prepare(`SELECT id, name FROM ${table} WHERE id = ?`).get(id) as { id: string; name: string } | undefined;
      if (!row) return reply.status(404).send({ error: 'Master-data record not found.' });
      const references = db.prepare(`
        SELECT COUNT(*) AS count FROM medicines
        WHERE ${kind === 'category' ? 'category_id' : 'brand_id'} = ? AND deleted_at IS NULL
      `).get(id) as { count: number };
      if (references.count > 0) return reply.status(409).send({ error: 'This value is used by one or more products.' });
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not delete master data.' });
    }
  });

  app.post('/api/master-data/merge', async (request, reply) => {
    const user = requireMasterPermission(request, reply);
    if (!user) return;
    try {
      const body = request.body as { kind?: unknown; sourceId?: unknown; targetId?: unknown };
      if (!isMasterKind(body.kind) || typeof body.sourceId !== 'string' || typeof body.targetId !== 'string'
        || body.sourceId === body.targetId) {
        return reply.status(400).send({ error: 'Choose two different records of the same kind.' });
      }
      const table = masterTable(body.kind);
      const source = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(body.sourceId);
      const target = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(body.targetId);
      if (!source || !target) return reply.status(404).send({ error: 'A merge record was not found.' });
      const update = db.prepare(`
        UPDATE medicines SET ${body.kind === 'category' ? 'category_id' : 'brand_id'} = ?
        WHERE ${body.kind === 'category' ? 'category_id' : 'brand_id'} = ?
      `);
      const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      const result = db.transaction(() => {
        const changed = update.run(body.targetId, body.sourceId).changes;
        remove.run(body.sourceId);
        return changed;
      })();
      return reply.send({ updatedCount: result });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not merge master data.' });
    }
  });
}
