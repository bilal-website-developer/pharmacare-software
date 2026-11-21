import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface LicenseClaims {
  shopId: string;
  shopName: string;
  expiresAt: string;
  hardwareId: string | null;
}

export function createActivationCode(): string {
  return randomBytes(24).toString('hex').toUpperCase();
}

export function hashActivationCode(activationCode: string): string {
  return createHash('sha256').update(activationCode).digest('hex');
}

export function signLicenseToken(claims: LicenseClaims, secret: string): string {
  if (!secret) throw new Error('CENTRAL_JWT_SECRET is not configured.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
