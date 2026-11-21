import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';

interface LocalActor {
  userId: string;
  username: string;
  role: string;
}

function canPermanentlyDelete(db: Database.Database, type: string, id: string): boolean {
  if (type === 'product') {
    const references = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_items WHERE medicine_id = ?) +
        (SELECT COUNT(*) FROM sale_items WHERE medicine_id = ?) +
        (SELECT COUNT(*) FROM stock_batches WHERE medicine_id = ?) +
        (SELECT COUNT(*) FROM stock_movements WHERE medicine_id = ?) AS count
    `).get(id, id, id, id) as { count: number };
    return references.count === 0;
  }
  if (type === 'supplier') {
    const references = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchases WHERE supplier_id = ?) +
        (SELECT COUNT(*) FROM stock_batches WHERE supplier_id = ?) +
        (SELECT COUNT(*) FROM supplier_ledger WHERE supplier_id = ?) AS count
    `).get(id, id, id) as { count: number };
    return references.count === 0;
  }
  return false;
}

export function registerTrashRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/trash', async (request, reply) => {
    const actor = request.user as LocalActor;
    if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can access Trash Bin.' });
    const rows = db.prepare(`
      SELECT id, entity_type, entity_id, entity_name, action, reason,
             performed_by, performed_by_name, created_at
      FROM trash_bin_events
      ORDER BY created_at DESC, id DESC
    `).all() as Array<Record<string, unknown>>;
    return reply.send(rows.map((row) => {
      const entityType = row.entity_type === 'user' ? 'profile'
        : row.entity_type === 'product' ? 'medicine'
          : row.entity_type;
      const action = row.action === 'deactivate' ? 'deactivated'
        : row.action === 'restore' ? 'restored'
          : row.action === 'void' ? 'voided'
            : 'deleted';
      return {
        id: row.id,
        actor_id: row.performed_by,
        actor_name: row.performed_by_name,
        entity_type: entityType,
        entity_id: row.entity_id,
        entity_role: null,
        action,
        display_name: row.entity_name,
        reason: row.reason,
        created_at: new Date(Number(row.created_at) * 1000).toISOString(),
        can_restore: ['product', 'supplier', 'user'].includes(String(row.entity_type))
          && row.action !== 'restore'
          && row.action !== 'permanent_delete',
        can_permanently_delete: ['product', 'supplier'].includes(String(row.entity_type))
          && row.action !== 'restore'
          && row.action !== 'permanent_delete'
          && canPermanentlyDelete(db, String(row.entity_type), String(row.entity_id)),
      };
    }));
  });

  app.put('/api/trash/:eventId/restore', async (request, reply) => {
    const actor = request.user as LocalActor;
    if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can restore Trash Bin items.' });
    const { eventId } = request.params as { eventId: string };
    const event = db.prepare(`
      SELECT entity_type, entity_id, entity_name FROM trash_bin_events WHERE id = ?
    `).get(eventId) as { entity_type: string; entity_id: string; entity_name: string } | undefined;
    if (!event || !['product', 'supplier', 'user'].includes(event.entity_type)) {
      return reply.status(404).send({ error: 'This Trash Bin item cannot be restored.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const transaction = db.transaction(() => {
      if (event.entity_type === 'product') {
        const result = db.prepare('UPDATE medicines SET is_active = 1, deleted_at = NULL, updated_at = ? WHERE id = ?')
          .run(now, event.entity_id);
        if (result.changes === 0) throw new Error('Product not found.');
      } else if (event.entity_type === 'supplier') {
        const result = db.prepare('UPDATE suppliers SET is_active = 1, deleted_at = NULL, updated_at = ? WHERE id = ?')
          .run(now, event.entity_id);
        if (result.changes === 0) throw new Error('Supplier not found.');
      } else {
        const result = db.prepare('UPDATE users SET is_active = 1, deleted_at = NULL, updated_at = ? WHERE id = ?')
          .run(now, event.entity_id);
        if (result.changes === 0) throw new Error('User not found.');
      }
      db.prepare(`
        INSERT INTO trash_bin_events (
          id, entity_type, entity_id, entity_name, action, reason,
          performed_by, performed_by_name, created_at
        ) VALUES (?, ?, ?, ?, 'restore', 'Restored from Trash Bin.', ?, ?, ?)
      `).run(crypto.randomUUID(), event.entity_type, event.entity_id, event.entity_name, actor.userId, actor.username, now);
    });
    try {
      transaction();
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not restore this item.' });
    }
  });

  app.delete('/api/trash/:eventId', async (request, reply) => {
    const actor = request.user as LocalActor;
    if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can permanently delete Trash Bin items.' });
    const { eventId } = request.params as { eventId: string };
    const event = db.prepare(`
      SELECT entity_type, entity_id, entity_name FROM trash_bin_events WHERE id = ?
    `).get(eventId) as { entity_type: string; entity_id: string; entity_name: string } | undefined;
    if (!event || !canPermanentlyDelete(db, event.entity_type, event.entity_id)) {
      return reply.status(409).send({ error: 'This item has transaction history or cannot be permanently deleted.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const transaction = db.transaction(() => {
      if (event.entity_type === 'product') db.prepare('DELETE FROM medicines WHERE id = ?').run(event.entity_id);
      else if (event.entity_type === 'supplier') db.prepare('DELETE FROM suppliers WHERE id = ?').run(event.entity_id);
      else throw new Error('This item cannot be permanently deleted.');
      db.prepare(`
        INSERT INTO trash_bin_events (
          id, entity_type, entity_id, entity_name, action, reason,
          performed_by, performed_by_name, created_at
        ) VALUES (?, ?, ?, ?, 'permanent_delete', 'Permanently deleted from Trash Bin.', ?, ?, ?)
      `).run(crypto.randomUUID(), event.entity_type, event.entity_id, event.entity_name, actor.userId, actor.username, now);
    });
    try {
      transaction();
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not permanently delete this item.' });
    }
  });
}
