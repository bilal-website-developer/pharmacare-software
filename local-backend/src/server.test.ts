import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildServer } from './server';
import { backupDatabase, createDatabaseConnection, restoreDatabase } from './db/database';
import { initializeSchema } from './db/schema';
import { createLocalUser, authenticateLocalUser } from './services/authService';
import { allocateFefoStock } from './services/fefoEngine';
import { canViewCost } from './services/costRedactor';
import { activateShopLicense, checkLicenseStatus, recordSuccessfulCheckin } from './services/licenseService';
import { LICENSE_PAGE_KEYS } from './services/licenseAccess';

const licenseKeyPair = generateKeyPairSync('ed25519');
process.env.CENTRAL_LICENSE_PUBLIC_KEY = licenseKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.PHARMA_HARDWARE_ID = 'HW-UUID-1234';

function createTestLicenseToken(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    shopId: 'shop-test-uuid',
    shopName: 'Test Pharmacy Shop',
    expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
    hardwareId: process.env.PHARMA_HARDWARE_ID,
    status: 'ACTIVE',
    graceDays: 30,
    ...overrides,
  })).toString('base64url');
  const content = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(content), licenseKeyPair.privateKey).toString('base64url');
  return `${content}.${signature}`;
}

test('Phase 1: Local Backend & SQLite Core Verification', async (t) => {
  process.env.DATABASE_KEY = 'a'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-local-jwt-secret' });
  await app.ready();
  let adminId = '';

  await t.test('1. Schema initializes with all tables and singletons', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = (tables as any[]).map((t) => t.name);

    assert.ok(tableNames.includes('users'));
    assert.ok(tableNames.includes('medicines'));
    assert.ok(tableNames.includes('stock_batches'));
    assert.ok(tableNames.includes('sales'));
    assert.ok(tableNames.includes('sale_items'));
    assert.ok(tableNames.includes('sale_item_batch_allocations'));
    assert.ok(tableNames.includes('cash_transactions'));
    assert.ok(tableNames.includes('shop_settings'));
    assert.ok(tableNames.includes('license_store'));
  });

  await t.test('2. Argon2id password hashing and offline authentication', async () => {
    const adminUser = await createLocalUser(db, {
      username: 'shopadmin',
      plainTextPassword: 'SecureAdminPassword123!',
      role: 'admin',
      fullName: 'Shop Administrator',
      permissions: ['pos', 'products', 'reports', 'settings'],
    });

    adminId = adminUser.id;
    assert.equal(adminUser.username, 'shopadmin');
    assert.equal(adminUser.role, 'admin');

    // Authenticate with valid password
    const authProfile = await authenticateLocalUser(db, 'shopadmin', 'SecureAdminPassword123!');
    assert.equal(authProfile.id, adminUser.id);

    // Reject invalid password
    await assert.rejects(
      () => authenticateLocalUser(db, 'shopadmin', 'WrongPassword!'),
      /Invalid username or password/
    );
  });

  await t.test('3. Protected API routes enforce login and module permissions', async () => {
    const cashier = await createLocalUser(db, {
      username: 'checkoutuser',
      plainTextPassword: 'SecureCashierPassword123!',
      role: 'cashier',
      fullName: 'Checkout User',
      permissions: ['pos'],
    });
    const token = app.jwt.sign({
      userId: cashier.id,
      username: cashier.username,
      role: cashier.role,
      permissions: cashier.permissions,
    });
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/pos/catalog' });
    assert.equal(unauthenticated.statusCode, 401);
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/pos/catalog',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(catalog.statusCode, 200);
    const deniedWrite = await app.inject({
      method: 'POST',
      url: '/api/inventory/products',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(deniedWrite.statusCode, 403);
  });

  await t.test('3a. Protected routes use current database role and permissions, not stale JWT claims', async () => {
    const user = await createLocalUser(db, {
      username: 'staleclaimuser',
      plainTextPassword: 'SecureManagerPassword123!',
      role: 'manager',
      fullName: 'Manager with stale token',
      permissions: ['settings'],
    });
    const stalePermissionToken = app.jwt.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: ['settings'],
    });
    const missingPermissionToken = app.jwt.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
    });
    const staleRoleToken = app.jwt.sign({
      userId: user.id,
      username: user.username,
      role: 'admin',
      permissions: ['settings'],
    });
    db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run('[]', user.id);
    const missingPermissionResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/shop',
      headers: { authorization: `Bearer ${missingPermissionToken}` },
    });
    assert.equal(missingPermissionResponse.statusCode, 401);
    const stalePermissionResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/shop',
      headers: { authorization: `Bearer ${stalePermissionToken}` },
    });
    assert.equal(stalePermissionResponse.statusCode, 401);
    const staleRoleResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/shop',
      headers: { authorization: `Bearer ${staleRoleToken}` },
    });
    assert.equal(staleRoleResponse.statusCode, 401);
    const inactiveToken = app.jwt.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: [],
    });
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    const inactiveResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/shop',
      headers: { authorization: `Bearer ${inactiveToken}` },
    });
    assert.equal(inactiveResponse.statusCode, 401);
  });

  await t.test('4. Existing local user data migrates to the Seller role safely', () => {
    const legacyDb = createDatabaseConnection(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          full_name TEXT,
          email TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'cashier', 'accountant')),
          permissions TEXT NOT NULL DEFAULT '[]',
          is_active INTEGER NOT NULL DEFAULT 1,
          deleted_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE retained_user_reference (user_id TEXT REFERENCES users(id));
        INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
        VALUES ('legacy-admin', 'legacy', 'hash', 'admin', 1, 1);
        INSERT INTO retained_user_reference (user_id) VALUES ('legacy-admin');
      `);
      initializeSchema(legacyDb);
      legacyDb.prepare(`
        INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
        VALUES ('seller-user', 'seller', 'hash', 'seller', 2, 2)
      `).run();
      assert.equal((legacyDb.prepare('SELECT username FROM users WHERE id = ?').get('legacy-admin') as { username: string }).username, 'legacy');
      assert.equal((legacyDb.pragma('foreign_key_check') as unknown[]).length, 0);
      assert.equal((legacyDb.prepare('SELECT version FROM schema_migrations WHERE version = 2').get() as { version: number }).version, 2);
    } finally {
      legacyDb.close();
    }
  });

  await t.test('5. License status and offline grace period', async () => {
    // Initially unactivated
    const initialStatus = checkLicenseStatus(db);
    assert.equal(initialStatus.status, 'UNACTIVATED');
    assert.equal(initialStatus.allowNewTransactions, false);

    assert.throws(() => activateShopLicense(db, {
      shopId: 'shop-test-uuid',
      shopName: 'Test Pharmacy Shop',
      licenseToken: 'unsigned-token',
      hardwareId: 'HW-UUID-1234',
    }), /invalid, expired, or device-mismatched/i);
    assert.equal(checkLicenseStatus(db).status, 'UNACTIVATED');

    // Activate shop
    activateShopLicense(db, {
      shopId: 'shop-test-uuid',
      shopName: 'Test Pharmacy Shop',
      licenseToken: createTestLicenseToken(),
      hardwareId: 'HW-UUID-1234',
    });

    const activeStatus = checkLicenseStatus(db);
    assert.equal(activeStatus.status, 'ACTIVE');
    assert.equal(activeStatus.allowNewTransactions, true);
    assert.equal(activeStatus.shopName, 'Test Pharmacy Shop');
    assert.deepEqual(activeStatus.enabledPages, LICENSE_PAGE_KEYS);

    recordSuccessfulCheckin(db, createTestLicenseToken({
      enabledPages: ['pos'],
      enabledFeatures: [],
    }), 'HW-UUID-1234');
    const limitedStatus = checkLicenseStatus(db);
    assert.deepEqual(limitedStatus.enabledPages, ['pos']);
    assert.deepEqual(limitedStatus.enabledFeatures, []);
    const adminToken = app.jwt.sign({
      userId: adminId,
      username: 'shopadmin',
      role: 'admin',
      permissions: [],
    });
    const planDenied = await app.inject({
      method: 'GET',
      url: '/api/suppliers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(planDenied.statusCode, 403);
    assert.match(planDenied.json().error, /not included in the pharmacy license plan/i);
    recordSuccessfulCheckin(db, createTestLicenseToken({
      graceDays: 10,
      warningDays: 3,
    }), 'HW-UUID-1234');
    db.prepare('UPDATE license_store SET last_verified_online = ? WHERE id = 1')
      .run(Math.floor(Date.now() / 1000) - 7 * 86400);
    assert.equal(checkLicenseStatus(db).status, 'WARNING');
    db.prepare('UPDATE license_store SET last_verified_online = ? WHERE id = 1')
      .run(Math.floor(Date.now() / 1000) - 10 * 86400);
    assert.equal(checkLicenseStatus(db).status, 'RESTRICTED');
    db.prepare('UPDATE license_store SET last_verified_online = ? WHERE id = 1')
      .run(Math.floor(Date.now() / 1000) - 10 * 86400 - 1);
    assert.equal(checkLicenseStatus(db).status, 'RESTRICTED');
    recordSuccessfulCheckin(db, createTestLicenseToken(), 'HW-UUID-1234');

    const storedToken = (db.prepare('SELECT license_token FROM license_store WHERE id = 1').get() as { license_token: string }).license_token;
    db.prepare('UPDATE license_store SET license_token = ? WHERE id = 1')
      .run(createTestLicenseToken({ expiresAt: new Date(Date.now() - 86400000).toISOString() }));
    assert.match(checkLicenseStatus(db).message || '', /expired/i);

    db.prepare('UPDATE license_store SET license_token = ? WHERE id = 1')
      .run(createTestLicenseToken({ hardwareId: 'another-device' }));
    assert.match(checkLicenseStatus(db).message || '', /signature or device binding/i);

    const [header, payload, signature] = storedToken.split('.');
    const corruptedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    db.prepare('UPDATE license_store SET license_token = ? WHERE id = 1')
      .run(`${header}.${payload}.${corruptedSignature}`);
    assert.match(checkLicenseStatus(db).message || '', /signature or device binding/i);

    db.prepare('UPDATE license_store SET license_token = ? WHERE id = 1').run(storedToken);
    db.prepare('UPDATE license_store SET last_verified_online = ? WHERE id = 1')
      .run(Math.floor(Date.now() / 1000) - 31 * 86400);
    assert.equal(checkLicenseStatus(db).status, 'RESTRICTED');

    recordSuccessfulCheckin(db, createTestLicenseToken({ status: 'SUSPENDED' }), 'HW-UUID-1234');
    const suspendedStatus = checkLicenseStatus(db);
    assert.equal(suspendedStatus.allowNewTransactions, false);
    assert.match(suspendedStatus.message || '', /suspended/i);
    recordSuccessfulCheckin(db, createTestLicenseToken(), 'HW-UUID-1234');
  });

  await t.test('6. FEFO Stock Allocation engine', () => {
    const now = Math.floor(Date.now() / 1000);
    // Insert test medicine
    db.prepare(`
      INSERT INTO medicines (id, code, brand_name, generic_name, drug_class, is_active, created_at, updated_at)
      VALUES ('med-panadol', 'MED-PAN-01', 'Panadol 500mg', 'Paracetamol', 'OTC', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO medicine_units (id, medicine_id, name, conversion_factor, is_default_sale_unit, price_per_unit_paisa, created_at, updated_at)
      VALUES ('unit-panadol', 'med-panadol', 'Tablet', 1, 1, 150, ?, ?)
    `).run(now, now);

    // Insert two batches: batch-later (expires 2027), batch-earlier (expires 2026-12-01)
    db.prepare(`
      INSERT INTO stock_batches (id, medicine_id, batch_number, expiry_date, received_date, cost_price_paisa, mrp_paisa, quantity_smallest_unit, status, created_at, updated_at)
      VALUES ('batch-2', 'med-panadol', 'B2027', '2027-06-01', '2026-01-01', 100, 150, 100, 'ACTIVE', ?, ?),
             ('batch-1', 'med-panadol', 'B2026', '2026-12-01', '2026-01-01', 90, 150, 50, 'ACTIVE', ?, ?)
    `).run(now, now, now, now);

    // Allocate 70 units: should take all 50 from batch-1 (expires earlier) and 20 from batch-2
    const allocations = allocateFefoStock(db, 'med-panadol', 70, '2026-11-21');
    assert.equal(allocations.length, 2);
    assert.equal(allocations[0].batchId, 'batch-1');
    assert.equal(allocations[0].quantitySmallestUnit, 50);
    assert.equal(allocations[1].batchId, 'batch-2');
    assert.equal(allocations[1].quantitySmallestUnit, 20);

    // Check remaining in DB
    const b1 = db.prepare('SELECT quantity_smallest_unit FROM stock_batches WHERE id = ?').get('batch-1') as any;
    const b2 = db.prepare('SELECT quantity_smallest_unit FROM stock_batches WHERE id = ?').get('batch-2') as any;
    assert.equal(b1.quantity_smallest_unit, 0);
    assert.equal(b2.quantity_smallest_unit, 80);
  });

  await t.test('7. POS sale commits inventory, payment, and audit records', async () => {
    const admin = db.prepare('SELECT username, role, permissions FROM users WHERE id = ?').get(adminId) as {
      username: string;
      role: string;
      permissions: string;
    };
    const token = app.jwt.sign({
      userId: adminId,
      username: admin.username,
      role: admin.role,
      permissions: JSON.parse(admin.permissions),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/pos/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerId: null,
        customerName: 'Walk-in Customer',
        customerType: 'WALK_IN',
        items: [{ medicineId: 'med-panadol', unitId: 'unit-panadol', quantityInUnit: 1 }],
        discountPaisa: 0,
        roundingPaisa: 0,
        tenderedPaisa: 150,
        payments: [{ paymentMethod: 'CASH', amountPaisa: 150 }],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const sale = response.json();
    assert.equal(sale.totalPaisa, 150);
    assert.equal(sale.items[0].batchNumber, 'B2027');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'SALE_POSTED'").get() as { count: number }).count, 1);
  });

  await t.test('7a. Seller discounts are capped using the cashier setting', async () => {
    const seller = await createLocalUser(db, {
      username: 'selleruser',
      plainTextPassword: 'SecureSellerPassword123!',
      role: 'seller',
      fullName: 'Seller User',
      permissions: ['pos'],
    });
    const token = app.jwt.sign({
      userId: seller.id,
      username: seller.username,
      role: seller.role,
      permissions: seller.permissions,
    });
    const checkout = (discountPaisa: number, amountPaisa: number) => app.inject({
      method: 'POST',
      url: '/api/pos/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerId: null,
        customerName: 'Walk-in Customer',
        customerType: 'WALK_IN',
        items: [{ medicineId: 'med-panadol', unitId: 'unit-panadol', quantityInUnit: 1 }],
        discountPaisa,
        roundingPaisa: 0,
        tenderedPaisa: amountPaisa,
        payments: [{ paymentMethod: 'CASH', amountPaisa }],
      },
    });

    const overCap = await checkout(16, 134);
    assert.equal(overCap.statusCode, 403);
    assert.match(overCap.json().error, /discount exceeds the permission/i);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }).count, 1);

    const atCap = await checkout(15, 135);
    assert.equal(atCap.statusCode, 201, atCap.body);
    assert.equal(atCap.json().discountPaisa, 15);
  });

  await t.test('7b. Non-admin roles cannot read shop settings even with the module grant', async () => {
    const manager = await createLocalUser(db, {
      username: 'settingsmanager',
      plainTextPassword: 'SecureManagerPassword123!',
      role: 'manager',
      fullName: 'Settings Manager',
      permissions: ['settings'],
    });
    const token = app.jwt.sign({
      userId: manager.id,
      username: manager.username,
      role: manager.role,
      permissions: manager.permissions,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/shop',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 403);
  });

  await t.test('8. Cost Redaction for Cashier role', () => {
    assert.equal(canViewCost('cashier', ['pos']), false);
    assert.equal(canViewCost('admin', []), true);
    assert.equal(canViewCost('manager', []), true);
    assert.equal(canViewCost('accountant', ['reports']), true);
  });

  await t.test('9. File database and backups are encrypted and reject a wrong key', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-encrypted-db-'));
    const databasePath = path.join(directory, 'pharmadata.db');
    const originalKey = process.env.DATABASE_KEY;
    let fileDb: ReturnType<typeof createDatabaseConnection> | null = null;
    try {
      process.env.DATABASE_KEY = 'b'.repeat(64);
      fileDb = createDatabaseConnection(databasePath);
      initializeSchema(fileDb);
      fileDb.exec('CREATE TABLE encryption_probe (value TEXT NOT NULL); INSERT INTO encryption_probe VALUES (\'saved\')');
      const backupPath = await backupDatabase(fileDb, directory);
      fileDb.close();
      fileDb = null;

      const encryptedHeader = fs.readFileSync(databasePath).subarray(0, 16).toString('ascii');
      assert.notEqual(encryptedHeader, 'SQLite format 3\u0000');

      const backupHeader = fs.readFileSync(backupPath).subarray(0, 16).toString('ascii');
      assert.notEqual(backupHeader, 'SQLite format 3\u0000');
      fileDb = createDatabaseConnection(backupPath);
      assert.equal((fileDb.prepare('SELECT value FROM encryption_probe').get() as { value: string }).value, 'saved');
      fileDb.close();
      fileDb = null;

      const restorePath = path.join(directory, 'restored.db');
      fileDb = createDatabaseConnection(restorePath);
      initializeSchema(fileDb);
      fileDb.exec('CREATE TABLE encryption_probe (value TEXT NOT NULL); INSERT INTO encryption_probe VALUES (\'old\')');
      fileDb.close();
      fileDb = null;
      await restoreDatabase(backupPath, restorePath);
      fileDb = createDatabaseConnection(restorePath);
      assert.equal((fileDb.prepare('SELECT value FROM encryption_probe').get() as { value: string }).value, 'saved');
      fileDb.close();
      fileDb = null;

      process.env.DATABASE_KEY = 'c'.repeat(64);
      assert.throws(() => createDatabaseConnection(databasePath));
    } finally {
      fileDb?.close();
      process.env.DATABASE_KEY = originalKey;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await app.close();
});
