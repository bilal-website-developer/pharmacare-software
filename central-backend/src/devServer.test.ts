import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDevelopmentLicensingServer } from './devServer.js';
import { hashActivationCode } from './licensingCrypto.js';

test('local development central activates once and renews only the bound device', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacare-central-dev-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const activationCode = 'DEVELOPMENT-CODE-ONCE';
  fs.writeFileSync(path.join(configDir, 'license-private.pem'), privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }));
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({
    shopId: 'dev-shop-id',
    shopName: 'Local Dev Pharmacy',
    shopStatus: 'ACTIVE',
    licenseStatus: 'ACTIVE',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    graceDays: 30,
    activationCodeHash: hashActivationCode(activationCode),
    activationUsed: false,
    hardwareId: null,
  }));
  const app = buildDevelopmentLicensingServer(configDir);
  t.after(async () => {
    await app.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const hardwareId = 'a'.repeat(64);
  const activation = await app.inject({
    method: 'POST',
    url: '/api/licensing/activate',
    payload: { activationCode, hardwareId },
  });
  assert.equal(activation.statusCode, 200);
  const activationResult = activation.json();
  assert.equal(activationResult.shop.shop_name, 'Local Dev Pharmacy');
  const [header, payload, signature] = activationResult.licenseToken.split('.');
  assert.equal(crypto.verify(
    null,
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  ), true);

  const reused = await app.inject({
    method: 'POST',
    url: '/api/licensing/activate',
    payload: { activationCode, hardwareId },
  });
  assert.equal(reused.statusCode, 403);

  const wrongDevice = await app.inject({
    method: 'POST',
    url: '/api/licensing/check-in',
    payload: { shopId: 'dev-shop-id', hardwareId: 'b'.repeat(64) },
  });
  assert.equal(wrongDevice.statusCode, 403);

  const checkin = await app.inject({
    method: 'POST',
    url: '/api/licensing/check-in',
    payload: { shopId: 'dev-shop-id', hardwareId },
  });
  assert.equal(checkin.statusCode, 200);
  assert.equal(typeof checkin.json().licenseToken, 'string');
});
