import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('sidebar preferences are persisted per local user and validated', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'e'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-preference-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });
  const admin = await createLocalUser(db, {
    username: 'prefsadmin',
    plainTextPassword: 'SecureAdminPassword123!',
    role: 'admin',
  });
  const headers = {
    authorization: `Bearer ${app.jwt.sign({ userId: admin.id, role: admin.role, permissions: [] })}`,
  };

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/preferences/sidebar',
    headers,
    payload: { favoritePageKeys: ['products', 'reports'], tipDismissed: true },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const loaded = await app.inject({ method: 'GET', url: '/api/preferences/sidebar', headers });
  assert.equal(loaded.statusCode, 200, loaded.body);
  assert.deepEqual(loaded.json(), { favoritePageKeys: ['products', 'reports'], tipDismissed: true });

  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/preferences/sidebar',
    headers,
    payload: { favoritePageKeys: Array(9).fill('products'), tipDismissed: false },
  });
  assert.equal(invalid.statusCode, 400);
});
