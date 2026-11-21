import crypto from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import { getUserById, UserProfile } from '../services/authService';

interface PrintRequestRow {
  id: string;
  invoice_number: string;
  requested_by: string;
  requested_by_name: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CLAIMED';
  reviewed_by: string | null;
  reviewed_at: number | null;
  reason: string;
  note: string | null;
  print_snapshot: string | null;
  printed_at: number | null;
  created_at: number;
}

function requestUser(db: Database.Database, request: FastifyRequest): UserProfile | null {
  const identity = request.user as { userId?: string };
  return identity.userId ? getUserById(db, identity.userId) : null;
}

function toPrintRequest(row: PrintRequestRow) {
  if (!row.print_snapshot) throw new Error('Print request has no saved receipt snapshot.');
  const payload = JSON.parse(row.print_snapshot) as Record<string, unknown>;
  const data = payload.data as Record<string, unknown> | undefined;
  const type = data?.kind === 'PAYMENT' ? 'payment' : 'sale';
  return {
    id: row.id,
    type,
    receipt_ref: row.invoice_number,
    payload,
    requested_by: row.requested_by,
    requester_name: row.requested_by_name,
    requested_at: new Date(row.created_at * 1000).toISOString(),
    status: row.status === 'PENDING' ? 'pending' : row.status === 'REJECTED' ? 'rejected' : 'approved',
    decided_by: row.reviewed_by,
    decided_at: row.reviewed_at === null ? null : new Date(row.reviewed_at * 1000).toISOString(),
    note: row.note,
    printed_at: row.printed_at === null ? null : new Date(row.printed_at * 1000).toISOString(),
  };
}

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /(cost|profit|margin|purchase.?price)/i.test(key) || containsForbiddenField(child)
  );
}

function validateSubmission(body: unknown): {
  type: 'sale' | 'payment';
  receiptRef: string;
  requestKey: string;
  payload: Record<string, unknown>;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Print request details are required.');
  }
  const input = body as Record<string, unknown>;
  const payload = input.payload;
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data
    : null;
  const kind = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).kind
    : null;
  const validKind = input.type === 'payment'
    ? kind === 'PAYMENT'
    : kind === 'SALE' || kind === 'RETURN';
  if ((input.type !== 'sale' && input.type !== 'payment')
    || typeof input.receiptRef !== 'string'
    || input.receiptRef.trim().length < 1
    || input.receiptRef.length > 160
    || typeof input.requestKey !== 'string'
    || input.requestKey.length < 16
    || input.requestKey.length > 128
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || JSON.stringify(payload).length > 256_000
    || !validKind
    || containsForbiddenField(payload)) {
    throw new TypeError('Print request type, receipt, request key, or snapshot is invalid.');
  }
  return {
    type: input.type,
    receiptRef: input.receiptRef.trim(),
    requestKey: input.requestKey,
    payload: payload as Record<string, unknown>,
  };
}

export function registerPrintRequestRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/print-requests/pending-count', async (request, reply) => {
    const user = requestUser(db, request);
    if (user?.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can view all pending requests.' });
    const result = db.prepare("SELECT COUNT(*) AS count FROM print_requests WHERE status = 'PENDING'").get() as { count: number };
    return reply.send({ count: result.count });
  });

  app.get('/api/print-requests', async (request, reply) => {
    const user = requestUser(db, request);
    if (!user) return reply.status(401).send({ error: 'The local account is unavailable.' });
    const rows = user.role === 'admin'
      ? db.prepare('SELECT * FROM print_requests ORDER BY created_at DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM print_requests WHERE requested_by = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
    return reply.send((rows as PrintRequestRow[]).map(toPrintRequest));
  });

  app.post('/api/print-requests', async (request, reply) => {
    const user = requestUser(db, request);
    if (!user) return reply.status(401).send({ error: 'The local account is unavailable.' });
    try {
      const { type, receiptRef, requestKey, payload } = validateSubmission(request.body);
      const existing = db.prepare('SELECT * FROM print_requests WHERE request_key = ?').get(requestKey) as PrintRequestRow | undefined;
      if (existing) {
        if (existing.requested_by !== user.id && user.role !== 'admin') {
          return reply.status(409).send({ error: 'This print request key is already in use.' });
        }
        return reply.send({
          requestId: existing.id,
          type,
          receiptRef: existing.invoice_number,
          status: existing.status === 'PENDING' ? 'pending' : existing.status === 'REJECTED' ? 'rejected' : 'approved',
          payload: JSON.parse(existing.print_snapshot || 'null'),
          autoApproved: false,
          shouldPrint: false,
          alreadyPrinted: existing.printed_at !== null,
        });
      }

      const requestId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO print_requests (
          id, invoice_number, requested_by, requested_by_name, status, reason,
          print_snapshot, request_key, created_at
        ) VALUES (?, ?, ?, ?, 'PENDING', 'Receipt reprint requested', ?, ?, ?)
      `).run(
        requestId,
        receiptRef,
        user.id,
        user.fullName || user.username,
        JSON.stringify(payload),
        requestKey,
        now,
      );
      return reply.send({
        requestId,
        type,
        receiptRef,
        status: 'pending',
        payload,
        autoApproved: false,
        shouldPrint: false,
        alreadyPrinted: false,
      });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not create print request.' });
    }
  });

  app.post('/api/print-requests/:requestId/decision', async (request, reply) => {
    const user = requestUser(db, request);
    if (user?.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can decide print requests.' });
    const { requestId } = request.params as { requestId: string };
    const body = request.body as { decision?: unknown; note?: unknown } | null;
    if ((body?.decision !== 'approved' && body?.decision !== 'rejected')
      || (body.note !== undefined && body.note !== null
        && (typeof body.note !== 'string' || body.note.length > 500))) {
      return reply.status(400).send({ error: 'A valid decision and optional note are required.' });
    }
    const row = db.prepare('SELECT * FROM print_requests WHERE id = ?').get(requestId) as PrintRequestRow | undefined;
    if (!row) return reply.status(404).send({ error: 'Print request was not found.' });
    const updated = db.prepare(`
      UPDATE print_requests
      SET status = ?, reviewed_by = ?, reviewed_at = ?, note = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(body.decision === 'approved' ? 'APPROVED' : 'REJECTED', user.id, Math.floor(Date.now() / 1000), body.note ?? null, requestId);
    if (updated.changes === 0) return reply.status(409).send({ error: 'This print request has already been decided.' });
    const saved = db.prepare('SELECT * FROM print_requests WHERE id = ?').get(requestId) as PrintRequestRow;
    return reply.send({ payload: JSON.parse(saved.print_snapshot || 'null') });
  });

  app.post('/api/print-requests/:requestId/modify', async (request, reply) => {
    const user = requestUser(db, request);
    if (user?.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can modify print requests.' });
    const { requestId } = request.params as { requestId: string };
    const body = request.body as { payload?: unknown } | null;
    const payload = body?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || JSON.stringify(payload).length > 256_000 || containsForbiddenField(payload)) {
      return reply.status(400).send({ error: 'The modified receipt snapshot is invalid.' });
    }
    const updated = db.prepare(`
      UPDATE print_requests SET print_snapshot = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(JSON.stringify(payload), requestId);
    if (updated.changes === 0) return reply.status(404).send({ error: 'Pending print request was not found.' });
    return reply.send({ payload });
  });

  app.post('/api/print-requests/:requestId/printed', async (request, reply) => {
    const user = requestUser(db, request);
    if (user?.role !== 'admin') return reply.status(403).send({ error: 'Only the Shop Admin can mark a request printed.' });
    const { requestId } = request.params as { requestId: string };
    const updated = db.prepare(`
      UPDATE print_requests SET status = 'CLAIMED', printed_at = ?
      WHERE id = ? AND status IN ('APPROVED', 'CLAIMED')
    `).run(Math.floor(Date.now() / 1000), requestId);
    if (updated.changes === 0) return reply.status(409).send({ error: 'Only an approved print request can be marked printed.' });
    return reply.send({ success: true });
  });
}
