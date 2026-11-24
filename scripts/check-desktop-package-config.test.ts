import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardScript = path.join(root, 'scripts', 'check-desktop-package-config.mjs');

test('desktop package preflight names missing public configuration without echoing values', () => {
  const result = spawnSync(process.execPath, [guardScript], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CENTRAL_API_URL/);
  assert.match(result.stderr, /CENTRAL_LICENSE_PUBLIC_KEY/);
});

test('desktop package preflight accepts placeholder configuration', () => {
  const result = spawnSync(process.execPath, [guardScript], {
    encoding: 'utf8',
    env: {
      CENTRAL_API_URL: 'https://licensing.example.invalid',
      CENTRAL_LICENSE_PUBLIC_KEY: '<PUBLIC_KEY_PLACEHOLDER>',
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Supabase Edge Function desktop builds require its public API key', () => {
  const result = spawnSync(process.execPath, [guardScript], {
    encoding: 'utf8',
    env: {
      CENTRAL_API_URL: 'https://project.supabase.co/functions/v1/central-licensing',
      CENTRAL_LICENSE_PUBLIC_KEY: '<PUBLIC_KEY_PLACEHOLDER>',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CENTRAL_SUPABASE_ANON_KEY/);
});

test('Supabase Edge Function desktop builds accept the public API key', () => {
  const result = spawnSync(process.execPath, [guardScript], {
    encoding: 'utf8',
    env: {
      CENTRAL_API_URL: 'https://project.supabase.co/functions/v1/central-licensing',
      CENTRAL_LICENSE_PUBLIC_KEY: '<PUBLIC_KEY_PLACEHOLDER>',
      CENTRAL_SUPABASE_ANON_KEY: '<PUBLIC_ANON_KEY_PLACEHOLDER>',
    },
  });
  assert.equal(result.status, 0, result.stderr);
});
