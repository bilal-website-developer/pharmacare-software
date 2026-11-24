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
        conversion_factor: '10',
        price_paisa: '500',
        min_stock_alert: '2',
        opening_stock_qty: '3',
        opening_batch_number: 'OPEN-IMPORT-1',
        opening_expiry_date: '2099-12-31',
        opening_cost_paisa: '250',
      }],
    },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(imported.json(), { importedCount: 1 });
  const importedMedicine = db.prepare(`
    SELECT medicine.id, unit.conversion_factor, unit.price_per_unit_paisa
    FROM medicines AS medicine
    JOIN medicine_units AS unit ON unit.medicine_id = medicine.id
    WHERE medicine.code = 'MED-IMPORT'
  `).get() as { id: string; conversion_factor: number; price_per_unit_paisa: number };
  assert.equal(importedMedicine.conversion_factor, 10);
  assert.equal(importedMedicine.price_per_unit_paisa, 500);
  assert.deepEqual(db.prepare(`
    SELECT batch_number, quantity_smallest_unit, cost_price_paisa, mrp_paisa
    FROM stock_batches WHERE medicine_id = ?
  `).get(importedMedicine.id), {
    batch_number: 'OPEN-IMPORT-1',
    quantity_smallest_unit: 30,
    cost_price_paisa: 25,
    mrp_paisa: 50,
  });
  assert.deepEqual(db.prepare(`
    SELECT movement_type, quantity_smallest_units, balance_after
    FROM stock_movements WHERE medicine_id = ?
  `).get(importedMedicine.id), {
    movement_type: 'INITIAL',
    quantity_smallest_units: 30,
    balance_after: 30,
  });

  const invalidOpeningBatch = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers,
    payload: {
      rows: [{
        line: 3,
        code: 'MED-INVALID-STOCK',
        brand_name: 'Invalid Stock Product',
        generic_name: 'Imported Generic',
        category: 'Imported Category',
        company: 'Imported Manufacturer',
        unit_name: 'Bottle',
        conversion_factor: '1',
        price_paisa: '250',
        opening_stock_qty: '2',
        opening_expiry_date: '2099-12-31',
        opening_cost_paisa: '100',
      }],
    },
  });
  assert.equal(invalidOpeningBatch.statusCode, 400, invalidOpeningBatch.body);
  assert.equal(db.prepare("SELECT 1 FROM medicines WHERE code = 'MED-INVALID-STOCK'").get(), undefined);

  const seller = await createLocalUser(db, {
    username: 'sellerimport',
    plainTextPassword: 'SecureSellerPassword123!',
    role: 'seller',
    permissions: ['products'],
  });
  const sellerHeaders = {
    authorization: `Bearer ${app.jwt.sign({
      userId: seller.id,
      username: seller.username,
      role: 'seller',
      permissions: ['products'],
    })}`,
  };
  const unauthorizedOpeningBatch = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers: sellerHeaders,
    payload: {
      rows: [{
        line: 4,
        code: 'MED-SELLER-STOCK',
        brand_name: 'Seller Stock Product',
        generic_name: 'Imported Generic',
        category: 'Imported Category',
        company: 'Imported Manufacturer',
        unit_name: 'Bottle',
        conversion_factor: '1',
        price_paisa: '250',
        opening_stock_qty: '2',
        opening_batch_number: 'SELLER-LOT',
        opening_expiry_date: '2099-12-31',
        opening_cost_paisa: '100',
      }],
    },
  });
  assert.equal(unauthorizedOpeningBatch.statusCode, 403, unauthorizedOpeningBatch.body);
  assert.equal(db.prepare("SELECT 1 FROM medicines WHERE code = 'MED-SELLER-STOCK'").get(), undefined);

  const manyRows = Array.from({ length: 2001 }, (_, index) => ({
    line: index + 2,
    code: `BULK-${index}`,
    brand_name: 'Bulk Imported Medicine',
    generic_name: 'Bulk Generic',
    category: 'Bulk Import Category',
    company: 'Bulk Import Manufacturer',
    unit_name: 'Box',
    conversion_factor: '1',
    price_paisa: '500',
    min_stock_alert: '0',
  }));
  const manyRowsPreview = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import-preview',
    headers,
    payload: { rows: manyRows },
  });
  assert.equal(manyRowsPreview.statusCode, 200, manyRowsPreview.body);
  assert.equal(manyRowsPreview.json().length, manyRows.length);
  assert.ok(manyRowsPreview.json().every((row: { duplicate_in_database: boolean }) => !row.duplicate_in_database));

  const manyRowsImport = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers,
    payload: { rows: manyRows },
  });
  assert.equal(manyRowsImport.statusCode, 200, manyRowsImport.body);
  assert.equal(manyRowsImport.json().importedCount, manyRows.length);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM medicines WHERE code LIKE 'BULK-%'").get() as { count: number }).count,
    manyRows.length,
  );
});

test('inactive products stay out of stock KPIs and require one-time opening-stock confirmation', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'c'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-opening-stock-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const admin = await createLocalUser(db, {
    username: 'openingstockadmin',
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
  const imported = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers,
    payload: {
      rows: [{
        line: 2,
        code: 'INACTIVE-OPENING-1',
        brand_name: 'Inactive Opening Product',
        generic_name: 'Opening Generic',
        category: 'Opening Category',
        company: 'Opening Manufacturer',
        unit_name: 'Box',
        conversion_factor: '10',
        price_paisa: '500',
        min_stock_alert: '5',
        is_active: 'false',
      }],
    },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const inactive = await app.inject({
    method: 'GET',
    url: '/api/inventory/products?status=inactive&search=INACTIVE-OPENING-1',
    headers,
  });
  assert.equal(inactive.statusCode, 200, inactive.body);
  const product = inactive.json().products[0];
  assert.equal(product.openingStockPromptRequired, true);
  assert.deepEqual({
    totalActive: inactive.json().stats.totalActive,
    lowStock: inactive.json().stats.lowStock,
    outOfStock: inactive.json().stats.outOfStock,
  }, { totalActive: 0, lowStock: 0, outOfStock: 0 });
  const lowStockOnly = await app.inject({
    method: 'GET',
    url: '/api/inventory/products?status=all&lowStockOnly=true&search=INACTIVE-OPENING-1',
    headers,
  });
  assert.equal(lowStockOnly.json().total, 0);

  const blockedActivation = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [product.id], action: 'activate', value: null },
  });
  assert.equal(blockedActivation.statusCode, 400);
  assert.match(blockedActivation.json().error, /opening stock/i);

  const invalidOpening = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${product.id}/activate-initial-stock`,
    headers,
    payload: { openingStockQty: 2, batchNumber: '', expiryDate: '', costPricePaisa: 250 },
  });
  assert.equal(invalidOpening.statusCode, 400);
  assert.equal((db.prepare('SELECT is_active, opening_stock_recorded FROM medicines WHERE id = ?').get(product.id) as {
    is_active: number;
    opening_stock_recorded: number;
  }).is_active, 0);

  const invalidExpiry = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${product.id}/activate-initial-stock`,
    headers,
    payload: {
      openingStockQty: 2,
      batchNumber: 'REAL-LOT-1',
      expiryDate: '2000-01-01',
      costPricePaisa: 250,
    },
  });
  assert.equal(invalidExpiry.statusCode, 400);

  const seller = await createLocalUser(db, {
    username: 'openingstockseller',
    plainTextPassword: 'SecureSellerPassword123!',
    role: 'seller',
    permissions: ['products'],
  });
  const sellerHeaders = {
    authorization: `Bearer ${app.jwt.sign({
      userId: seller.id,
      username: seller.username,
      role: seller.role,
      permissions: ['products'],
    })}`,
  };
  const unauthorizedOpening = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${product.id}/activate-initial-stock`,
    headers: sellerHeaders,
    payload: {
      openingStockQty: 2,
      batchNumber: 'REAL-LOT-1',
      expiryDate: '2099-12-31',
      costPricePaisa: 250,
    },
  });
  assert.equal(unauthorizedOpening.statusCode, 403);

  const activated = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${product.id}/activate-initial-stock`,
    headers,
    payload: {
      openingStockQty: 2,
      batchNumber: 'REAL-LOT-1',
      expiryDate: '2099-12-31',
      costPricePaisa: 250,
    },
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.deepEqual(db.prepare(`
    SELECT batch_number, quantity_smallest_unit, cost_price_paisa, mrp_paisa
    FROM stock_batches WHERE medicine_id = ?
  `).get(product.id), {
    batch_number: 'REAL-LOT-1',
    quantity_smallest_unit: 20,
    cost_price_paisa: 25,
    mrp_paisa: 50,
  });
  assert.deepEqual(db.prepare(`
    SELECT movement_type, quantity_smallest_units, balance_after
    FROM stock_movements WHERE medicine_id = ?
  `).get(product.id), {
    movement_type: 'INITIAL',
    quantity_smallest_units: 20,
    balance_after: 20,
  });
  const activatedListing = await app.inject({
    method: 'GET',
    url: '/api/inventory/products?status=active&search=INACTIVE-OPENING-1',
    headers,
  });
  assert.equal(activatedListing.json().products[0].openingStockPromptRequired, false);
  assert.equal(activatedListing.json().stats.outOfStock, 0);

  const repeatedInitialActivation = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${product.id}/activate-initial-stock`,
    headers,
    payload: {
      openingStockQty: 7,
      batchNumber: 'SHOULD-NOT-BE-RECORDED',
      expiryDate: '2099-12-31',
      costPricePaisa: 250,
    },
  });
  assert.equal(repeatedInitialActivation.statusCode, 200, repeatedInitialActivation.body);
  assert.equal(repeatedInitialActivation.json().alreadyRecorded, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stock_batches WHERE medicine_id = ?').get(product.id) as {
    count: number;
  }).count, 1);

  await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [product.id], action: 'deactivate', value: null },
  });
  const reactivated = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [product.id], action: 'activate', value: null },
  });
  assert.equal(reactivated.statusCode, 200, reactivated.body);
  assert.equal((db.prepare('SELECT opening_stock_recorded FROM medicines WHERE id = ?').get(product.id) as {
    opening_stock_recorded: number;
  }).opening_stock_recorded, 1);

  const zeroStockImport = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/import',
    headers,
    payload: {
      rows: [{
        line: 3,
        code: 'INACTIVE-OPENING-ZERO',
        brand_name: 'Inactive Zero Product',
        generic_name: 'Zero Generic',
        category: 'Opening Category',
        company: 'Opening Manufacturer',
        unit_name: 'Box',
        conversion_factor: '1',
        price_paisa: '500',
        is_active: 'false',
      }],
    },
  });
  assert.equal(zeroStockImport.statusCode, 200, zeroStockImport.body);
  const zeroProduct = db.prepare('SELECT id FROM medicines WHERE code = ?').get('INACTIVE-OPENING-ZERO') as { id: string };
  const activatedWithoutStock = await app.inject({
    method: 'POST',
    url: `/api/inventory/products/${zeroProduct.id}/activate-initial-stock`,
    headers,
    payload: { openingStockQty: 0, batchNumber: '', expiryDate: '', costPricePaisa: null },
  });
  assert.equal(activatedWithoutStock.statusCode, 200, activatedWithoutStock.body);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stock_batches WHERE medicine_id = ?').get(zeroProduct.id) as {
    count: number;
  }).count, 0);
  await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [zeroProduct.id], action: 'deactivate', value: null },
  });
  const zeroReactivated = await app.inject({
    method: 'POST',
    url: '/api/inventory/products/bulk-update',
    headers,
    payload: { ids: [zeroProduct.id], action: 'activate', value: null },
  });
  assert.equal(zeroReactivated.statusCode, 200, zeroReactivated.body);
});
