import React, { createContext, useContext, useMemo } from 'react';
import { UserRole } from './types/pharmacy';
import { getSidebarPage } from './components/sidebarPages';
import {
  ALL_LICENSE_FEATURES,
  ALL_LICENSE_PAGES,
  MODULES,
  POS_PRINT_PERMISSION_KEYS,
  SETTINGS_SECTION_PERMISSIONS,
  type LicenseFeatureKey,
} from '../central-backend/src/entitlementModel';

export {
  ALL_LICENSE_FEATURES,
  ALL_LICENSE_PAGES,
  MODULES,
  POS_PRINT_PERMISSION_KEYS,
  SETTINGS_SECTION_PERMISSIONS,
};

export type ModuleKey = (typeof MODULES)[number]['key'];

export type PosPrintPermissionKey = (typeof POS_PRINT_PERMISSION_KEYS)[number];
export type SettingsSectionPermissionKey = (typeof SETTINGS_SECTION_PERMISSIONS)[number]['key'];
export type PermissionKey = ModuleKey | PosPrintPermissionKey | SettingsSectionPermissionKey;

export function hasPosPrintToggles(permissions: readonly PermissionKey[]): boolean {
  return permissions.includes('pos');
}

export function normalizePermissionSelection(permissions: readonly PermissionKey[]): PermissionKey[] {
  const unique = [...new Set(permissions)];
  const withSettingsSections = unique.includes('settings')
    ? unique
    : unique.filter((permission) =>
      !SETTINGS_SECTION_PERMISSIONS.some(({ key }) => key === permission)
    );
  return hasPosPrintToggles(withSettingsSections)
    ? withSettingsSections
    : withSettingsSections.filter((permission) => !POS_PRINT_PERMISSION_KEYS.includes(permission as PosPrintPermissionKey));
}

export function setModulePermission(
  permissions: readonly PermissionKey[],
  module: ModuleKey,
  enabled: boolean,
): PermissionKey[] {
  const next = new Set(permissions);
  if (enabled) next.add(module);
  else next.delete(module);

  if (module === 'pos') {
    if (!enabled) {
      POS_PRINT_PERMISSION_KEYS.forEach((permission) => next.delete(permission));
    }
  }
  if (module === 'settings' && !enabled) {
    SETTINGS_SECTION_PERMISSIONS.forEach(({ key }) => next.delete(key));
  }

  return normalizePermissionSelection([...next]);
}

export function setPosPrintPermission(
  permissions: readonly PermissionKey[],
  permission: PosPrintPermissionKey,
  enabled: boolean,
): PermissionKey[] {
  if (!hasPosPrintToggles(permissions)) return normalizePermissionSelection(permissions);
  const next = new Set(permissions);
  if (enabled) next.add(permission);
  else next.delete(permission);
  return normalizePermissionSelection([...next]);
}

export function setSettingsSectionPermission(
  permissions: readonly PermissionKey[],
  permission: SettingsSectionPermissionKey,
  enabled: boolean,
): PermissionKey[] {
  if (!permissions.includes('settings')) return normalizePermissionSelection(permissions);
  const next = new Set(permissions);
  if (enabled) next.add(permission);
  else next.delete(permission);
  return normalizePermissionSelection([...next]);
}

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && MODULES.some(({ key }) => key === value);
}

export function isPermissionKey(value: unknown): value is PermissionKey {
  return isModuleKey(value)
    || POS_PRINT_PERMISSION_KEYS.some((key) => key === value)
    || SETTINGS_SECTION_PERMISSIONS.some(({ key }) => key === value);
}

export function permissionsForRole(role: UserRole, permissions: readonly string[]) {
  return role === UserRole.SUPER_ADMIN ? [] : permissions;
}

export function isAdminRole(role: UserRole) {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
}

export function canAccessModule(role: UserRole, permissions: readonly string[], moduleKey: ModuleKey) {
  return permissionsForRole(role, permissions).includes(moduleKey);
}

export function canAccessPage(role: UserRole, permissions: readonly string[], pageKey: string) {
  const page = getSidebarPage(pageKey);
  const accessRole = role === UserRole.SELLER ? UserRole.CASHIER : role;
  if (!page || !page.allowedRoles.includes(accessRole)) return false;
  if (page.key === 'manage-users') {
    return role === UserRole.SUPER_ADMIN
      || (role === UserRole.ADMIN && canAccessModule(role, permissions, 'manage_users'));
  }

  if (page.adminOnly) return role === UserRole.ADMIN;
  return page.module ? canAccessModule(role, permissions, page.module) : true;
}

export function isLicensePageIncluded(
  pageKey: string,
  enabledPages: readonly string[],
  disabledPages: readonly string[] = [],
): boolean {
  const page = getSidebarPage(pageKey);
  if (disabledPages.includes(pageKey)) return false;
  return !page?.module || enabledPages.includes(page.module);
}

export function canEditSettingsSection(
  role: UserRole,
  permissions: readonly string[],
  section: SettingsSectionPermissionKey,
): boolean {
  if (!canAccessModule(role, permissions, 'settings')) return false;
  if (role === UserRole.ADMIN) return permissions.includes(section);
  if (role === UserRole.MANAGER) {
    return section !== 'settings_shop_profile' && section !== 'settings_demo_data';
  }
  return false;
}

interface PermissionContextValue {
  isAdmin: boolean;
  can: (moduleKey: ModuleKey) => boolean;
  canPage: (pageKey: string) => boolean;
  isPageIncluded: (pageKey: string) => boolean;
  hasFeature: (featureKey: LicenseFeatureKey) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);
const EMPTY_PAGE_KEYS: readonly string[] = [];

export function PermissionsProvider({
  role,
  permissions,
  enabledPages = ALL_LICENSE_PAGES,
  enabledFeatures = ALL_LICENSE_FEATURES,
  disabledPages = EMPTY_PAGE_KEYS,
  children,
}: React.PropsWithChildren<{
  role: UserRole;
  permissions: readonly string[];
  enabledPages?: readonly string[];
  enabledFeatures?: readonly string[];
  disabledPages?: readonly string[];
}>) {
  const value = useMemo<PermissionContextValue>(() => {
    const isAdmin = isAdminRole(role);
    const can = (moduleKey: ModuleKey) => canAccessModule(role, permissions, moduleKey);
    const isPageIncluded = (pageKey: string) =>
      isLicensePageIncluded(pageKey, enabledPages, disabledPages);
    const canPage = (pageKey: string) => isPageIncluded(pageKey)
      && canAccessPage(role, permissions, pageKey);
    const hasFeature = (featureKey: LicenseFeatureKey) => enabledFeatures.includes(featureKey);
    return { isAdmin, can, canPage, isPageIncluded, hasFeature };
  }, [role, permissions, enabledPages, enabledFeatures, disabledPages]);
  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const context = useContext(PermissionContext);
  if (!context) throw new Error('usePermissions must be used within PermissionsProvider.');
  return context;
}
