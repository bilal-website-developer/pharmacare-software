import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import { getUserById } from '../services/authService';

export function registerNotificationRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/notifications/developer-announcements', async (request, reply) => {
    try {
      const identity = request.user as { userId?: string };
      const user = identity.userId ? getUserById(db, identity.userId) : null;
      if (user?.role !== 'admin') return reply.send([]);
      return reply.send(db.prepare(`
        SELECT id, title, body, published_at, read_at
        FROM developer_announcements
        ORDER BY published_at DESC, received_at DESC
      `).all());
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load announcements.' });
    }
  });

  app.post('/api/notifications/developer-announcements/:id/read', async (request, reply) => {
    try {
      const identity = request.user as { userId?: string };
      const user = identity.userId ? getUserById(db, identity.userId) : null;
      if (user?.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the Shop Admin can manage developer announcements.' });
      }
      const { id } = request.params as { id: string };
      const result = db.prepare(`
        UPDATE developer_announcements SET read_at = ?
        WHERE id = ? AND read_at IS NULL
      `).run(Math.floor(Date.now() / 1000), id);
      if (result.changes === 0) {
        const existing = db.prepare('SELECT id FROM developer_announcements WHERE id = ?').get(id);
        if (!existing) return reply.status(404).send({ error: 'Announcement was not found.' });
      }
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not update announcement.' });
    }
  });

  app.post('/api/license/announcements', async (request, reply) => {
    const body = request.body as { announcements?: unknown };
    if (!Array.isArray(body?.announcements) || body.announcements.length > 200) {
      return reply.status(400).send({ error: 'A valid announcement list is required.' });
    }
    const announcements = body.announcements as Array<Record<string, unknown>>;
    if (announcements.some((item) => (
      typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120
      || typeof item.body !== 'string' || !item.body.trim() || item.body.length > 2000
      || typeof item.published_at !== 'string' || !Number.isFinite(Date.parse(item.published_at))
    ))) {
      return reply.status(400).send({ error: 'One or more announcements are invalid.' });
    }
    const receivedAt = Math.floor(Date.now() / 1000);
    const upsert = db.prepare(`
      INSERT INTO developer_announcements (id, title, body, published_at, received_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        published_at = excluded.published_at,
        received_at = excluded.received_at,
        read_at = CASE
          WHEN developer_announcements.published_at <> excluded.published_at THEN NULL
          ELSE developer_announcements.read_at
        END
    `);
    const persist = db.transaction(() => {
      if (announcements.length === 0) {
        db.prepare('DELETE FROM developer_announcements').run();
      } else {
        const ids = announcements.map((item) => item.id as string);
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(`DELETE FROM developer_announcements WHERE id NOT IN (${placeholders})`).run(...ids);
      }
      for (const item of announcements) {
        upsert.run(item.id, item.title, item.body, item.published_at, receivedAt);
      }
    });
    persist();
    return reply.send({ success: true, received: announcements.length });
  });

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
