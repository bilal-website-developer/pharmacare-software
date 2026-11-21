import Database from 'better-sqlite3-multiple-ciphers';

export interface LicenseStatusResult {
  isActivated: boolean;
  status: 'UNACTIVATED' | 'ACTIVE' | 'WARNING' | 'RESTRICTED' | 'CLOCK_TAMPERED';
  shopId: string;
  shopName: string;
  daysRemainingGrace: number;
  message?: string;
  allowNewTransactions: boolean;
}

export function checkLicenseStatus(db: Database.Database): LicenseStatusResult {
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

  const now = Math.floor(Date.now() / 1000);

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
  const graceTotal = store.offline_grace_seconds || 2592000; // 30 days default
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

  db.prepare(`
    UPDATE license_store
    SET shop_id = ?,
        shop_name = ?,
        license_token = ?,
        hardware_id = ?,
        last_verified_online = ?,
        last_system_time = ?,
        status = 'ACTIVE'
    WHERE id = 1
  `).run(
    data.shopId,
    data.shopName,
    data.licenseToken,
    data.hardwareId,
    now,
    now
  );

  // Update shop_settings shop name as well
  db.prepare(`
    UPDATE shop_settings
    SET shop_name = ?, updated_at = ?
    WHERE id = 1
  `).run(data.shopName, now);
}

export function recordSuccessfulCheckin(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE license_store
    SET last_verified_online = ?,
        last_system_time = ?,
        status = 'ACTIVE'
    WHERE id = 1
  `).run(now, now);
}
