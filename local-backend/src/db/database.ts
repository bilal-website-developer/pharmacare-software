import Database from 'better-sqlite3-multiple-ciphers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'node:stream/promises';
import { isValidRecoveryKey, verifyRecoveryKey } from '../services/recoveryKey';

const PORTABLE_BACKUP_MAGIC = Buffer.from('PHARMACARE-BACKUP-1\n', 'ascii');
const MAX_PORTABLE_HEADER_BYTES = 64 * 1024;
const SCRYPT_BYTES = 32;

interface PortableBackupHeader {
  version: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  authTag: string;
  encryptedDatabaseKey: string;
}

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
  await restoreDatabaseWithKey(backupPath, databasePath, encryptionKey);
}

export async function restoreDatabaseWithKey(
  backupPath: string,
  databasePath: string,
  encryptionKey: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error('The database encryption key is invalid.');
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

export async function createPortableBackup(
  db: Database.Database,
  targetPath: string,
  recoveryKey: string,
): Promise<string> {
  if (!isValidRecoveryKey(recoveryKey)) throw new Error('Enter a valid recovery key.');
  const encryptionKey = process.env.DATABASE_KEY;
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error('DATABASE_KEY must contain a 256-bit hexadecimal key.');
  }
  if (db.memory || !db.name) throw new Error('An in-memory database cannot be exported.');
  const recovery = db.prepare('SELECT recovery_key_verifier FROM recovery_settings WHERE id = 1').get() as {
    recovery_key_verifier: string;
  } | undefined;
  if (!recovery || !verifyRecoveryKey(recoveryKey, recovery.recovery_key_verifier)) {
    throw new Error('The recovery key is incorrect or has not been configured.');
  }
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  if (checkpoint[0]?.busy) throw new Error('The database is busy; retry the backup when no write is in progress.');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const wrappingKey = crypto.scryptSync(recoveryKey, salt, SCRYPT_BYTES);
  const keyCipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  const encryptedDatabaseKey = Buffer.concat([
    keyCipher.update(Buffer.from(encryptionKey, 'hex')),
    keyCipher.final(),
  ]);
  const header: PortableBackupHeader = {
    version: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: keyCipher.getAuthTag().toString('base64'),
    encryptedDatabaseKey: encryptedDatabaseKey.toString('base64'),
  };
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(PORTABLE_BACKUP_MAGIC.length + 4);
  PORTABLE_BACKUP_MAGIC.copy(prefix);
  prefix.writeUInt32BE(headerBuffer.length, PORTABLE_BACKUP_MAGIC.length);
  const destinationPath = path.resolve(targetPath);
  const temporaryPath = `${destinationPath}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, Buffer.concat([prefix, headerBuffer]), { flag: 'wx' });
    await pipeline(
      fs.createReadStream(db.name),
      fs.createWriteStream(temporaryPath, { flags: 'a' }),
    );
    validatePortableDatabase(temporaryPath, encryptionKey, headerBuffer.length);
    fs.renameSync(temporaryPath, destinationPath);
    return destinationPath;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export async function restorePortableBackup(
  backupPath: string,
  databasePath: string,
  recoveryKey: string,
): Promise<string> {
  if (!isValidRecoveryKey(recoveryKey)) throw new Error('Enter a valid recovery key.');
  const sourcePath = path.resolve(backupPath);
  const temporaryPath = `${path.resolve(databasePath)}.portable-${crypto.randomUUID()}`;
  let header: PortableBackupHeader;
  let payloadOffset: number;
  try {
    const fd = fs.openSync(sourcePath, 'r');
    try {
      const prefix = Buffer.alloc(PORTABLE_BACKUP_MAGIC.length + 4);
      if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length
        || !prefix.subarray(0, PORTABLE_BACKUP_MAGIC.length).equals(PORTABLE_BACKUP_MAGIC)) {
        throw new Error('This is not a supported Pharma Care portable backup.');
      }
      const headerLength = prefix.readUInt32BE(PORTABLE_BACKUP_MAGIC.length);
      if (headerLength < 2 || headerLength > MAX_PORTABLE_HEADER_BYTES) {
        throw new Error('Portable backup metadata is invalid.');
      }
      const headerBuffer = Buffer.alloc(headerLength);
      if (fs.readSync(fd, headerBuffer, 0, headerLength, prefix.length) !== headerLength) {
        throw new Error('Portable backup metadata is incomplete.');
      }
      header = JSON.parse(headerBuffer.toString('utf8')) as PortableBackupHeader;
      payloadOffset = prefix.length + headerLength;
    } finally {
      fs.closeSync(fd);
    }

    if (header.version !== 1 || header.kdf !== 'scrypt' || header.cipher !== 'aes-256-gcm') {
      throw new Error('This portable backup version is not supported.');
    }
    const salt = decodeBase64(header.salt, 16, 'salt');
    const iv = decodeBase64(header.iv, 12, 'initialization vector');
    const authTag = decodeBase64(header.authTag, 16, 'authentication tag');
    const encryptedKey = decodeBase64(header.encryptedDatabaseKey, 32, 'wrapped database key');
    const wrappingKey = crypto.scryptSync(recoveryKey, salt, SCRYPT_BYTES);
    const keyDecipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
    keyDecipher.setAuthTag(authTag);
    const encryptionKey = Buffer.concat([
      keyDecipher.update(encryptedKey),
      keyDecipher.final(),
    ]).toString('hex');
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) {
      throw new Error('The recovery key could not unlock this backup.');
    }

    await pipeline(
      fs.createReadStream(sourcePath, { start: payloadOffset }),
      fs.createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    validateEncryptedDatabase(temporaryPath, encryptionKey);
    const recoveredDb = new Database(temporaryPath);
    let verifier: string | undefined;
    try {
      recoveredDb.pragma(`key = '${encryptionKey}'`);
      verifier = (recoveredDb.prepare(
        'SELECT recovery_key_verifier FROM recovery_settings WHERE id = 1',
      ).get() as { recovery_key_verifier: string } | undefined)?.recovery_key_verifier;
    } finally {
      recoveredDb.close();
    }
    if (!verifier || !verifyRecoveryKey(recoveryKey, verifier)) {
      throw new Error('The recovery key does not match this pharmacy backup.');
    }
    await restoreDatabaseWithKey(temporaryPath, databasePath, encryptionKey);
    return encryptionKey;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unsupported state or unable to authenticate data')) {
      throw new Error('The recovery key is incorrect or the portable backup has been damaged.');
    }
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function decodeBase64(value: string, expectedLength: number, label: string): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Portable backup ${label} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength) throw new Error(`Portable backup ${label} is invalid.`);
  return decoded;
}

function validatePortableDatabase(
  backupPath: string,
  encryptionKey: string,
  headerLength: number,
): void {
  const fd = fs.openSync(backupPath, 'r');
  try {
    const prefix = Buffer.alloc(PORTABLE_BACKUP_MAGIC.length + 4);
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    const length = prefix.readUInt32BE(PORTABLE_BACKUP_MAGIC.length);
    if (length !== headerLength) throw new Error('Portable backup metadata changed during export.');
    validateEncryptedDatabaseSegment(backupPath, encryptionKey, prefix.length + length);
  } finally {
    fs.closeSync(fd);
  }
}

function validateEncryptedDatabaseSegment(
  backupPath: string,
  encryptionKey: string,
  payloadOffset: number,
): void {
  const temporaryPath = `${backupPath}.verify-${crypto.randomUUID()}`;
  try {
    const fd = fs.openSync(backupPath, 'r');
    try {
      fs.writeFileSync(temporaryPath, '');
      const outputFd = fs.openSync(temporaryPath, 'w');
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let position = payloadOffset;
        let bytesRead: number;
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
          fs.writeSync(outputFd, buffer, 0, bytesRead);
          position += bytesRead;
        }
      } finally {
        fs.closeSync(outputFd);
      }
    } finally {
      fs.closeSync(fd);
    }
    validateEncryptedDatabase(temporaryPath, encryptionKey);
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
