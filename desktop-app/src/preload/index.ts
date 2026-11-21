import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pharmaAPI', {
  getLicenseStatus: () => ipcRenderer.invoke('pharma:license-status'),
  activate: (code: string) => ipcRenderer.invoke('pharma:activate', code),
  getSession: () => ipcRenderer.invoke('pharma:get-session'),
  setupAdmin: (data: { username: string; password: string; fullName: string }) =>
    ipcRenderer.invoke('pharma:setup-admin', data),
  login: (credentials: { username: string; password: string }) =>
    ipcRenderer.invoke('pharma:login', credentials),
  logout: () => ipcRenderer.invoke('pharma:logout'),
  request: (data: { path: string; method?: string; body?: unknown }) =>
    ipcRenderer.invoke('pharma:request', data),
  createBackup: () => ipcRenderer.invoke('pharma:backup'),
  restoreBackup: () => ipcRenderer.invoke('pharma:restore'),
  createPortableBackup: (recoveryKey: string) => ipcRenderer.invoke('pharma:portable-backup', recoveryKey),
  restorePortableBackup: (recoveryKey: string) => ipcRenderer.invoke('pharma:portable-restore', recoveryKey),
  getRecoveryKeyStatus: () => ipcRenderer.invoke('pharma:recovery-key-status'),
  createRecoveryKey: () => ipcRenderer.invoke('pharma:create-recovery-key'),
});
