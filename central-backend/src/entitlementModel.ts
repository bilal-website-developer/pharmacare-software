export const MODULES = [
  { key: 'pos', label: 'POS Billing' },
  { key: 'products', label: 'Products' },
  { key: 'categories', label: 'Categories' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'customers', label: 'Customers' },
  { key: 'sales_history', label: 'Sales History' },
  { key: 'purchase_history', label: 'Purchase History' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'stock_inventory', label: 'Stock Inventory' },
  { key: 'reports', label: 'Reports' },
  { key: 'manage_users', label: 'Manage Users' },
  { key: 'settings', label: 'Settings' },
] as const;

export const POS_PRINT_PERMISSION_KEYS = ['pos_print_sale', 'pos_print_payment'] as const;

export const SETTINGS_SECTION_PERMISSIONS = [
  { key: 'settings_shop_profile', label: 'Shop profile' },
  { key: 'settings_receipt_memo', label: 'Receipt and memo' },
  { key: 'settings_receipt_qr', label: 'Receipt QR' },
  { key: 'settings_operations', label: 'Operational limits' },
  { key: 'settings_demo_data', label: 'Demo data' },
  { key: 'settings_whatsapp_templates', label: 'WhatsApp templates' },
] as const;

export type LicensePageKey = (typeof MODULES)[number]['key'];
export type LicenseFeatureKey = typeof POS_PRINT_PERMISSION_KEYS[number]
  | typeof SETTINGS_SECTION_PERMISSIONS[number]['key'];
export interface LicenseAccess {
  enabledPages: LicensePageKey[];
  enabledFeatures: LicenseFeatureKey[];
}

export const ALL_LICENSE_PAGES: LicensePageKey[] = MODULES.map(({ key }) => key);
export const ALL_LICENSE_FEATURES: LicenseFeatureKey[] = [
  ...POS_PRINT_PERMISSION_KEYS,
  ...SETTINGS_SECTION_PERMISSIONS.map(({ key }) => key),
];

function normalizeKeys<T extends string>(value: unknown, allKeys: readonly T[]): T[] | null {
  if (value === undefined || value === null) return [...allKeys];
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || !allKeys.includes(key as T))) {
    return null;
  }
  return [...new Set(value as T[])];
}

export function normalizeLicenseAccess(
  enabledPages: unknown,
  enabledFeatures: unknown,
): LicenseAccess | null {
  const pages = normalizeKeys(enabledPages, ALL_LICENSE_PAGES);
  const features = normalizeKeys(enabledFeatures, ALL_LICENSE_FEATURES);
  if (!pages || !features) return null;
  return { enabledPages: pages, enabledFeatures: features };
}
