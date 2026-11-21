import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('local stock routes filter batches, redact costs, summarize expiry, and list adjustments', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'd'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-stock-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const admin = await createLocalUser(db, {
    username: 'stockadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const cashier = await createLocalUser(db, {
    username: 'stockcashier',
    plainTextPassword: 'SecureCashierPassword123!',
    role: 'cashier',
    permissions: ['stock_inventory'],
  });
  const adminHeaders = {
    authorization: `Bearer ${app.jwt.sign({
      userId: admin.id, username: admin.username, role: admin.role, permissions: ['stock_inventory'],
    })}`,
  };
  const cashierHeaders = {
    authorization: `Bearer ${app.jwt.sign({
      userId: cashier.id, username: cashier.username, role: cashier.role, permissions: cashier.permissions,
    })}`,
  };
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO medicines (id, code, brand_name, generic_name, min_stock_alert, created_at, updated_at)
    VALUES ('med-stock', 'STOCK-1', 'Stock medicine', 'Test ingredient', 10, ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO stock_batches (
      id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa,
      mrp_paisa, quantity_smallest_unit, status, created_at, updated_at
    ) VALUES
      ('batch-near', 'med-stock', 'NEAR', ?, ?, 100, 150, 4, 'NEAR_EXPIRY', ?, ?),
      ('batch-expired', 'med-stock', 'OLD', ?, ?, 200, 300, 3, 'EXPIRED', ?, ?)
  `).run(addDays(10), today, now, now, addDays(-5), today, now, now);

  const batchList = await app.inject({
    method: 'GET',
    url: '/api/inventory/stock-batches?p_tab=near-expiry&p_page=1&p_page_size=10',
    headers: adminHeaders,
  });
  assert.equal(batchList.statusCode, 200, batchList.body);
  assert.equal(batchList.json().total_count, 1);
  assert.equal(batchList.json().rows[0].id, 'batch-near');
  assert.equal(batchList.json().rows[0].is_sellable, true);

  const redacted = await app.inject({
    method: 'GET',
    url: '/api/inventory/stock-batches?p_tab=all&p_page=1&p_page_size=10',
    headers: cashierHeaders,
  });
  assert.equal(redacted.statusCode, 200, redacted.body);
  assert.equal(redacted.json().rows[0].cost_paisa_per_base_unit, null);
  assert.equal(redacted.json().rows[0].stock_value_cost_paisa, null);

  const overview = await app.inject({
    method: 'GET',
    url: '/api/inventory/stock-overview',
    headers: adminHeaders,
  });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().stats.expiring_30, 1);
  assert.equal(overview.json().stats.expired_batches, 1);
  assert.equal(overview.json().buckets.find((bucket: { key: string }) => bucket.key === 'expired').count, 1);

  const adjustment = await app.inject({
    method: 'POST',
    url: '/api/inventory/adjust',
    headers: adminHeaders,
    payload: { batchId: 'batch-near', adjustedQuantitySmallestUnit: 6, reason: 'Stock count' },
  });
  assert.equal(adjustment.statusCode, 200, adjustment.body);
  const movements = await app.inject({
    method: 'GET',
    url: '/api/inventory/stock-adjustments?p_page=1&p_page_size=10&p_batch_id=batch-near',
    headers: adminHeaders,
  });
  assert.equal(movements.statusCode, 200, movements.body);
  assert.equal(movements.json().total_count, 1);
  assert.equal(movements.json().rows[0].quantity_delta, 2);
});
