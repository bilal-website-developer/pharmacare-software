import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('local stock alerts report low and out-of-stock products from SQLite', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'c'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-notification-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const admin = await createLocalUser(db, {
    username: 'alertsadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({
      userId: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: ['products'],
    })}`,
  };
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO medicines (id, code, brand_name, generic_name, min_stock_alert, created_at, updated_at)
    VALUES ('low', 'LOW', 'Low stock', 'Test ingredient', 5, ?, ?),
           ('out', 'OUT', 'Out of stock', 'Test ingredient', 5, ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO stock_batches (
      id, medicine_id, batch_number, expiry_date, received_date, quantity_smallest_unit, created_at, updated_at
    ) VALUES ('low-batch', 'low', 'B-1', '2099-01-01', '2026-01-01', 2, ?, ?)
  `).run(now, now);

  const response = await app.inject({
    method: 'GET',
    url: '/api/notifications/stock-alerts?limit=1',
    headers,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  assert.equal(data.low_count, 1);
  assert.equal(data.out_count, 1);
  assert.equal(data.items.length, 1);
  assert.ok(Number.isFinite(Date.parse(data.generated_at)));
  assert.ok(data.items.every((item: { kind: string; stock: number }) =>
    item.kind === 'low' ? item.stock > 0 && item.stock <= 5 : item.stock === 0));
});

test('developer announcements sync from licensing, persist read state, and reconcile unpublishes', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'd'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-announcement-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });
  const admin = await createLocalUser(db, {
    username: 'announcementadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({
      userId: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: [],
    })}`,
  };
  const manager = await createLocalUser(db, {
    username: 'announcementmanager',
    plainTextPassword: 'SecureManagerPassword123!',
    role: 'manager',
  });
  const managerHeaders = {
    authorization: `Bearer ${app.jwt.sign({
      userId: manager.id,
      username: manager.username,
      role: manager.role,
      permissions: [],
    })}`,
  };
  const syncResponse = await app.inject({
    method: 'POST',
    url: '/api/license/announcements',
    payload: {
      announcements: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Update notice',
        body: 'A new version is available.',
        published_at: new Date().toISOString(),
      }],
    },
  });
  assert.equal(syncResponse.statusCode, 200, syncResponse.body);
  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/notifications/developer-announcements',
    headers,
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  assert.equal(listResponse.json()[0].title, 'Update notice');
  const managerList = await app.inject({
    method: 'GET',
    url: '/api/notifications/developer-announcements',
    headers: managerHeaders,
  });
  assert.equal(managerList.statusCode, 200, managerList.body);
  assert.deepEqual(managerList.json(), []);
  const managerRead = await app.inject({
    method: 'POST',
    url: '/api/notifications/developer-announcements/550e8400-e29b-41d4-a716-446655440000/read',
    headers: managerHeaders,
  });
  assert.equal(managerRead.statusCode, 403);

  const readResponse = await app.inject({
    method: 'POST',
    url: '/api/notifications/developer-announcements/550e8400-e29b-41d4-a716-446655440000/read',
    headers,
  });
  assert.equal(readResponse.statusCode, 200, readResponse.body);
  const readList = await app.inject({
    method: 'GET',
    url: '/api/notifications/developer-announcements',
    headers,
  });
  assert.equal(typeof readList.json()[0].read_at, 'number');

  const unpublishResponse = await app.inject({
    method: 'POST',
    url: '/api/license/announcements',
    payload: { announcements: [] },
  });
  assert.equal(unpublishResponse.statusCode, 200, unpublishResponse.body);
  const emptyList = await app.inject({
    method: 'GET',
    url: '/api/notifications/developer-announcements',
    headers,
  });
  assert.deepEqual(emptyList.json(), []);
});
