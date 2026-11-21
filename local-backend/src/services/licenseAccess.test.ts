import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LICENSE_ACCESS,
  normalizeLicenseAccess,
} from './licenseAccess';

test('legacy licenses enable existing pages and features while explicit empty entitlements stay disabled', () => {
  assert.deepEqual(normalizeLicenseAccess(undefined, undefined), DEFAULT_LICENSE_ACCESS);
  assert.deepEqual(normalizeLicenseAccess([], []), { enabledPages: [], enabledFeatures: [] });
  assert.equal(normalizeLicenseAccess(['unknown-page'], []), null);
  assert.equal(normalizeLicenseAccess([], ['unknown-feature']), null);
});
