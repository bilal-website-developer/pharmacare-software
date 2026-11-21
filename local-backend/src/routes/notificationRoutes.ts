import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';

export function registerNotificationRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/notifications/stock-alerts', async (request, reply) => {
    try {
      const query = request.query as { limit?: string };
      const requestedLimit = Number.parseInt(query.limit || '50', 10);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 50;
      const all = db.prepare(`
        SELECT m.id AS medicine_id, m.brand_name AS name, m.strength, m.generic_name,
               m.min_stock_alert,
               COALESCE(SUM(CASE WHEN sb.status IN ('ACTIVE', 'NEAR_EXPIRY')
                                 THEN sb.quantity_smallest_unit ELSE 0 END), 0) AS stock
        FROM medicines m
        LEFT JOIN stock_batches sb ON sb.medicine_id = m.id
        WHERE m.deleted_at IS NULL AND m.is_active = 1 AND m.min_stock_alert > 0
        GROUP BY m.id
        HAVING stock <= m.min_stock_alert
        ORDER BY stock ASC, m.brand_name COLLATE NOCASE
      `).all() as Array<Record<string, unknown>>;
      const items = all.map((row) => ({
        medicine_id: row.medicine_id,
        name: row.name,
        strength: row.strength,
        generic_name: row.generic_name,
        stock: Number(row.stock),
        min_stock_alert: Number(row.min_stock_alert),
        kind: Number(row.stock) === 0 ? 'out' : 'low',
      }));
      return reply.send({
        low_count: items.filter((item) => item.kind === 'low').length,
        out_count: items.filter((item) => item.kind === 'out').length,
        generated_at: new Date().toISOString(),
        items: items.slice(0, limit),
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load stock alerts.' });
    }
  });
}
