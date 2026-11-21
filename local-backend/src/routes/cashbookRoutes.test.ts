import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../server';
import { activateShopLicense } from '../services/licenseService';
import { createLocalUser } from '../services/authService';

test('cashbook expenses persist and reload from the local database', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  const originalPublicKey = process.env.CENTRAL_LICENSE_PUBLIC_KEY;
  const originalHardwareId = process.env.PHARMA_HARDWARE_ID;
  const keyPair = crypto.generateKeyPairSync('ed25519');
  process.env.DATABASE_KEY = 'f'.repeat(64);
  process.env.CENTRAL_LICENSE_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.PHARMA_HARDWARE_ID = 'cashbook-test-device';
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-cashbook-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
    process.env.CENTRAL_LICENSE_PUBLIC_KEY = originalPublicKey;
    process.env.PHARMA_HARDWARE_ID = originalHardwareId;
  });

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    shopId: 'cashbook-test-shop',
    shopName: 'Cashbook Test Pharmacy',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    hardwareId: process.env.PHARMA_HARDWARE_ID,
    status: 'ACTIVE',
    graceDays: 30,
  })).toString('base64url');
  const content = `${header}.${payload}`;
  const licenseToken = `${content}.${crypto.sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
  activateShopLicense(db, {
    shopId: 'cashbook-test-shop',
    shopName: 'Cashbook Test Pharmacy',
    licenseToken,
    hardwareId: process.env.PHARMA_HARDWARE_ID!,
  });
  const admin = await createLocalUser(db, {
    username: 'cashbookadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({
      userId: admin.id, username: admin.username, role: admin.role, permissions: ['expenses'],
    })}`,
  };

  const created = await app.inject({
    method: 'POST',
    url: '/api/cashbook/transactions',
    headers,
    payload: {
      description: 'Utilities',
      amountPaisa: 250000,
      isOutflow: true,
      type: 'EXPENSE',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().amountPaisa, 250000);
  const reloaded = await app.inject({
    method: 'GET',
    url: '/api/cashbook/transactions',
    headers,
  });
  assert.equal(reloaded.statusCode, 200, reloaded.body);
  assert.equal(reloaded.json().length, 1);
  assert.equal(reloaded.json()[0].description, 'Utilities');
});
