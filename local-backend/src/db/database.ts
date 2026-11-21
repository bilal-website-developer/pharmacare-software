import Database from 'better-sqlite3-multiple-ciphers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export function getDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }

  // Production Windows data path or development fallback
  const isProduction = process.env.NODE_ENV === 'production';
  const baseDir = isProduction && process.env.PROGRAMDATA
    ? path.join(process.env.PROGRAMDATA, 'PharmaCare', 'data')
    : path.join(__dirname, '..', '..', 'data');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return path.join(baseDir, 'pharmadata.db');
}

export function createDatabaseConnection(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || getDatabasePath();
  const encryptionKey = process.env.DATABASE_KEY;
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error('DATABASE_KEY must contain a 256-bit hexadecimal key.');
  }
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  try {
    if (resolvedPath !== ':memory:') {
      db.pragma(`key = '${encryptionKey}'`);
      db.pragma('cipher_integrity_check');
      db.prepare('SELECT count(*) AS table_count FROM sqlite_master').get();
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

export async function backupDatabase(db: Database.Database, targetDir?: string): Promise<string> {
  const encryptionKey = process.env.DATABASE_KEY;
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error('DATABASE_KEY must contain a 256-bit hexadecimal key.');
  }
  if (db.memory) throw new Error('An in-memory database cannot be backed up as a pharmacy file.');
  const isProduction = process.env.NODE_ENV === 'production';
  const backupDir = targetDir || (isProduction && process.env.PROGRAMDATA
    ? path.join(process.env.PROGRAMDATA, 'PharmaCare', 'backups')
    : path.join(__dirname, '..', '..', 'backups'));

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `pharmadata-backup-${timestamp}.db`);
  const temporaryBackup = `${backupFile}.tmp-${crypto.randomUUID()}`;
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if (checkpoint[0]?.busy) throw new Error('The database is busy; retry the backup when no write is in progress.');

  try {
    fs.copyFileSync(db.name, temporaryBackup, fs.constants.COPYFILE_EXCL);
    validateEncryptedDatabase(temporaryBackup, encryptionKey);
    fs.renameSync(temporaryBackup, backupFile);
    return backupFile;
  } finally {
    if (fs.existsSync(temporaryBackup)) fs.unlinkSync(temporaryBackup);
  }
}

export async function restoreDatabase(backupPath: string, databasePath: string): Promise<void> {
  const encryptionKey = process.env.DATABASE_KEY;
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error('DATABASE_KEY must contain a 256-bit hexadecimal key.');
  }
  const sourcePath = path.resolve(backupPath);
  const destinationPath = path.resolve(databasePath);
  if (sourcePath === destinationPath) throw new Error('Choose a backup file, not the active database.');

  const temporaryPath = `${destinationPath}.restore-${crypto.randomUUID()}`;
  let recoveryPath: string | null = null;
  try {
    validateEncryptedDatabase(sourcePath, encryptionKey);
    fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    validateEncryptedDatabase(temporaryPath, encryptionKey);

    if (fs.existsSync(destinationPath)) {
      recoveryPath = `${destinationPath}.before-restore-${Date.now()}`;
      fs.renameSync(destinationPath, recoveryPath);
    }
    try {
      fs.renameSync(temporaryPath, destinationPath);
    } catch (error) {
      if (recoveryPath && fs.existsSync(recoveryPath)) {
        fs.renameSync(recoveryPath, destinationPath);
        recoveryPath = null;
      }
      throw error;
    }
    for (const suffix of ['-wal', '-shm']) {
      const journalPath = `${destinationPath}${suffix}`;
      if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
    }
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function validateEncryptedDatabase(databasePath: string, encryptionKey: string): void {
  const db = new Database(databasePath);
  try {
    db.pragma(`key = '${encryptionKey}'`);
    const integrity = db.pragma('quick_check') as Array<Record<string, string>>;
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw new Error('The encrypted database failed its integrity check.');
    }
    db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  } finally {
    db.close();
  }
}
