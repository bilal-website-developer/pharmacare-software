import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';

const workflows = new Set(['held-bills', 'purchase-drafts']);
const maxItems = 500;
const maxPayloadBytes = 4 * 1024 * 1024;

export function registerWorkflowDraftRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/workflow-drafts/:workflow', async (request, reply) => {
    const identity = request.user as { userId?: string };
    const { workflow } = request.params as { workflow: string };
    if (!identity.userId) return reply.status(401).send({ error: 'Authentication is required.' });
    if (!workflows.has(workflow)) return reply.status(404).send({ error: 'Workflow drafts were not found.' });

    const row = db.prepare(`
      SELECT items FROM user_workflow_drafts WHERE user_id = ? AND workflow = ?
    `).get(identity.userId, workflow) as { items: string } | undefined;
    if (!row) return reply.send({ items: [] });
    try {
      const items: unknown = JSON.parse(row.items);
      if (!Array.isArray(items)) throw new TypeError('Saved workflow drafts are not a list.');
      return reply.send({ items });
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? `Saved workflow drafts are invalid: ${error.message}` : 'Saved workflow drafts are invalid.',
      });
    }
  });

  app.put('/api/workflow-drafts/:workflow', {
    bodyLimit: maxPayloadBytes + 64 * 1024,
  }, async (request, reply) => {
    const identity = request.user as { userId?: string };
    const { workflow } = request.params as { workflow: string };
    if (!identity.userId) return reply.status(401).send({ error: 'Authentication is required.' });
    if (!workflows.has(workflow)) return reply.status(404).send({ error: 'Workflow drafts were not found.' });
    const body = request.body as { items?: unknown };
    if (!Array.isArray(body?.items) || body.items.length > maxItems) {
      return reply.status(400).send({ error: `Drafts must be a list of no more than ${maxItems} items.` });
    }

    const serialized = JSON.stringify(body.items);
    if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
      return reply.status(413).send({ error: 'Saved drafts exceed the 4 MB limit.' });
    }
    db.prepare(`
      INSERT INTO user_workflow_drafts (user_id, workflow, items, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, workflow) DO UPDATE SET
        items = excluded.items,
        updated_at = excluded.updated_at
    `).run(identity.userId, workflow, serialized, Math.floor(Date.now() / 1000));
    return reply.send({ success: true });
  });
}
