export interface LocalUser {
  id: string;
  username: string;
  email?: string | null;
  fullName?: string | null;
  role: string;
  permissions: string[];
}

export interface LocalAuthSession {
  user: LocalUser;
  shopProfile: {
    name: string;
    phone: string;
    address: string;
    logoPath: string;
  };
}

export interface LocalLicenseStatus {
  status: string;
  isActivated: boolean;
  shopName: string;
  requiresAdminSetup: boolean;
  enabledPages: string[];
  enabledFeatures: string[];
  message?: string;
}

export interface DesktopAdminSetupResult {
  user: LocalUser;
  recoveryKey: string;
}

export interface DesktopWindow {
  pharmaAPI?: {
    getLicenseStatus: () => Promise<LocalLicenseStatus>;
    getSession: () => Promise<LocalAuthSession | null>;
    activate: (code: string) => Promise<LocalLicenseStatus>;
    setupAdmin: (data: { username: string; password: string; fullName: string }) => Promise<DesktopAdminSetupResult>;
    login: (data: { username: string; password: string }) => Promise<LocalUser>;
    logout: () => Promise<void>;
    request: (data: { path: string; method?: string; body?: unknown }) => Promise<unknown>;
    createBackup: () => Promise<string | null>;
    restoreBackup: () => Promise<boolean>;
    createPortableBackup: (recoveryKey: string) => Promise<string | null>;
    restorePortableBackup: (recoveryKey: string) => Promise<boolean>;
    getRecoveryKeyStatus: () => Promise<{ configured: boolean }>;
    createRecoveryKey: () => Promise<string>;
  };
}

function getDesktopApi(): NonNullable<DesktopWindow['pharmaAPI']> | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & DesktopWindow).pharmaAPI;
}

export function isDesktopMode(): boolean {
  return Boolean(getDesktopApi());
}

export async function desktopLogin(username: string, password: string): Promise<LocalUser> {
  const api = getDesktopApi();
  if (!api) throw new Error('Desktop sign-in is unavailable.');
  return api.login({ username, password });
}

export async function desktopSetupAdmin(data: {
  username: string;
  password: string;
  fullName: string;
}): Promise<DesktopAdminSetupResult> {
  const api = getDesktopApi();
  if (!api) throw new Error('Desktop setup is unavailable.');
  return api.setupAdmin(data);
}

export async function desktopCreatePortableBackup(recoveryKey: string): Promise<string | null> {
  const api = getDesktopApi();
  if (!api) throw new Error('Portable backups are only available in the desktop app.');
  return api.createPortableBackup(recoveryKey);
}

export async function desktopRestorePortableBackup(recoveryKey: string): Promise<boolean> {
  const api = getDesktopApi();
  if (!api) throw new Error('Portable backups are only available in the desktop app.');
  return api.restorePortableBackup(recoveryKey);
}

export async function desktopGetRecoveryKeyStatus(): Promise<{ configured: boolean }> {
  const api = getDesktopApi();
  if (!api) throw new Error('Recovery-key status is only available in the desktop app.');
  return api.getRecoveryKeyStatus();
}

export async function desktopCreateRecoveryKey(): Promise<string> {
  const api = getDesktopApi();
  if (!api) throw new Error('Recovery keys are only available in the desktop app.');
  return api.createRecoveryKey();
}

export async function desktopActivate(code: string): Promise<LocalLicenseStatus> {
  const api = getDesktopApi();
  if (!api) throw new Error('Desktop activation is unavailable.');
  return api.activate(code);
}

export async function desktopGetLicenseStatus(): Promise<LocalLicenseStatus> {
  const api = getDesktopApi();
  if (!api) throw new Error('Desktop licensing is unavailable.');
  return api.getLicenseStatus();
}

export async function desktopGetSession(): Promise<LocalAuthSession | null> {
  const api = getDesktopApi();
  if (!api) return null;
  return api.getSession();
}

export async function desktopLogout(): Promise<void> {
  const api = getDesktopApi();
  if (api) await api.logout();
}

export async function desktopCreateBackup(): Promise<string | null> {
  const api = getDesktopApi();
  if (!api) throw new Error('Desktop backups are only available in the desktop app.');
  return api.createBackup();
}

export async function localApiRequest<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const api = getDesktopApi();
  if (!api) throw new Error('Local API is only available in the desktop app.');
  return await api.request({ path, method, body }) as T;
}
