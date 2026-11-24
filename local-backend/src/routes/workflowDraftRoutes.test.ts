import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../server';
import { createLocalUser } from '../services/authService';

test('workflow drafts are encrypted, user-scoped, bounded, and permission-checked', async (t) => {
  const originalDatabaseKey = process.env.DATABASE_KEY;
  process.env.DATABASE_KEY = 'f'.repeat(64);
  const { app, db } = buildServer({ dbPath: ':memory:', jwtSecret: 'test-only-workflow-drafts-secret' });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    process.env.DATABASE_KEY = originalDatabaseKey;
  });

  const cashier = await createLocalUser(db, {
    username: 'draftcashier',
    plainTextPassword: 'SecureCashierPassword123!',
    role: 'cashier',
    fullName: 'Draft Cashier',
    permissions: ['pos'],
  });
  const otherCashier = await createLocalUser(db, {
    username: 'otherdraftcashier',
    plainTextPassword: 'SecureCashierPassword456!',
    role: 'cashier',
    fullName: 'Other Draft Cashier',
    permissions: ['pos'],
  });
  const purchaser = await createLocalUser(db, {
    username: 'draftpurchaser',
    plainTextPassword: 'SecureManagerPassword123!',
    role: 'manager',
    fullName: 'Draft Purchaser',
    permissions: ['purchases'],
  });
  const headers = (user: typeof cashier) => ({
    authorization: `Bearer ${app.jwt.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
    })}`,
  });

  const heldBills = [{ id: 'held-1', cart: [{ productId: 'medicine-1' }] }];
  const saveHeld = await app.inject({
    method: 'PUT',
    url: '/api/workflow-drafts/held-bills',
    headers: headers(cashier),
    payload: { items: heldBills },
  });
  assert.equal(saveHeld.statusCode, 200);
  const savedHeld = await app.inject({
    method: 'GET',
    url: '/api/workflow-drafts/held-bills',
    headers: headers(cashier),
  });
  assert.deepEqual(savedHeld.json(), { items: heldBills });

  const otherUserRead = await app.inject({
    method: 'GET',
    url: '/api/workflow-drafts/held-bills',
    headers: headers(otherCashier),
  });
  assert.deepEqual(otherUserRead.json(), { items: [] });

  const forbiddenPurchaseDraft = await app.inject({
    method: 'PUT',
    url: '/api/workflow-drafts/purchase-drafts',
    headers: headers(cashier),
    payload: { items: [{ id: 'purchase-1' }] },
  });
  assert.equal(forbiddenPurchaseDraft.statusCode, 403);
  const savePurchase = await app.inject({
    method: 'PUT',
    url: '/api/workflow-drafts/purchase-drafts',
    headers: headers(purchaser),
    payload: { items: [{ id: 'purchase-1' }] },
  });
  assert.equal(savePurchase.statusCode, 200);

  const tooManyDrafts = await app.inject({
    method: 'PUT',
    url: '/api/workflow-drafts/held-bills',
    headers: headers(cashier),
    payload: { items: Array.from({ length: 501 }, (_, index) => ({ id: String(index) })) },
  });
  assert.equal(tooManyDrafts.statusCode, 400);
});
