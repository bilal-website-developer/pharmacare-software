import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
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
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const claims = {
    shopId: 'shop-1',
    shopName: 'Sample Pharmacy',
    expiresAt: '2027-01-01T00:00:00.000Z',
    hardwareId: 'a'.repeat(64),
    status: 'ACTIVE' as const,
    graceDays: 30,
  };
  const token = signLicenseToken(claims, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
    alg: 'EdDSA',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), claims);
  assert.equal(verify(
    null,
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  ), true);
  assert.throws(
    () => signLicenseToken(claims, ''),
    /CENTRAL_LICENSE_PRIVATE_KEY/,
  );
  assert.throws(
    () => signLicenseToken(claims, 'not a private key'),
  );
});
