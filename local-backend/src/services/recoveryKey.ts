import crypto from 'node:crypto';

const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_BYTES = 32;

export function isValidRecoveryKey(value: unknown): value is string {
  return typeof value === 'string' && RECOVERY_KEY_PATTERN.test(value);
}

export function hashRecoveryKey(recoveryKey: string): string {
  if (!isValidRecoveryKey(recoveryKey)) {
    throw new Error('Recovery key must be a 32-byte URL-safe key.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(recoveryKey, salt, SCRYPT_BYTES);
  return `${salt.toString('base64')}.${hash.toString('base64')}`;
}

export function verifyRecoveryKey(recoveryKey: string, verifier: string): boolean {
  if (!isValidRecoveryKey(recoveryKey)) return false;
  const [saltValue, hashValue, extra] = verifier.split('.');
  if (!saltValue || !hashValue || extra !== undefined) return false;
  const salt = Buffer.from(saltValue, 'base64');
  const expected = Buffer.from(hashValue, 'base64');
  if (salt.length !== 16 || expected.length !== SCRYPT_BYTES) return false;
  const actual = crypto.scryptSync(recoveryKey, salt, SCRYPT_BYTES);
  return crypto.timingSafeEqual(actual, expected);
}
