export const LICENSE_PAGE_KEYS = [
  'pos',
  'products',
  'categories',
  'suppliers',
  'customers',
  'sales_history',
  'purchase_history',
  'purchases',
  'expenses',
  'stock_inventory',
  'reports',
  'manage_users',
  'settings',
] as const;

export const LICENSE_FEATURE_KEYS = [
  'pos_print_sale',
  'pos_print_payment',
  'settings_shop_profile',
  'settings_receipt_memo',
  'settings_receipt_qr',
  'settings_operations',
  'settings_demo_data',
  'settings_whatsapp_templates',
] as const;

export type LicensePageKey = typeof LICENSE_PAGE_KEYS[number];
export type LicenseFeatureKey = typeof LICENSE_FEATURE_KEYS[number];

export interface LicenseAccess {
  enabledPages: LicensePageKey[];
  enabledFeatures: LicenseFeatureKey[];
}

function normalizeKeys<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (value === undefined || value === null) return [...allowed];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry as T))) {
    return null;
  }
  return [...new Set(value as T[])];
}

export function normalizeLicenseAccess(
  enabledPages: unknown,
  enabledFeatures: unknown,
): LicenseAccess | null {
  const pages = normalizeKeys(enabledPages, LICENSE_PAGE_KEYS);
  const features = normalizeKeys(enabledFeatures, LICENSE_FEATURE_KEYS);
  return pages && features ? { enabledPages: pages, enabledFeatures: features } : null;
}

export const DEFAULT_LICENSE_ACCESS = normalizeLicenseAccess(undefined, undefined)!;
