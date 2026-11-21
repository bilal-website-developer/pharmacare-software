import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('local product catalog supports filters, edits, imports, and barcode actions', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'b'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-inventory-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });
  const admin = await createLocalUser(db, {
    username: 'inventoryadmin',
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
  db.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('category-1', 'Pain Relief', now, now);
  db.prepare('INSERT INTO brands (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('brand-1', 'Acme Labs', now, now);

  const created = await app.inject({
    method: 'POST',
    url: '/api/inventory/products',
    headers,
    payload: {
      code: 'MED-001',
      brandName: 'Relief 500',
      genericName: 'Analgesic',
      categoryId: 'category-1',
      brandId: 'brand-1',
      minStockAlert: 10,
      units: [{
        name: 'Box',
        conversionFactor: 10,
        isDefaultSaleUnit: true,
        pricePerUnitPaisa: 1500,
        barcode: 'UNIT-1',
      }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const productId = created.json().id as string;
  const listing = await app.inject({
    method: 'GET',
    url: '/api/inventory/products?category=Pain%20Relief&brand=Acme%20Labs&drugClass=OTC&status=active',
    headers,
  });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(listing.json().total, 1);
  assert.equal(listing.json().products[0].units[0].barcode, 'UNIT-1');
  assert.equal(listing.json().products[0].category, 'Pain Relief');

  const edited = await app.inject({
    method: 'POST',
    url: '/api/inventory/products',
    headers,
    payload: {
      id: productId,
      code: 'MED-002',
      brandName: 'Relief 500 Plus',
      genericName: 'Analgesic',
      categoryId: 'category-1',
      brandId: 'brand-1',
      minStockAlert: 5,
      units: [{
        id: listing.json().products[0].units[0].id,
        name: 'Pack',
        conversionFactor: 5,
        isDefaultSaleUnit: true,
        pricePerUnitPaisa: 900,
        barcode: 'UNIT-2',
      }],
    },
  });
  assert.equal(edited.statusCode, 201, edited.body);
  const editedListing = await app.inject({
    method: 'GET',
    url: '/api/inventory/products?search=MED-002',
    headers,
  });
  assert.equal(editedListing.json().products[0].units[0].name, 'Pack');
  assert.equal(editedListing.json().products[0].units[0].barcode, 'UNIT-2');

  const assignedBarcode = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${productId}/barcode`,
    headers,
  });
  assert.equal(assignedBarcode.statusCode, 200, assignedBarcode.body);
  assert.match(assignedBarcode.json().barcode, /^[A-F0-9]{12}$/);
  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${productId}/barcode`,
    headers,
  })).statusCode, 409);

  const bulk = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [productId], action: 'deactivate', value: null },
  });
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.equal(bulk.json(), 1);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/inventory/products?status=inactive',
    headers,
  })).json().total, 1);

  const preview = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import-preview',
    headers,
    payload: {
      rows: [
        { line: 2, code: 'MED-002', barcode: '' },
        { line: 3, code: 'MED-NEW', barcode: '' },
      ],
    },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json(), [
    { line: 2, duplicate_in_database: true },
    { line: 3, duplicate_in_database: false },
  ]);

  const imported = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers,
    payload: {
      rows: [{
        line: 2,
        code: 'MED-IMPORT',
        brand_name: 'Imported Medicine',
        generic_name: 'Imported Generic',
        category: 'Imported Category',
        company: 'Imported Manufacturer',
        unit_name: 'Bottle',
        conversion_factor: '1',
        price_paisa: '250',
        min_stock_alert: '2',
      }],
    },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(imported.json(), { importedCount: 1 });
});
