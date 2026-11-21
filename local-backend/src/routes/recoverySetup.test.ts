import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../server';
import { initializeSchema } from '../db/schema';
import { activateShopLicense } from '../services/licenseService';
import { verifyRecoveryKey } from '../services/recoveryKey';

test('first Shop Admin setup requires and stores a recovery-key verifier', async (t) => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const originalDatabaseKey = process.env.DATABASE_KEY;
  const originalPublicKey = process.env.CENTRAL_LICENSE_PUBLIC_KEY;
  const originalHardwareId = process.env.PHARMA_HARDWARE_ID;
  process.env.DATABASE_KEY = 'd'.repeat(64);
  process.env.CENTRAL_LICENSE_PUBLIC_KEY = keyPair.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  process.env.PHARMA_HARDWARE_ID = 'f'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-recovery-setup-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
    process.env.CENTRAL_LICENSE_PUBLIC_KEY = originalPublicKey;
    process.env.PHARMA_HARDWARE_ID = originalHardwareId;
  });
  initializeSchema(db);

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    shopId: 'recovery-shop',
    shopName: 'Recovery Test Pharmacy',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    hardwareId: process.env.PHARMA_HARDWARE_ID,
    status: 'ACTIVE',
    graceDays: 30,
  })).toString('base64url');
  const content = `${header}.${payload}`;
  const token = `${content}.${crypto.sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
  activateShopLicense(db, {
    shopId: 'recovery-shop',
    shopName: 'Recovery Test Pharmacy',
    licenseToken: token,
    hardwareId: process.env.PHARMA_HARDWARE_ID!,
  });

  const basePayload = {
    username: 'owner',
    password: 'TestAdminPassword123!',
    fullName: 'Test Owner',
  };
  const missingKey = await app.inject({
    method: 'POST',
    url: '/api/auth/setup-admin',
    payload: basePayload,
  });
  assert.equal(missingKey.statusCode, 400);

  const recoveryKey = crypto.randomBytes(32).toString('base64url');
  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup-admin',
    payload: { ...basePayload, recoveryKey },
  });
  assert.equal(created.statusCode, 201, created.body);
  const verifier = db.prepare('SELECT recovery_key_verifier FROM recovery_settings WHERE id = 1').get() as {
    recovery_key_verifier: string;
  };
  assert.equal(verifyRecoveryKey(recoveryKey, verifier.recovery_key_verifier), true);
  assert.equal(verifier.recovery_key_verifier.includes(recoveryKey), false);
});
