import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createActivationCode, hashActivationCode, signLicenseToken } from './licensingCrypto.js';

test('activation codes are random 192-bit uppercase hex values', () => {
  const first = createActivationCode();
  const second = createActivationCode();
  assert.match(first, /^[A-F0-9]{48}$/);
  assert.notEqual(first, second);
});

test('activation codes are stored as SHA-256 hashes, not plaintext', () => {
  const activationCode = 'abc';
  const hash = hashActivationCode(activationCode);
  assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(hash, activationCode);
});

test('license token signs the expected claims with the configured secret', () => {
  const claims = {
    shopId: 'shop-1',
    shopName: 'Sample Pharmacy',
    expiresAt: '2027-01-01T00:00:00.000Z',
    hardwareId: 'device-hash',
  };
  const token = signLicenseToken(claims, 'test-secret');
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
    alg: 'HS256',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), claims);
  assert.equal(
    signature,
    createHmac('sha256', 'test-secret').update(`${header}.${payload}`).digest('base64url'),
  );
  assert.throws(() => signLicenseToken(claims, ''), /CENTRAL_JWT_SECRET/);
});
