import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseConnection,
  createPortableBackup,
  restorePortableBackup,
} from './database';
import { initializeSchema } from './schema';
import { hashRecoveryKey } from '../services/recoveryKey';

test('portable backup restores with its recovery key and rejects a different key', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-portable-backup-'));
  const originalDatabaseKey = process.env.DATABASE_KEY;
  const databaseKey = crypto.randomBytes(32).toString('hex');
  const recoveryKey = crypto.randomBytes(32).toString('base64url');
  process.env.DATABASE_KEY = databaseKey;
  let sourceDb: ReturnType<typeof createDatabaseConnection> | null = null;
  let destinationDb: ReturnType<typeof createDatabaseConnection> | null = null;
  t.after(() => {
    sourceDb?.close();
    destinationDb?.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sourcePath = path.join(directory, 'source.db');
  sourceDb = createDatabaseConnection(sourcePath);
  initializeSchema(sourceDb);
  const now = Math.floor(Date.now() / 1000);
  sourceDb.prepare(`
    INSERT INTO recovery_settings (id, recovery_key_verifier, created_at, updated_at)
    VALUES (1, ?, ?, ?)
  `).run(hashRecoveryKey(recoveryKey), now, now);
  sourceDb.exec("CREATE TABLE portable_probe (value TEXT NOT NULL); INSERT INTO portable_probe VALUES ('saved')");

  const backupPath = path.join(directory, 'shop.pharmabackup');
  await createPortableBackup(sourceDb, backupPath, recoveryKey);
  const portableContents = fs.readFileSync(backupPath);
  assert.notEqual(portableContents.subarray(0, 16).toString('ascii'), 'SQLite format 3\u0000');
  assert.equal(portableContents.includes(Buffer.from(recoveryKey)), false);
  assert.equal(portableContents.includes(Buffer.from(databaseKey, 'hex')), false);

  const destinationPath = path.join(directory, 'restored.db');
  destinationDb = createDatabaseConnection(destinationPath);
  initializeSchema(destinationDb);
  destinationDb.exec("CREATE TABLE portable_probe (value TEXT NOT NULL); INSERT INTO portable_probe VALUES ('existing')");
  destinationDb.close();
  destinationDb = null;

  await assert.rejects(
    () => restorePortableBackup(backupPath, destinationPath, crypto.randomBytes(32).toString('base64url')),
    /recovery key is incorrect|damaged/i,
  );
  destinationDb = createDatabaseConnection(destinationPath);
  assert.equal((destinationDb.prepare('SELECT value FROM portable_probe').get() as { value: string }).value, 'existing');
  destinationDb.close();
  destinationDb = null;

  const restoredKey = await restorePortableBackup(backupPath, destinationPath, recoveryKey);
  assert.equal(restoredKey, databaseKey);
  process.env.DATABASE_KEY = restoredKey;
  destinationDb = createDatabaseConnection(destinationPath);
  assert.equal((destinationDb.prepare('SELECT value FROM portable_probe').get() as { value: string }).value, 'saved');
});
