import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('local master data supports category, manufacturer, and unit reads and writes', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'c'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-master-data-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const admin = await createLocalUser(db, {
    username: 'masteradmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({ userId: admin.id, role: admin.role, permissions: ['categories'] })}`,
  };
  const now = Math.floor(Date.now() / 1000);
  const oldCategoryId = crypto.randomUUID();
  const newCategoryId = crypto.randomUUID();
  const oldBrandId = crypto.randomUUID();
  const newBrandId = crypto.randomUUID();
  const medicineId = crypto.randomUUID();
  const unitId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const expiryDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(oldCategoryId, 'Pain relief', now, now);
  db.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(newCategoryId, 'General', now, now);
  db.prepare('INSERT INTO brands (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(oldBrandId, 'Old Manufacturer', now, now);
  db.prepare('INSERT INTO brands (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(newBrandId, 'New Manufacturer', now, now);
  db.prepare(`
    INSERT INTO medicines (id, code, brand_name, generic_name, category_id, brand_id, min_stock_alert, created_at, updated_at)
    VALUES (?, 'M-1', 'Pain Relief 500', 'Analgesic', ?, ?, 10, ?, ?)
  `).run(medicineId, oldCategoryId, oldBrandId, now, now);
  db.prepare(`
    INSERT INTO medicine_units (id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa, barcode, created_at, updated_at)
    VALUES (?, ?, 'Box', 10, 1, 1500, 'UNIT-123', ?, ?)
  `).run(unitId, medicineId, now, now);
  db.prepare(`
    INSERT INTO stock_batches (id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa, mrp_paisa, quantity_smallest_unit, status, created_at, updated_at)
    VALUES (?, ?, 'B-1', ?, date('now'), 100, 200, 5, 'ACTIVE', ?, ?)
  `).run(batchId, medicineId, expiryDate, now, now);

  const overview = await app.inject({ method: 'GET', url: '/api/master-data/overview', headers });
  assert.equal(overview.statusCode, 200, overview.body);
  const overviewData = overview.json();
  const category = overviewData.categories.find((row: { id: string }) => row.id === oldCategoryId);
  assert.equal(category.product_count, 1);
  assert.equal(category.low_count, 1);
  assert.equal(category.expiring_count, 1);
  assert.equal(category.stock_value_paisa, 500);

  const unitList = await app.inject({ method: 'GET', url: '/api/master-data/units', headers });
  assert.equal(unitList.statusCode, 200, unitList.body);
  assert.deepEqual(unitList.json()[0], {
    id: unitId,
    medicine_id: medicineId,
    name: 'Box',
    conversion_factor: 10,
    is_default_sale_unit: true,
    price_paisa: 1500,
    barcode: 'UNIT-123',
    medicine_name: 'Pain Relief 500 · Analgesic (M-1)',
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/master-data/values',
    headers,
    payload: { kind: 'category', name: 'Supplements' },
  });
  assert.equal(created.statusCode, 200, created.body);
  const newId = created.json().id as string;
  const renamed = await app.inject({
    method: 'POST',
    url: '/api/master-data/values',
    headers,
    payload: { kind: 'category', id: newId, name: 'Vitamins', isActive: false },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(
    (await app.inject({
      method: 'POST',
      url: '/api/master-data/values',
      headers,
      payload: { kind: 'category', name: 'vitamins' },
    })).statusCode,
    409,
  );

  const protectedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/master-data/values/category/${oldCategoryId}`,
    headers,
  });
  assert.equal(protectedDelete.statusCode, 409);

  const merge = await app.inject({
    method: 'POST',
    url: '/api/master-data/merge',
    headers,
    payload: { kind: 'category', sourceId: oldCategoryId, targetId: newCategoryId },
  });
  assert.equal(merge.statusCode, 200, merge.body);
  assert.equal(merge.json().updatedCount, 1);
  assert.equal(
    (db.prepare('SELECT category_id FROM medicines WHERE id = ?').get(medicineId) as { category_id: string }).category_id,
    newCategoryId,
  );

  const brandMerge = await app.inject({
    method: 'POST',
    url: '/api/master-data/merge',
    headers,
    payload: { kind: 'brand', sourceId: oldBrandId, targetId: newBrandId },
  });
  assert.equal(brandMerge.statusCode, 200, brandMerge.body);
  assert.equal(brandMerge.json().updatedCount, 1);
  assert.equal(
    (db.prepare('SELECT brand_id FROM medicines WHERE id = ?').get(medicineId) as { brand_id: string }).brand_id,
    newBrandId,
  );

  const deleteUnused = await app.inject({
    method: 'DELETE',
    url: `/api/master-data/values/category/${newId}`,
    headers,
  });
  assert.equal(deleteUnused.statusCode, 200, deleteUnused.body);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/master-data/overview', headers })).json().categories
      .some((row: { id: string }) => row.id === newId),
    false,
  );
});
