import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../server';
import { createDatabaseConnection } from '../db/database';
import { initializeSchema } from '../db/schema';
import { createLocalUser } from '../services/authService';

test('local print requests are private, idempotent, and admin-managed', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'e'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-print-request-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const admin = await createLocalUser(db, {
    username: 'printadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
    fullName: 'Print Admin',
  });
  const cashier = await createLocalUser(db, {
    username: 'printcashier',
    plainTextPassword: 'SecureCashierPassword123!',
    role: 'cashier',
    fullName: 'Print Cashier',
  });
  const adminHeaders = {
    authorization: `Bearer ${app.jwt.sign({ userId: admin.id, role: admin.role })}`,
  };
  const cashierHeaders = {
    authorization: `Bearer ${app.jwt.sign({ userId: cashier.id, role: cashier.role })}`,
  };
  const requestKey = crypto.randomUUID();
  const payload = {
    data: { kind: 'SALE', memoNo: 'INV-1001' },
    settings: { notes: [] },
    format: 'thermal80',
    template: 'pharmacy-memo',
  };
  const submission = {
    type: 'sale',
    receiptRef: 'INV-1001',
    requestKey,
    payload,
  };

  assert.equal((await app.inject({ method: 'GET', url: '/api/print-requests/pending-count' })).statusCode, 401);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/print-requests/pending-count',
    headers: cashierHeaders,
  })).statusCode, 403);

  const created = await app.inject({
    method: 'POST',
    url: '/api/print-requests',
    headers: cashierHeaders,
    payload: submission,
  });
  assert.equal(created.statusCode, 200, created.body);
  const createdResult = created.json();
  assert.equal(createdResult.status, 'pending');
  assert.equal(createdResult.autoApproved, false);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/print-requests',
    headers: cashierHeaders,
    payload: submission,
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().requestId, createdResult.requestId);

  const cashierList = await app.inject({
    method: 'GET',
    url: '/api/print-requests',
    headers: cashierHeaders,
  });
  assert.equal(cashierList.statusCode, 200);
  assert.equal(cashierList.json()[0].requester_name, 'Print Cashier');

  const count = await app.inject({
    method: 'GET',
    url: '/api/print-requests/pending-count',
    headers: adminHeaders,
  });
  assert.deepEqual(count.json(), { count: 1 });

  const returnSubmission = {
    ...submission,
    receiptRef: 'RET-1001',
    requestKey: crypto.randomUUID(),
    payload: {
      ...payload,
      data: { kind: 'RETURN', memoNo: 'RET-1001' },
    },
  };
  const returnCreated = await app.inject({
    method: 'POST',
    url: '/api/print-requests',
    headers: cashierHeaders,
    payload: returnSubmission,
  });
  assert.equal(returnCreated.statusCode, 200, returnCreated.body);

  const modifiedPayload = { ...payload, data: { ...payload.data, memoNo: 'INV-1001-COPY' } };
  const modified = await app.inject({
    method: 'POST',
    url: `/api/print-requests/${createdResult.requestId}/modify`,
    headers: adminHeaders,
    payload: { payload: modifiedPayload },
  });
  assert.equal(modified.statusCode, 200, modified.body);

  const approved = await app.inject({
    method: 'POST',
    url: `/api/print-requests/${createdResult.requestId}/decision`,
    headers: adminHeaders,
    payload: { decision: 'approved', note: 'Verified' },
  });
  assert.equal(approved.statusCode, 200);
  assert.deepEqual(approved.json().payload, modifiedPayload);

  const printed = await app.inject({
    method: 'POST',
    url: `/api/print-requests/${createdResult.requestId}/printed`,
    headers: adminHeaders,
  });
  assert.equal(printed.statusCode, 200);

  const completed = await app.inject({
    method: 'GET',
    url: '/api/print-requests',
    headers: cashierHeaders,
  });
  const completedRequest = completed.json().find(
    (request: { id: string }) => request.id === createdResult.requestId,
  );
  assert.equal(completedRequest.status, 'approved');
  assert.equal(completedRequest.note, 'Verified');
  assert.ok(completedRequest.printed_at);
});

test('legacy print-request tables receive fields needed by local workflows', () => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'f'.repeat(64);
  const db = createDatabaseConnection(':memory:');
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE print_requests (
        id TEXT PRIMARY KEY,
        sale_id TEXT,
        invoice_number TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_by_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at INTEGER,
        print_snapshot TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    initializeSchema(db);
    const columns = new Set(
      (db.pragma('table_info(print_requests)') as Array<{ name: string }>).map((column) => column.name),
    );
    assert.ok(columns.has('request_key'));
    assert.ok(columns.has('note'));
    assert.ok(columns.has('printed_at'));
    assert.equal((db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get() as { version: number }).version, 4);
  } finally {
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  }
});
