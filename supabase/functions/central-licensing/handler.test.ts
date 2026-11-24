import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createCentralLicensingHandler } from './handler.ts';

const supabaseUrl = 'https://project.example.supabase.co';
const serviceRoleKey = 'test-service-role-key';

function makeHandler(fetcher: typeof fetch = fetch, licensePrivateKey = '') {
  return createCentralLicensingHandler({
    supabaseUrl,
    serviceRoleKey,
    licensePrivateKey,
    corsOrigins: ['https://dashboard.example'],
  }, fetcher);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Edge Function health supports gateway and stripped function paths with dashboard CORS', async () => {
  const handler = makeHandler(async () => {
    throw new Error('Health must not call Supabase.');
  });
  for (const path of [
    '/functions/v1/central-licensing/api/health',
    '/central-licensing/api/health',
  ]) {
    const result = await handler(new Request(
      `${supabaseUrl}${path}`,
      { headers: { Origin: 'https://dashboard.example' } },
    ));

    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://dashboard.example');
    assert.equal((await result.json()).status, 'ok');
  }
});

test('unlisted or unauthenticated users cannot access Developer endpoints', async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    throw new Error('No token should mean no upstream request.');
  });
  const result = await handler(new Request(
    `${supabaseUrl}/functions/v1/central-licensing/api/licensing/shops`,
  ));

  assert.equal(result.status, 403);
  assert.equal(fetchCount, 0);
});

test('Developer shop creation is owner-gated and writes only through the atomic licensing RPC', async () => {
  const ownerId = 'c0ffee00-0000-4000-8000-000000000002';
  const paths: string[] = [];
  let persisted: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith('/auth/v1/user')) return response({ id: ownerId });
    if (url.pathname.endsWith('/central_developer_owners')) return response([{ user_id: ownerId }]);
    if (url.pathname.endsWith('/rpc/central_create_shop')) {
      persisted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({
        shop: { id: 'c0ffee00-0000-4000-8000-000000000003', shop_name: 'Test Pharmacy' },
        activationId: 'c0ffee00-0000-4000-8000-000000000004',
      });
    }
    return response({ message: 'Unexpected request.' }, 500);
  };
  const handler = makeHandler(fetcher);
  const result = await handler(new Request(
    `${supabaseUrl}/functions/v1/central-licensing/api/licensing/shops`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ shopName: 'Test Pharmacy', graceDays: 30, warningDays: 14 }),
    },
  ));

  assert.equal(result.status, 201);
  const body = await result.json();
  assert.match(body.activationCode, /^[A-F0-9]{48}$/);
  assert.equal(body.activationId, 'c0ffee00-0000-4000-8000-000000000004');
  assert.equal(persisted?.p_shop_name, 'Test Pharmacy');
  assert.match(String(persisted?.p_activation_code_hash), /^[a-f0-9]{64}$/);
  assert.notEqual(persisted?.p_activation_code_hash, body.activationCode);
  assert.ok(paths.some((path) => path.endsWith('/rpc/central_create_shop')));
  assert.ok(paths.every((path) => path.includes('/auth/v1/user') || path.endsWith('/central_developer_owners') || path.endsWith('/rpc/central_create_shop')));
});

test('activation validates input before using Supabase', async () => {
  let fetchCount = 0;
  const handler = makeHandler(async () => {
    fetchCount += 1;
    throw new Error('Invalid input must not call Supabase.');
  });
  const result = await handler(new Request(
    `${supabaseUrl}/functions/v1/central-licensing/api/licensing/activate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationCode: 'test', hardwareId: 'invalid' }),
    },
  ));

  assert.equal(result.status, 400);
  assert.equal(fetchCount, 0);
});

test('activation consumes a namespaced one-time code and returns a verifiable Ed25519 token', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const licensePrivateKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const shopId = 'c0ffee00-0000-4000-8000-000000000001';
  const hardwareId = 'a'.repeat(64);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith('/rpc/central_consume_shop_activation')) {
      return response([{ shop_id: shopId }]);
    }
    if (url.pathname.endsWith('/central_shops')) {
      return response([{
        id: shopId,
        shop_name: 'Test Pharmacy',
        status: 'ACTIVE',
      }]);
    }
    if (url.pathname.endsWith('/central_licenses')) {
      return response([{
        expires_at: '2027-01-01T00:00:00.000Z',
        license_type: 'STANDARD',
        status: 'ACTIVE',
        grace_days: 30,
        warning_days: 14,
        enabled_pages: ['pos', 'products'],
        enabled_features: ['pos_print_sale'],
      }]);
    }
    return response({ message: 'Unexpected request.' }, 500);
  };
  const handler = makeHandler(fetcher, licensePrivateKey);
  const result = await handler(new Request(
    `${supabaseUrl}/functions/v1/central-licensing/api/licensing/activate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationCode: 'A'.repeat(48), hardwareId }),
    },
  ));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.success, true);
  const parts = body.licenseToken.split('.');
  assert.equal(parts.length, 3);
  const signature = Buffer.from(parts[2], 'base64url');
  assert.equal(
    verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature),
    true,
  );
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(claims.shopId, shopId);
  assert.deepEqual(claims.enabledPages, ['pos', 'products']);
  assert.ok(requests.some((path) => path.endsWith('/rpc/central_consume_shop_activation')));
  assert.ok(requests.every((path) => !path.endsWith('/shops') && !path.endsWith('/licenses')));
});
