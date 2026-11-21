import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../../local-backend/src/server';
import { getWindowIconPath } from './windowIcon';
import {
  backupDatabase,
  createPortableBackup,
  restoreDatabase,
  restorePortableBackup,
} from '../../../local-backend/src/db/database';
import { configureSecurity } from './security';

type BackendHandle = Awaited<ReturnType<typeof startServer>>;
type LocalUser = { id: string; username: string; role: string; permissions: string[] };

let backend: BackendHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let sessionToken: string | null = null;
let sessionUser: LocalUser | null = null;
let backupTimer: NodeJS.Timeout | null = null;
let licenseCheckinTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

const localAuthToken = crypto.randomBytes(32).toString('hex');
const localJwtSecret = crypto.randomBytes(48).toString('base64url');
const localApiPort = 0;
const APP_USER_MODEL_ID = 'com.pharmacare.desktop';
const allowedApiPath = /^\/api\/(?:auth|license|pos|inventory|purchases|suppliers|customers|cashbook|reports|settings|print-requests|master-data|trash|notifications|preferences|backup)(?:\/[A-Za-z0-9._/-]+)?(?:\?[A-Za-z0-9_=&.%+-]*)?$/;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);

app.setAppUserModelId(APP_USER_MODEL_ID);

function getDataRoot(): string {
  const testProfile = process.env.PHARMA_TEST_PROFILE;
  if (!app.isPackaged && testProfile) return path.resolve(testProfile);
  return app.getPath('userData');
}

function readOrCreateDatabaseKey(): string {
  if (!app.isReady()) throw new Error('Electron must be ready before reading the database key.');
  if (!app.isPackaged && process.env.PHARMA_TEST_DATABASE_KEY) {
    return process.env.PHARMA_TEST_DATABASE_KEY;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable; the encrypted database cannot be opened.');
  }
  const keyPath = path.join(getDataRoot(), 'database-key.bin');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  if (fs.existsSync(keyPath)) {
    return safeStorage.decryptString(fs.readFileSync(keyPath));
  }

  const key = crypto.randomBytes(32).toString('hex');
  const encrypted = safeStorage.encryptString(key);
  fs.writeFileSync(keyPath, encrypted, { flag: 'wx' });
  return key;
}

function getRecoveryKeyPath(): string {
  return path.join(getDataRoot(), 'recovery-key.bin');
}

function getTestFilePath(name: 'PHARMA_TEST_BACKUP_PATH' | 'PHARMA_TEST_RESTORE_PATH'): string | null {
  if (app.isPackaged) return null;
  const filePath = process.env[name];
  return filePath ? path.resolve(filePath) : null;
}

function storeRecoveryKey(recoveryKey: string): void {
  fs.writeFileSync(getRecoveryKeyPath(), safeStorage.encryptString(recoveryKey));
}

function readStoredRecoveryKey(): string | null {
  const recoveryKeyPath = getRecoveryKeyPath();
  if (!fs.existsSync(recoveryKeyPath)) return null;
  return safeStorage.decryptString(fs.readFileSync(recoveryKeyPath));
}

function getHardwareId(): string {
  const testHardwareId = process.env.PHARMA_TEST_HARDWARE_ID;
  if (!app.isPackaged && testHardwareId && /^[a-f0-9]{64}$/i.test(testHardwareId)) {
    return testHardwareId;
  }
  if (process.platform !== 'win32') {
    throw new Error('Pharmacy activation is supported only on Windows.');
  }
  const registry = execFileSync('reg.exe', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ], { encoding: 'utf8', windowsHide: true });
  const match = registry.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  if (!match?.[1]) throw new Error('Could not read the Windows machine identifier.');
  return crypto.createHash('sha256').update(match[1].trim()).digest('hex');
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || event.sender.id !== mainWindow.webContents.id
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Untrusted IPC sender.');
  }
  const senderUrl = event.senderFrame?.url || '';
  if (app.isPackaged) {
    try {
      const sender = new URL(senderUrl);
      if (sender.protocol !== 'file:' || sender.host) {
        throw new Error('IPC is restricted to the packaged application.');
      }
    } catch {
      throw new Error('IPC is restricted to the packaged application.');
    }
    return;
  }
  const devUrl = process.env.PHARMA_DEV_URL || 'file://';
  if (devUrl !== 'file://') {
    try {
      if (new URL(senderUrl).origin !== new URL(devUrl).origin) {
        throw new Error('IPC is restricted to the local development application.');
      }
    } catch {
      throw new Error('IPC is restricted to the local development application.');
    }
  }
}

async function localRequest(
  requestPath: string,
  method = 'GET',
  body?: unknown,
  includeSession = true,
): Promise<any> {
  if (!backend) throw new Error('Local database service is not ready.');
  if (!allowedApiPath.test(requestPath) || requestPath.includes('..')) {
    throw new Error('The requested local API path is not allowed.');
  }
  if (!allowedMethods.has(method)) throw new Error('The requested local API method is not allowed.');
  let serializedBody: string | undefined;
  if (body !== undefined) {
    serializedBody = JSON.stringify(body);
    if (Buffer.byteLength(serializedBody, 'utf8') > 1024 * 1024) {
      throw new RangeError('Local API request exceeds the 1 MB limit.');
    }
  }
  const headers: Record<string, string> = {
    'X-Local-Auth-Token': localAuthToken,
  };
  if (serializedBody !== undefined) headers['Content-Type'] = 'application/json';
  if (includeSession && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const response = await fetch(`http://127.0.0.1:${backend.port}${requestPath}`, {
    method,
    headers,
    body: serializedBody,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Local API request failed (${response.status}).`;
    if (response.status === 401 && includeSession) {
      sessionToken = null;
      sessionUser = null;
    }
    throw new Error(message);
  }
  return payload;
}

function registerIpcHandlers(): void {
  ipcMain.handle('pharma:license-status', async (event) => {
    assertTrustedSender(event);
    const result = await localRequest('/api/license/status', 'GET', undefined, false);
    return {
      ...result,
      requiresAdminSetup: result.isActivated && result.requiresAdminSetup,
    };
  });

  ipcMain.handle('pharma:activate', async (event, code: unknown) => {
    assertTrustedSender(event);
    if (typeof code !== 'string' || code.trim().length < 8 || code.length > 128) {
      throw new TypeError('Enter a valid activation code.');
    }
    const centralApiUrl = process.env.CENTRAL_API_URL;
    if (!centralApiUrl) throw new Error('CENTRAL_API_URL is not configured for this build.');
    const centralUrl = new URL(centralApiUrl);
    const localDevCentral = process.env.PHARMA_LOCAL_LICENSE_DEV === 'true'
      && centralUrl.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(centralUrl.hostname);
    if (app.isPackaged && centralUrl.protocol !== 'https:' && !localDevCentral) {
      throw new Error('The licensing service must use HTTPS in a packaged build.');
    }
    const hardwareId = getHardwareId();
    const response = await fetch(`${centralUrl.origin}/api/licensing/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationCode: code.trim(), hardwareId }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result && typeof result.error === 'string'
        ? result.error
        : `Activation failed (${response.status}).`);
    }
    if (!result?.shop?.id || !result?.shop?.shop_name || !result?.licenseToken) {
      throw new Error('Licensing service returned an invalid activation response.');
    }
    await localRequest('/api/license/activate', 'POST', {
      shopId: result.shop.id,
      shopName: result.shop.shop_name,
      licenseToken: result.licenseToken,
      hardwareId,
    }, false);
    return await localRequest('/api/license/status', 'GET', undefined, false);
  });

  ipcMain.handle('pharma:setup-admin', async (event, data: unknown) => {
    assertTrustedSender(event);
    if (!data || typeof data !== 'object') throw new TypeError('Admin setup details are required.');
    const { username, password, fullName } = data as Record<string, unknown>;
    if (
      typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 64
      || typeof password !== 'string' || password.length < 10 || password.length > 256
      || typeof fullName !== 'string' || fullName.trim().length < 1 || fullName.trim().length > 120
    ) {
      throw new TypeError('Enter a username, full name, and password of at least 10 characters.');
    }
    let recoveryKey = readStoredRecoveryKey();
    if (!recoveryKey) {
      recoveryKey = crypto.randomBytes(32).toString('base64url');
      storeRecoveryKey(recoveryKey);
    }
    const result = await localRequest('/api/auth/setup-admin', 'POST', {
      username: username.trim(),
      password,
      fullName: fullName.trim(),
      recoveryKey,
    }, false);
    sessionToken = result.token;
    sessionUser = result.user;
    return { user: sessionUser, recoveryKey };
  });

  ipcMain.handle('pharma:login', async (event, credentials: unknown) => {
    assertTrustedSender(event);
    if (!credentials || typeof credentials !== 'object') throw new TypeError('Sign-in details are required.');
    const { username, password } = credentials as Record<string, unknown>;
    if (
      typeof username !== 'string' || username.trim().length < 1 || username.length > 64
      || typeof password !== 'string' || password.length < 1 || password.length > 256
    ) {
      throw new TypeError('Enter a valid username and password.');
    }
    const result = await localRequest('/api/auth/login', 'POST', {
      username: username.trim(),
      password,
    }, false);
    sessionToken = result.token;
    sessionUser = result.user;
    return sessionUser;
  });

  ipcMain.handle('pharma:get-session', async (event) => {
    assertTrustedSender(event);
    if (!sessionToken) return null;
    try {
      const current = await localRequest('/api/auth/me');
      sessionUser = current.user;
      return current;
    } catch (error) {
      sessionToken = null;
      sessionUser = null;
      throw error;
    }
  });

  ipcMain.handle('pharma:logout', (event) => {
    assertTrustedSender(event);
    sessionToken = null;
    sessionUser = null;
  });

  ipcMain.handle('pharma:request', async (event, request: unknown) => {
    assertTrustedSender(event);
    if (!request || typeof request !== 'object') throw new TypeError('A local API request is required.');
    const { path: requestPath, method, body } = request as Record<string, unknown>;
    if (typeof requestPath !== 'string') throw new TypeError('A local API path is required.');
    if (method !== undefined && typeof method !== 'string') throw new TypeError('Invalid local API method.');
    return localRequest(requestPath, method as string | undefined, body);
  });

  ipcMain.handle('pharma:backup', async (event) => {
    assertTrustedSender(event);
    if (sessionUser?.role !== 'admin' || !backend) {
      throw new Error('Only the Shop Admin can create a backup.');
    }
    return createBackupInSelectedFolder();
  });

  ipcMain.handle('pharma:restore', async (event) => {
    assertTrustedSender(event);
    return restoreFromSelectedBackup();
  });

  ipcMain.handle('pharma:portable-backup', async (event, recoveryKey: unknown) => {
    assertTrustedSender(event);
    if (sessionUser?.role !== 'admin' || !backend || !mainWindow) {
      throw new Error('Only the Shop Admin can create a portable backup.');
    }
    if (typeof recoveryKey !== 'string') throw new TypeError('Enter the recovery key.');
    const testPath = getTestFilePath('PHARMA_TEST_BACKUP_PATH');
    const selected = testPath ? null : await dialog.showSaveDialog(mainWindow, {
      title: 'Export portable encrypted backup',
      defaultPath: `PharmaCare-${new Date().toISOString().slice(0, 10)}.pharmabackup`,
      filters: [{ name: 'Pharma Care portable backup', extensions: ['pharmabackup'] }],
    });
    const filePath = testPath || selected?.filePath;
    if (!filePath || selected?.canceled) return null;
    return createPortableBackup(backend.db, filePath, recoveryKey);
  });

  ipcMain.handle('pharma:portable-restore', async (event, recoveryKey: unknown) => {
    assertTrustedSender(event);
    if ((!sessionUser && sessionToken) || (sessionUser && sessionUser.role !== 'admin') || !backend || !mainWindow) {
      throw new Error('Portable restore is available to the Shop Admin or before signing in.');
    }
    if (typeof recoveryKey !== 'string') throw new TypeError('Enter the recovery key.');
    const testPath = getTestFilePath('PHARMA_TEST_RESTORE_PATH');
    const selected = testPath ? null : await dialog.showOpenDialog(mainWindow, {
      title: 'Choose portable Pharma Care backup',
      properties: ['openFile'],
      filters: [{ name: 'Pharma Care portable backup', extensions: ['pharmabackup'] }],
    });
    const backupPath = testPath || selected?.filePaths[0];
    if (!backupPath || selected?.canceled) return false;
    const confirmation = testPath ? null : await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Restore backup', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore portable backup',
      message: 'Restoring replaces the current pharmacy database. The current database will be preserved as a recovery copy.',
    });
    if (confirmation && confirmation.response !== 0) return false;

    const dataRoot = getDataRoot();
    const databasePath = path.join(dataRoot, 'data', 'pharmadata.db');
    const databaseKeyPath = path.join(dataRoot, 'database-key.bin');
    const recoveryKeyPath = getRecoveryKeyPath();
    const restoreId = crypto.randomUUID();
    const rollbackDatabasePath = `${databasePath}.rollback-${restoreId}`;
    const rollbackDatabaseKeyPath = `${databaseKeyPath}.rollback-${restoreId}`;
    const rollbackRecoveryKeyPath = `${recoveryKeyPath}.rollback-${restoreId}`;
    const stagedDatabaseKeyPath = `${databaseKeyPath}.restore-${restoreId}`;
    const stagedRecoveryKeyPath = `${recoveryKeyPath}.restore-${restoreId}`;
    const previousDatabaseKey = process.env.DATABASE_KEY;
    const activeBackend = backend;
    await activeBackend.app.close();
    activeBackend.db.close();
    backend = null;
    let hadDatabase = false;
    let hadDatabaseKey = false;
    let hadRecoveryKey = false;
    let restoreStarted = false;
    try {
      hadDatabase = fs.existsSync(databasePath);
      hadDatabaseKey = fs.existsSync(databaseKeyPath);
      hadRecoveryKey = fs.existsSync(recoveryKeyPath);
      if (hadDatabase) fs.copyFileSync(databasePath, rollbackDatabasePath, fs.constants.COPYFILE_EXCL);
      if (hadDatabaseKey) fs.copyFileSync(databaseKeyPath, rollbackDatabaseKeyPath, fs.constants.COPYFILE_EXCL);
      if (hadRecoveryKey) fs.copyFileSync(recoveryKeyPath, rollbackRecoveryKeyPath, fs.constants.COPYFILE_EXCL);

      restoreStarted = true;
      const recoveredDatabaseKey = await restorePortableBackup(
        backupPath,
        databasePath,
        recoveryKey,
      );
      fs.writeFileSync(stagedDatabaseKeyPath, safeStorage.encryptString(recoveredDatabaseKey), { flag: 'wx' });
      fs.writeFileSync(stagedRecoveryKeyPath, safeStorage.encryptString(recoveryKey), { flag: 'wx' });
      fs.renameSync(stagedDatabaseKeyPath, databaseKeyPath);
      fs.renameSync(stagedRecoveryKeyPath, recoveryKeyPath);
      process.env.DATABASE_KEY = recoveredDatabaseKey;
    } catch (error) {
      if (restoreStarted) {
        try {
          if (hadDatabase) fs.copyFileSync(rollbackDatabasePath, databasePath);
          else if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
          if (hadDatabaseKey) fs.copyFileSync(rollbackDatabaseKeyPath, databaseKeyPath);
          else if (fs.existsSync(databaseKeyPath)) fs.unlinkSync(databaseKeyPath);
          if (hadRecoveryKey) fs.copyFileSync(rollbackRecoveryKeyPath, recoveryKeyPath);
          else if (fs.existsSync(recoveryKeyPath)) fs.unlinkSync(recoveryKeyPath);
          if (previousDatabaseKey === undefined) delete process.env.DATABASE_KEY;
          else process.env.DATABASE_KEY = previousDatabaseKey;
        } catch (rollbackError) {
          throw new Error(
            `Portable restore failed and rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      for (const temporaryPath of [
        rollbackDatabasePath,
        rollbackDatabaseKeyPath,
        rollbackRecoveryKeyPath,
        stagedDatabaseKeyPath,
        stagedRecoveryKeyPath,
      ]) {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
      backend = await startServer({
        host: '127.0.0.1',
        port: localApiPort,
        dbPath: databasePath,
        localAuthToken,
        jwtSecret: localJwtSecret,
      });
      await waitForBackend();
    }
    sessionToken = null;
    sessionUser = null;
    mainWindow.reload();
    return true;
  });

  ipcMain.handle('pharma:recovery-key-status', async (event) => {
    assertTrustedSender(event);
    return localRequest('/api/auth/recovery-key', 'GET');
  });

  ipcMain.handle('pharma:create-recovery-key', async (event) => {
    assertTrustedSender(event);
    if (sessionUser?.role !== 'admin') throw new Error('Only the Shop Admin can configure a recovery key.');
    if (readStoredRecoveryKey()) throw new Error('A recovery key is already stored for this Windows profile.');
    const { configured } = await localRequest('/api/auth/recovery-key', 'GET') as { configured: boolean };
    if (configured) throw new Error('A recovery key is already configured. Use the key saved during Shop Admin setup.');
    const recoveryKey = crypto.randomBytes(32).toString('base64url');
    storeRecoveryKey(recoveryKey);
    try {
      await localRequest('/api/auth/recovery-key', 'POST', { recoveryKey });
    } catch (error) {
      fs.unlinkSync(getRecoveryKeyPath());
      throw error;
    }
    return recoveryKey;
  });
}

async function createBackupInSelectedFolder(): Promise<string | null> {
  if (sessionUser?.role !== 'admin' || !backend || !mainWindow) {
    throw new Error('Only the Shop Admin can create a backup.');
  }
  const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose encrypted backup folder',
      properties: ['openDirectory', 'createDirectory'],
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  return backupDatabase(backend.db, selected.filePaths[0]);
}

async function restoreFromSelectedBackup(): Promise<boolean> {
  if (sessionUser?.role !== 'admin' || !backend || !mainWindow) {
    throw new Error('Only the Shop Admin can restore a backup.');
  }
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose encrypted Pharma Care backup',
    properties: ['openFile'],
    filters: [{ name: 'Encrypted database backups', extensions: ['db'] }],
  });
  if (selected.canceled || selected.filePaths.length === 0) return false;
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Restore backup', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Restore encrypted backup',
    message: 'Restoring replaces the current pharmacy database. The current database will be preserved as a recovery copy.',
  });
  if (confirmation.response !== 0) return false;

  const databasePath = path.join(getDataRoot(), 'data', 'pharmadata.db');
  const activeBackend = backend;
  await activeBackend.app.close();
  activeBackend.db.close();
  backend = null;
  try {
    await restoreDatabase(selected.filePaths[0], databasePath);
  } finally {
    backend = await startServer({
      host: '127.0.0.1',
      port: localApiPort,
      dbPath: databasePath,
      localAuthToken,
      jwtSecret: localJwtSecret,
    });
    await waitForBackend();
  }
  sessionToken = null;
  sessionUser = null;
  mainWindow.reload();
  return true;
}

function createApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Pharma Care',
      submenu: [
        {
          label: 'Create encrypted backup…',
          enabled: true,
          click: () => {
            void createBackupInSelectedFolder().then((pathName) => {
              if (pathName && Notification.isSupported()) {
                new Notification({ title: 'Encrypted backup complete', body: path.basename(pathName) }).show();
              }
            }).catch((error) => {
              dialog.showErrorBox('Backup failed', error instanceof Error ? error.message : String(error));
            });
          },
        },
        {
          label: 'Restore encrypted backup…',
          enabled: true,
          click: () => {
            void restoreFromSelectedBackup().catch((error) => {
              dialog.showErrorBox('Restore failed', error instanceof Error ? error.message : String(error));
            });
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    icon: getWindowIconPath(app.isPackaged, app.getAppPath(), process.resourcesPath),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  const devUrl = process.env.PHARMA_DEV_URL;
  const allowedOrigin = devUrl ? new URL(devUrl).origin : 'file://';
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isAllowed = allowedOrigin === 'file://'
      ? url === pathToFileURL(path.join(app.getAppPath(), 'renderer', 'index.html')).href
      : (() => {
        try {
          return new URL(url).origin === allowedOrigin;
        } catch {
          return false;
        }
      })();
    if (!isAllowed) {
      event.preventDefault();
    }
  });
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => mainWindow?.webContents.closeDevTools());
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const rendererPath = app.isPackaged
    ? path.join(app.getAppPath(), 'renderer', 'index.html')
    : path.join(app.getAppPath(), 'renderer', 'index.html');
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(rendererPath);
}

async function waitForBackend(): Promise<void> {
  if (!backend) throw new Error('Local backend failed to start.');
  const deadline = Date.now() + 15000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (backend.app.server.listening) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local backend startup timed out.')), 500);
        fetch(`http://127.0.0.1:${backend!.port}/api/health`)
          .then((response) => response.ok ? resolve() : reject(new Error(`Health check failed (${response.status}).`)))
          .catch(reject)
          .finally(() => clearTimeout(timer));
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Local backend did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function startApplication(): Promise<void> {
  const dataRoot = getDataRoot();
  fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  const databaseKey = readOrCreateDatabaseKey();
  const databasePath = path.join(dataRoot, 'data', 'pharmadata.db');
  process.env.DATABASE_KEY = databaseKey;
  process.env.NODE_ENV = 'production';
  process.env.PROGRAMDATA = dataRoot;
  process.env.PHARMA_HARDWARE_ID = getHardwareId();
  configureSecurity();
  registerIpcHandlers();
  backend = await startServer({
    host: '127.0.0.1',
    port: localApiPort,
    dbPath: databasePath,
    localAuthToken,
    jwtSecret: localJwtSecret,
  });
  await waitForBackend();
  createApplicationMenu();
  createWindow();
  const syncLicense = async () => {
    const status = await localRequest('/api/license/status', 'GET', undefined, false);
    if (!status.isActivated) return;
    const centralApiUrl = process.env.CENTRAL_API_URL;
    if (!centralApiUrl) throw new Error('CENTRAL_API_URL is not configured for this build.');
    const response = await fetch(`${new URL(centralApiUrl).origin}/api/licensing/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: status.shopId,
        hardwareId: process.env.PHARMA_HARDWARE_ID,
        appVersion: app.getVersion(),
        osVersion: `${process.platform} ${os.release()}`,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || typeof result?.licenseToken !== 'string') {
      throw new Error(result && typeof result.error === 'string'
        ? result.error
        : `License check-in failed (${response.status}).`);
    }
    await localRequest('/api/license/check-in', 'POST', {
      licenseToken: result.licenseToken,
      hardwareId: process.env.PHARMA_HARDWARE_ID,
    }, false);
  };
  void syncLicense().catch((error) => console.error('License check-in failed:', error));
  licenseCheckinTimer = setInterval(() => {
    void syncLicense().catch((error) => console.error('License check-in failed:', error));
  }, 12 * 60 * 60 * 1000);

  backupTimer = setInterval(() => {
    if (!backend) return;
    const recoveryKey = readStoredRecoveryKey();
    const backupTask = recoveryKey
      ? createPortableBackup(
        backend.db,
        path.join(getDataRoot(), 'backups', `PharmaCare-${new Date().toISOString().replace(/[:.]/g, '-')}.pharmabackup`),
        recoveryKey,
      )
      : backupDatabase(backend.db);
    void backupTask.then((pathName) => {
      if (Notification.isSupported()) {
        new Notification({ title: 'Pharma Care backup complete', body: `Saved: ${path.basename(pathName)}` }).show();
      }
    }).catch((error) => {
      dialog.showErrorBox('Scheduled backup failed', error instanceof Error ? error.message : String(error));
    });
  }, 24 * 60 * 60 * 1000);
}

app.whenReady().then(startApplication).catch((error) => {
  dialog.showErrorBox('Pharma Care could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', (event) => {
  if (!backend || isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  if (backupTimer) clearInterval(backupTimer);
  if (licenseCheckinTimer) clearInterval(licenseCheckinTimer);
  void backend.app.close().finally(() => {
    backend?.db.close();
    backend = null;
    app.quit();
  });
});
