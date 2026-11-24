import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../server';
import { activateShopLicense } from '../services/licenseService';
import { createLocalUser } from '../services/authService';

test('profit summary returns the validated analytics shape for the requested half-open date range', async (t) => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  process.env.DATABASE_KEY = '9'.repeat(64);
  process.env.CENTRAL_LICENSE_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.PHARMA_HARDWARE_ID = 'profit-summary-test-device';
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-profit-summary-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    delete process.env.DATABASE_KEY;
    delete process.env.CENTRAL_LICENSE_PUBLIC_KEY;
    delete process.env.PHARMA_HARDWARE_ID;
  });

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    shopId: 'profit-summary-test-shop',
    shopName: 'Profit Summary Test Pharmacy',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    hardwareId: process.env.PHARMA_HARDWARE_ID,
    status: 'ACTIVE',
    graceDays: 30,
  })).toString('base64url');
  const content = `${header}.${payload}`;
  const licenseToken = `${content}.${crypto.sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
  activateShopLicense(db, {
    shopId: 'profit-summary-test-shop',
    shopName: 'Profit Summary Test Pharmacy',
    licenseToken,
    hardwareId: process.env.PHARMA_HARDWARE_ID!,
  });

  const admin = await createLocalUser(db, {
    username: 'profitadmin',
    plainTextPassword: 'SecureProfitPassword123!',
    role: 'admin',
    permissions: ['reports'],
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({
      userId: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: admin.permissions,
    })}`,
  };

  const from = new Date('2026-11-22T00:00:00.000+05:00');
  const to = new Date('2026-11-23T00:00:00.000+05:00');
  const fromSeconds = Math.floor(from.getTime() / 1000);
  const toSeconds = Math.floor(to.getTime() / 1000);
  db.prepare(`
    INSERT INTO medicines (id, code, brand_name, generic_name, drug_class, created_at, updated_at)
    VALUES ('profit-medicine', 'PROFIT-1', 'Profit Medicine', 'Test Generic', 'OTC', ?, ?)
  `).run(fromSeconds, fromSeconds);
  db.prepare(`
    INSERT INTO sales (
      id, invoice_number, short_invoice_number, subtotal_paisa, total_paisa,
      payment_method, cashier_name, created_at
    ) VALUES (?, ?, ?, ?, ?, 'CASH', 'Profit Admin', ?)
  `).run('included-sale', 'INV-PROFIT-1', 'PROFIT-1', 30000, 30000, fromSeconds + 3600);
  db.prepare(`
    INSERT INTO sale_items (
      id, sale_id, medicine_id, medicine_name, generic_name, drug_class, unit_name,
      conversion_factor, quantity_in_unit, mrp_paisa_per_unit, cost_paisa_per_unit,
      discount_percent, line_total_paisa, created_at
    ) VALUES (
      'included-sale-item', 'included-sale', 'profit-medicine', 'Profit Medicine',
      'Test Generic', 'OTC', 'Tablet', 1, 1, 10000, 6000, 0, 10000, ?
    )
  `).run(fromSeconds + 3600);
  db.prepare(`
    INSERT INTO stock_batches (
      id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa,
      mrp_paisa, quantity_smallest_unit, created_at, updated_at
    ) VALUES ('profit-batch', 'profit-medicine', 'BATCH-1', '2027-12-31', '2026-01-01', 6000, 10000, 2, ?, ?)
  `).run(fromSeconds, fromSeconds);
  db.prepare(`
    INSERT INTO sale_items (
      id, sale_id, medicine_id, medicine_name, generic_name, drug_class, unit_name,
      conversion_factor, quantity_in_unit, mrp_paisa_per_unit, cost_paisa_per_unit,
      discount_percent, line_total_paisa, created_at
    ) VALUES (
      'returned-sale-item', 'included-sale', 'profit-medicine', 'Profit Medicine',
      'Test Generic', 'OTC', 'Tablet', 1, 2, 10000, 6000, 0, 20000, ?
    )
  `).run(fromSeconds + 3600);
  db.prepare(`
    INSERT INTO sale_item_batch_allocations (
      id, sale_item_id, batch_id, batch_number, expiry_date, quantity_smallest_unit,
      cost_price_paisa, created_at
    ) VALUES ('profit-allocation', 'returned-sale-item', 'profit-batch', 'BATCH-1', '2027-12-31', 2, 6000, ?)
  `).run(fromSeconds + 3600);
  db.prepare(`
    INSERT INTO sale_returns (
      id, return_number, sale_id, invoice_number, reason, total_refund_paisa,
      payment_method, created_at
    ) VALUES ('profit-return', 'RET-PROFIT-1', 'included-sale', 'INV-PROFIT-1', 'Test return', 10000, 'CASH', ?)
  `).run(fromSeconds + 7200);
  db.prepare(`
    INSERT INTO sale_return_items (
      id, return_id, sale_item_id, batch_id, quantity_smallest_unit, refund_paisa, created_at
    ) VALUES (
      'profit-return-item', 'profit-return', 'returned-sale-item', 'profit-batch', 1, 10000, ?
    )
  `).run(fromSeconds + 7200);
  db.prepare(`
    INSERT INTO sales (
      id, invoice_number, short_invoice_number, subtotal_paisa, total_paisa,
      payment_method, cashier_name, created_at
    ) VALUES (?, ?, ?, ?, ?, 'CASH', 'Profit Admin', ?)
  `).run('exclusive-sale', 'INV-PROFIT-2', 'PROFIT-2', 50000, 50000, toSeconds);

  const response = await app.inject({
    method: 'GET',
    url: `/api/reports/profit-summary?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    headers,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    revenuePaisa: 20000,
    costPaisa: 12000,
    grossProfitPaisa: 8000,
    orderCount: 1,
    daily: [{
      date: '2026-11-22',
      revenuePaisa: 20000,
      costPaisa: 12000,
      orderCount: 1,
      grossProfitPaisa: 8000,
    }],
  });
});
