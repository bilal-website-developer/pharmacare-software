import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { normalizeLicenseAccess, type LicensePageKey, type LicenseFeatureKey } from './entitlementModel.js';

export interface LicenseClaims {
  shopId: string;
  shopName: string;
  expiresAt: string;
  hardwareId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  graceDays: number;
  warningDays?: number;
  enabledPages?: LicensePageKey[];
  enabledFeatures?: LicenseFeatureKey[];
}

export function createActivationCode(): string {
  return randomBytes(24).toString('hex').toUpperCase();
}

export function hashActivationCode(activationCode: string): string {
  return createHash('sha256').update(activationCode).digest('hex');
}

export function signLicenseToken(claims: LicenseClaims, privateKey: string): string {
  if (!privateKey) throw new Error('CENTRAL_LICENSE_PRIVATE_KEY is not configured.');
  const access = normalizeLicenseAccess(claims.enabledPages, claims.enabledFeatures);
  if (!access) throw new Error('License contains an invalid page or feature entitlement.');
  const parsedPrivateKey = createPrivateKey(privateKey);
  if (parsedPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('CENTRAL_LICENSE_PRIVATE_KEY must be an Ed25519 private key.');
  }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const warningDays = claims.warningDays ?? Math.min(14, claims.graceDays);
  if (
    !Number.isInteger(claims.graceDays) || claims.graceDays < 1 || claims.graceDays > 365
    || !Number.isInteger(warningDays) || warningDays < 1 || warningDays > claims.graceDays
  ) {
    throw new Error('License offline warning and grace periods are invalid.');
  }
  const payload = Buffer.from(JSON.stringify({ ...claims, warningDays, ...access })).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`),
    parsedPrivateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
