import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import { getUserById } from '../services/authService';

export function registerPreferenceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/preferences/sidebar', async (request, reply) => {
    const identity = request.user as { userId?: string };
    if (!identity.userId) return reply.status(401).send({ error: 'Authentication is required.' });
    const user = getUserById(db, identity.userId);
    if (!user) return reply.status(401).send({ error: 'This account is unavailable.' });
    const row = db.prepare(`
      SELECT favorite_pages, tip_dismissed FROM user_preferences WHERE user_id = ?
    `).get(user.id) as { favorite_pages: string; tip_dismissed: number } | undefined;
    let favoritePageKeys: unknown;
    try {
      favoritePageKeys = JSON.parse(row?.favorite_pages || '[]');
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? `Saved sidebar preferences are invalid: ${error.message}` : 'Saved sidebar preferences are invalid.',
      });
    }
    if (!Array.isArray(favoritePageKeys) || !favoritePageKeys.every((key) => typeof key === 'string')) {
      return reply.status(500).send({ error: 'Saved sidebar favorites are invalid.' });
    }
    return reply.send({
      favoritePageKeys,
      tipDismissed: row?.tip_dismissed === 1,
    });
  });

  app.put('/api/preferences/sidebar', async (request, reply) => {
    const identity = request.user as { userId?: string };
    if (!identity.userId) return reply.status(401).send({ error: 'Authentication is required.' });
    const user = getUserById(db, identity.userId);
    if (!user) return reply.status(401).send({ error: 'This account is unavailable.' });
    const body = request.body as { favoritePageKeys?: unknown; tipDismissed?: unknown };
    if (!Array.isArray(body?.favoritePageKeys)
      || body.favoritePageKeys.length > 8
      || body.favoritePageKeys.some((key) => typeof key !== 'string')
      || new Set(body.favoritePageKeys).size !== body.favoritePageKeys.length
      || typeof body.tipDismissed !== 'boolean') {
      return reply.status(400).send({ error: 'Sidebar preferences are invalid.' });
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO user_preferences (user_id, favorite_pages, tip_dismissed, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        favorite_pages = excluded.favorite_pages,
        tip_dismissed = excluded.tip_dismissed,
        updated_at = excluded.updated_at
    `).run(user.id, JSON.stringify(body.favoritePageKeys), body.tipDismissed ? 1 : 0, now);
    return reply.send({ success: true });
  });
}
