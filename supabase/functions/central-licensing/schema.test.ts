import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const setupPath = fileURLToPath(new URL('../../production/setup.sql', import.meta.url));

test('central licensing SQL uses app-safe table and RPC names', async () => {
  const sql = await readFile(setupPath, 'utf8');

  assert.match(sql, /create table if not exists public\.central_shops/i);
  assert.match(sql, /create table if not exists public\.central_licenses/i);
  assert.match(sql, /function public\.central_create_shop/i);
  assert.doesNotMatch(
    sql,
    /\bpublic\.(?:shops|licenses|developer_owners|shop_activations|shop_checkins|shop_announcements|latest_shop_checkins)\b/i,
  );
});
