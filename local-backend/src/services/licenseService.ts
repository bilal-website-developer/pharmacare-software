import Database from 'better-sqlite3-multiple-ciphers';
import { verify } from 'node:crypto';

export interface LicenseClaims {
  shopId: string;
  shopName: string;
  expiresAt: string;
  hardwareId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  graceDays: number;
}

export function verifyLicenseToken(
  token: string,
  publicKey: string,
  expectedHardwareId: string,
): LicenseClaims | null {
  if (!publicKey || !expectedHardwareId || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; typ?: string };
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') return null;
    const signatureIsValid = verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!signatureIsValid) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<LicenseClaims>;
    const expiry = typeof claims.expiresAt === 'string' ? Date.parse(claims.expiresAt) : NaN;
    if (
      typeof claims.shopId !== 'string' || !claims.shopId
      || typeof claims.shopName !== 'string' || !claims.shopName
      || typeof claims.hardwareId !== 'string' || claims.hardwareId !== expectedHardwareId
      || !Number.isFinite(expiry)
      || !['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(claims.status || '')
      || !Number.isInteger(claims.graceDays) || (claims.graceDays as number) < 1 || (claims.graceDays as number) > 365
    ) return null;
    return claims as LicenseClaims;
  } catch {
    return null;
  }
}

export interface LicenseStatusResult {
  isActivated: boolean;
  status: 'UNACTIVATED' | 'ACTIVE' | 'WARNING' | 'RESTRICTED' | 'CLOCK_TAMPERED';
  shopId: string;
  shopName: string;
  daysRemainingGrace: number;
  message?: string;
  allowNewTransactions: boolean;
}

export function checkLicenseStatus(
  db: Database.Database,
  options: { publicKey?: string; hardwareId?: string; now?: number } = {},
): LicenseStatusResult {
  const store = db.prepare('SELECT * FROM license_store WHERE id = 1').get() as any;
  if (!store || !store.license_token || store.status === 'UNACTIVATED') {
    return {
      isActivated: false,
      status: 'UNACTIVATED',
      shopId: '',
      shopName: '',
      daysRemainingGrace: 0,
      message: 'This application requires activation before use.',
      allowNewTransactions: false,
    };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims = verifyLicenseToken(
    store.license_token,
    options.publicKey ?? process.env.CENTRAL_LICENSE_PUBLIC_KEY ?? '',
    options.hardwareId ?? process.env.PHARMA_HARDWARE_ID ?? '',
  );
  if (
    !claims
    || claims.shopId !== store.shop_id
    || claims.shopName !== store.shop_name
    || claims.hardwareId !== store.hardware_id
  ) {
    return {
      isActivated: true,
      status: 'RESTRICTED',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace: 0,
      message: 'The saved license signature or device binding could not be verified. Contact support.',
      allowNewTransactions: false,
    };
  }

  const expiresAt = Math.floor(Date.parse(claims.expiresAt) / 1000);
  if (expiresAt <= now) {
    return {
      isActivated: true,
      status: 'RESTRICTED',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace: 0,
      message: 'This pharmacy license has expired. Contact your administrator to renew it.',
      allowNewTransactions: false,
    };
  }
  if (claims.status !== 'ACTIVE') {
    return {
      isActivated: true,
      status: 'RESTRICTED',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace: 0,
      message: `This pharmacy license is ${claims.status.toLowerCase()}. Contact your administrator.`,
      allowNewTransactions: false,
    };
  }

  // Anti-Clock Tampering Check: System time must not be before stored high-water mark
  if (now < store.last_system_time) {
    return {
      isActivated: true,
      status: 'CLOCK_TAMPERED',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace: 0,
      message: 'System clock rollback detected. Please correct your system date and time to continue.',
      allowNewTransactions: false,
    };
  }

  // Update high-water mark
  db.prepare('UPDATE license_store SET last_system_time = ? WHERE id = 1').run(now);

  const secondsSinceOnline = Math.max(0, now - store.last_verified_online);
  const graceTotal = claims.graceDays * 86400;
  const warningThreshold = 14 * 86400; // 14 days

  const secondsRemaining = Math.max(0, graceTotal - secondsSinceOnline);
  const daysRemainingGrace = Math.floor(secondsRemaining / 86400);

  if (secondsSinceOnline > graceTotal) {
    return {
      isActivated: true,
      status: 'RESTRICTED',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace: 0,
      message: 'Offline grace period exceeded. Please connect to the internet to verify your license.',
      allowNewTransactions: false,
    };
  }

  if (secondsSinceOnline > warningThreshold) {
    return {
      isActivated: true,
      status: 'WARNING',
      shopId: store.shop_id,
      shopName: store.shop_name,
      daysRemainingGrace,
      message: `License check-in pending. ${daysRemainingGrace} days remaining in offline grace period.`,
      allowNewTransactions: true,
    };
  }

  return {
    isActivated: true,
    status: 'ACTIVE',
    shopId: store.shop_id,
    shopName: store.shop_name,
    daysRemainingGrace,
    allowNewTransactions: true,
  };
}

export function activateShopLicense(
  db: Database.Database,
  data: {
    shopId: string;
    shopName: string;
    licenseToken: string;
    hardwareId: string;
  }
): void {
  const now = Math.floor(Date.now() / 1000);
  const claims = verifyLicenseToken(
    data.licenseToken,
    process.env.CENTRAL_LICENSE_PUBLIC_KEY || '',
    process.env.PHARMA_HARDWARE_ID || '',
  );
  if (
    !claims
    || claims.shopId !== data.shopId
    || claims.shopName !== data.shopName
    || claims.hardwareId !== data.hardwareId
    || claims.status !== 'ACTIVE'
    || Math.floor(Date.parse(claims.expiresAt) / 1000) <= now
  ) {
    throw new Error('The activation response contains an invalid, expired, or device-mismatched license.');
  }

  db.prepare(`
    UPDATE license_store
    SET shop_id = ?,
        shop_name = ?,
        license_token = ?,
        hardware_id = ?,
        last_verified_online = ?,
        last_system_time = ?,
        offline_grace_seconds = ?,
        status = 'ACTIVE'
    WHERE id = 1
  `).run(
    data.shopId,
    data.shopName,
    data.licenseToken,
    data.hardwareId,
    now,
    now,
    claims.graceDays * 86400
  );

  // Update shop_settings shop name as well
  db.prepare(`
    UPDATE shop_settings
    SET shop_name = ?, updated_at = ?
    WHERE id = 1
  `).run(data.shopName, now);
}

export function recordSuccessfulCheckin(db: Database.Database, licenseToken: string, hardwareId: string): void {
  const now = Math.floor(Date.now() / 1000);
  const store = db.prepare('SELECT shop_id, shop_name, hardware_id FROM license_store WHERE id = 1').get() as {
    shop_id: string; shop_name: string; hardware_id: string;
  };
  const claims = verifyLicenseToken(
    licenseToken,
    process.env.CENTRAL_LICENSE_PUBLIC_KEY || '',
    process.env.PHARMA_HARDWARE_ID || '',
  );
  if (
    !claims
    || claims.shopId !== store.shop_id
    || claims.shopName !== store.shop_name
    || claims.hardwareId !== hardwareId
    || store.hardware_id !== hardwareId
  ) {
    throw new Error('The license check-in signature or device binding could not be verified.');
  }
  db.prepare(`
    UPDATE license_store
    SET license_token = ?,
        offline_grace_seconds = ?,
        last_verified_online = ?,
        last_system_time = ?,
        status = 'ACTIVE'
    WHERE id = 1
  `).run(licenseToken, claims.graceDays * 86400, now, now);
}
