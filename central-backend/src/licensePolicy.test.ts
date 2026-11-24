import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWarningDays, normalizeOfflineLicensePolicy } from './licensePolicy.js';

test('offline license policy requires a warning window within its grace period', () => {
  assert.deepEqual(normalizeOfflineLicensePolicy(30, 7), { graceDays: 30, warningDays: 7 });
  assert.deepEqual(normalizeOfflineLicensePolicy(1, 1), { graceDays: 1, warningDays: 1 });
  assert.equal(normalizeOfflineLicensePolicy(30, 31), null);
  assert.equal(normalizeOfflineLicensePolicy(0, 1), null);
  assert.equal(normalizeOfflineLicensePolicy(366, 14), null);
  assert.equal(defaultWarningDays(30), 14);
  assert.equal(defaultWarningDays(7), 7);
});
