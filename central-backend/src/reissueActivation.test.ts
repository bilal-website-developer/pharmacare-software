import assert from 'node:assert/strict';
import test from 'node:test';
import { issueReplacementActivation } from './reissueActivation.js';

test('replacement activation persists only a hash before returning the one-time code', async () => {
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const persisted: Array<{ shopId: string; activationHash: string; expiresAt: string }> = [];
  const result = await issueReplacementActivation('shop-id', expiresAt, async (activation) => {
    persisted.push(activation);
    return 'activation-id';
  });

  assert.ok(result);
  assert.match(result.activationCode, /^[A-F0-9]{48}$/);
  assert.equal(result.activationId, 'activation-id');
  const captured = persisted[0];
  assert.ok(captured);
  assert.match(captured.activationHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(captured, {
    shopId: 'shop-id',
    activationHash: captured.activationHash,
    expiresAt,
  });
  assert.notEqual(captured.activationHash, result.activationCode);
});

test('replacement code is not returned when the persistence transaction declines the request', async () => {
  const result = await issueReplacementActivation(
    'inactive-shop',
    new Date(Date.now() + 7 * 86400000).toISOString(),
    async () => null,
  );
  assert.equal(result, null);
});
