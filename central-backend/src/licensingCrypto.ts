import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

export interface LicenseClaims {
  shopId: string;
  shopName: string;
  expiresAt: string;
  hardwareId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  graceDays: number;
}

export function createActivationCode(): string {
  return randomBytes(24).toString('hex').toUpperCase();
}

export function hashActivationCode(activationCode: string): string {
  return createHash('sha256').update(activationCode).digest('hex');
}

export function signLicenseToken(claims: LicenseClaims, privateKey: string): string {
  if (!privateKey) throw new Error('CENTRAL_LICENSE_PRIVATE_KEY is not configured.');
  const parsedPrivateKey = createPrivateKey(privateKey);
  if (parsedPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('CENTRAL_LICENSE_PRIVATE_KEY must be an Ed25519 private key.');
  }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`),
    parsedPrivateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
