import Database from 'better-sqlite3-multiple-ciphers';
import { hash, verify } from '@node-rs/argon2';
import crypto from 'crypto';

export interface UserProfile {
  id: string;
  username: string;
  fullName: string | null;
  email: string | null;
  role: 'admin' | 'manager' | 'seller' | 'cashier' | 'accountant';
  permissions: string[];
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export async function hashPassword(plainText: string): Promise<string> {
  return hash(plainText, {
    memoryCost: 65536, // 64 MB
    timeCost: 3,       // 3 iterations
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, plainText: string): Promise<boolean> {
  return verify(passwordHash, plainText);
}

export function getUserById(db: Database.Database, id: string): UserProfile | null {
  const row = db.prepare(`
    SELECT id, username, full_name, email, role, permissions, is_active, created_at, updated_at
    FROM users
    WHERE id = ? AND deleted_at IS NULL
  `).get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    permissions: JSON.parse(row.permissions || '[]'),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getUserByUsername(db: Database.Database, username: string): (UserProfile & { passwordHash: string }) | null {
  const row = db.prepare(`
    SELECT id, username, password_hash, full_name, email, role, permissions, is_active, created_at, updated_at
    FROM users
    WHERE username = ? AND deleted_at IS NULL
  `).get(username) as any;

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    permissions: JSON.parse(row.permissions || '[]'),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function authenticateLocalUser(
  db: Database.Database,
  username: string,
  plainTextPassword: string
): Promise<UserProfile> {
  const user = getUserByUsername(db, username.trim().toLowerCase());
  if (!user) {
    throw new Error('Invalid username or password.');
  }

  if (!user.isActive) {
    throw new Error('This account has been disabled. Please contact your administrator.');
  }

  const isValid = await verifyPassword(user.passwordHash, plainTextPassword);
  if (!isValid) {
    throw new Error('Invalid username or password.');
  }

  const { passwordHash: _hash, ...profile } = user;
  return profile;
}

export async function createLocalUser(
  db: Database.Database,
  data: {
    username: string;
    plainTextPassword: string;
    fullName?: string;
    email?: string;
    role: 'admin' | 'manager' | 'seller' | 'cashier' | 'accountant';
    permissions?: string[];
  }
): Promise<UserProfile> {
  const normalizedUsername = data.username.trim().toLowerCase();
  if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
    throw new RangeError('Username must be between 3 and 64 characters.');
  }
  if (data.plainTextPassword.length < 10) {
    throw new RangeError('Password must be at least 10 characters.');
  }
  if (!['admin', 'manager', 'seller', 'cashier', 'accountant'].includes(data.role)) {
    throw new RangeError('The selected role is not supported.');
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalizedUsername);
  if (existing) {
    throw new Error(`Username "${normalizedUsername}" already exists.`);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(data.plainTextPassword);
  const now = Math.floor(Date.now() / 1000);
  const permissionsJson = JSON.stringify(data.permissions || []);

  db.prepare(`
    INSERT INTO users (id, username, password_hash, full_name, email, role, permissions, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    normalizedUsername,
    passwordHash,
    data.fullName || null,
    data.email || null,
    data.role,
    permissionsJson,
    now,
    now
  );

  return {
    id,
    username: normalizedUsername,
    fullName: data.fullName || null,
    email: data.email || null,
    role: data.role,
    permissions: data.permissions || [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateLocalUserPassword(
  db: Database.Database,
  userId: string,
  newPlainTextPassword: string
): Promise<void> {
  if (newPlainTextPassword.length < 10) {
    throw new RangeError('Password must be at least 10 characters.');
  }
  const passwordHash = await hashPassword(newPlainTextPassword);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = ?
    WHERE id = ?
  `).run(passwordHash, now, userId);
}
