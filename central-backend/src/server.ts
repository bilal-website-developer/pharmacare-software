import fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { createActivationCode, hashActivationCode, signLicenseToken } from './licensingCrypto.js';
import { normalizeLicenseAccess } from './entitlementModel.js';

const app = fastify({ logger: true });
const serviceUrl = process.env.CENTRAL_SUPABASE_URL;
const serviceKey = process.env.CENTRAL_SUPABASE_SERVICE_KEY;

function getLicenseGraceDays(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 365
    ? Number(value)
    : 30;
}

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : false,
});
await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });

async function supabaseRequest(path: string, init: RequestInit = {}) {
  if (!serviceUrl || !serviceKey) {
    throw new Error('Central Supabase configuration is missing.');
  }
  const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Central Supabase request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

app.get('/api/health', async () => ({ status: 'ok', time: Date.now() }));

async function isDeveloperOwner(authorization: string | undefined): Promise<boolean> {
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken || !serviceUrl || !serviceKey) return false;
  const identityResponse = await fetch(`${serviceUrl.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!identityResponse.ok) return false;
  const identity = await identityResponse.json() as { id?: string };
  if (!identity.id) return false;
  const owners = await supabaseRequest(
    `developer_owners?user_id=eq.${encodeURIComponent(identity.id)}&is_active=eq.true&select=user_id`,
  ) as Array<{ user_id: string }>;
  return owners.length === 1;
}

app.addHook('preHandler', async (request, reply) => {
  const routePath = request.url.split('?')[0];
  if (
    routePath === '/api/health'
    || routePath === '/api/licensing/activate'
    || routePath === '/api/licensing/check-in'
  ) return;
  if (!serviceUrl || !serviceKey) {
    return reply.status(503).send({ error: 'Central licensing service is not configured.' });
  }
  try {
    if (await isDeveloperOwner(request.headers.authorization)) return;
    return reply.status(403).send({ error: 'Developer Owner access is required.' });
  } catch {
    return reply.status(503).send({ error: 'Developer Owner verification is unavailable.' });
  }
});

app.post('/api/licensing/shops', async (request, reply) => {
  const body = request.body as {
    shopName?: string;
    ownerEmail?: string;
    ownerPhone?: string;
    licenseType?: string;
    licenseExpiresAt?: string | null;
    activationExpiresAt?: string;
    enabledPages?: unknown;
    enabledFeatures?: unknown;
  };
  const access = normalizeLicenseAccess(body.enabledPages, body.enabledFeatures);
  if (!body.shopName) return reply.status(400).send({ error: 'shopName is required.' });
  if (body.shopName.trim().length > 160) return reply.status(400).send({ error: 'shopName is too long.' });
  if (!access) return reply.status(400).send({ error: 'One or more page or feature entitlements are invalid.' });
  const licenseExpiresAt = body.licenseExpiresAt ? new Date(body.licenseExpiresAt) : null;
  const activationExpiresAt = body.activationExpiresAt ? new Date(body.activationExpiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (
    (licenseExpiresAt && !Number.isFinite(licenseExpiresAt.getTime()))
    || !Number.isFinite(activationExpiresAt.getTime())
    || activationExpiresAt.getTime() <= Date.now()
  ) {
    return reply.status(400).send({ error: 'License and activation expiry dates must be valid future dates.' });
  }
  const shopCode = `SHP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const shop = await supabaseRequest('shops', {
    method: 'POST',
    body: JSON.stringify({
      shop_code: shopCode,
      shop_name: body.shopName.trim(),
      owner_email: body.ownerEmail?.trim() || null,
      owner_phone: body.ownerPhone || null,
      status: 'PENDING_ACTIVATION',
    }),
  });
  const shopRow = Array.isArray(shop) ? shop[0] : shop;
  const activationCode = createActivationCode();
  const licenseKey = crypto.randomBytes(32).toString('hex');
  await supabaseRequest('licenses', {
    method: 'POST',
    body: JSON.stringify({
      shop_id: shopRow.id,
      license_key: licenseKey,
      license_type: body.licenseType || 'STANDARD',
      expires_at: licenseExpiresAt?.toISOString() || null,
      status: 'ACTIVE',
      enabled_pages: access.enabledPages,
      enabled_features: access.enabledFeatures,
    }),
  });
  const activationRows = await supabaseRequest('shop_activations', {
    method: 'POST',
    body: JSON.stringify({
      shop_id: shopRow.id,
      activation_code_hash: hashActivationCode(activationCode),
      expires_at: activationExpiresAt.toISOString(),
    }),
  }) as Array<{ id: string }>;
  return reply.status(201).send({ shop: shopRow, activationCode, activationId: activationRows[0]?.id });
});

app.post('/api/licensing/activate', async (request, reply) => {
  const body = request.body as { activationCode?: string; hardwareId?: string };
  if (!body.activationCode || !body.hardwareId || !/^[a-f0-9]{64}$/i.test(body.hardwareId)) {
    return reply.status(400).send({ error: 'Activation code and a valid device fingerprint are required.' });
  }
  const signingKey = process.env.CENTRAL_LICENSE_PRIVATE_KEY || '';
  try {
    signLicenseToken({
      shopId: 'validation',
      shopName: 'validation',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      hardwareId: body.hardwareId,
      status: 'ACTIVE',
      graceDays: 30,
    }, signingKey);
  } catch {
    return reply.status(503).send({ error: 'Central license signing is not configured.' });
  }
  const codeHash = hashActivationCode(body.activationCode);
  const claimed = await supabaseRequest('rpc/consume_shop_activation', {
    method: 'POST',
    body: JSON.stringify({
      p_activation_hash: codeHash,
      p_hardware_fingerprint: body.hardwareId || null,
    }),
  }) as Array<{ shop_id: string }>;
  const activation = claimed[0];
  if (!activation) return reply.status(404).send({ error: 'Activation code is invalid, expired, used, or unavailable.' });
  const shops = await supabaseRequest(
    `shops?id=eq.${encodeURIComponent(activation.shop_id)}&select=*,licenses(expires_at,license_type,status,grace_days,enabled_pages,enabled_features)`,
  ) as Array<Record<string, any>>;
  const shop = shops[0];
  const license = Array.isArray(shop?.licenses) ? shop.licenses[0] : null;
  if (!shop || shop.status !== 'ACTIVE' || (license?.expires_at && new Date(license.expires_at).getTime() < Date.now())) {
    return reply.status(403).send({ error: 'This pharmacy license is not active.' });
  }
  const access = normalizeLicenseAccess(license?.enabled_pages, license?.enabled_features);
  if (!access) return reply.status(503).send({ error: 'Stored license entitlements are invalid.' });
  const licenseToken = signLicenseToken({
    shopId: activation.shop_id,
    shopName: shop.shop_name,
    expiresAt: license?.expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    hardwareId: body.hardwareId,
    status: shop.status === 'ACTIVE' && license?.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
    graceDays: getLicenseGraceDays(license?.grace_days),
    ...access,
  }, signingKey);
  return reply.send({ success: true, licenseToken, shop });
});

app.get('/api/licensing/shops', async () => {
  return supabaseRequest(
    'shops?select=id,shop_code,shop_name,owner_email,owner_phone,status,created_at,licenses(expires_at,license_type,status,enabled_pages,enabled_features)&order=created_at.desc',
  );
});

app.delete('/api/licensing/activations/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid activation key ID.' });
  const deleted = await supabaseRequest(
    `shop_activations?id=eq.${encodeURIComponent(id)}&is_used=eq.false`,
    { method: 'DELETE' },
  ) as Array<{ id: string }>;
  if (!deleted?.length) return reply.status(404).send({ error: 'Unused activation key was not found.' });
  return reply.send({ success: true });
});

app.patch('/api/licensing/shops/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid shop ID.' });
  const body = request.body as {
    status?: string;
    licenseExpiresAt?: string | null;
    enabledPages?: unknown;
    enabledFeatures?: unknown;
  };
  const allowedStatuses = new Set(['ACTIVE', 'SUSPENDED', 'REVOKED']);
  if (body.status && !allowedStatuses.has(body.status)) {
    return reply.status(400).send({ error: 'Status must be ACTIVE, SUSPENDED, or REVOKED.' });
  }
  if (body.licenseExpiresAt !== undefined) {
    const expiresAt = body.licenseExpiresAt === null ? null : new Date(body.licenseExpiresAt);
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) return reply.status(400).send({ error: 'Invalid license expiry date.' });
    await supabaseRequest(`licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ expires_at: expiresAt?.toISOString() || null }),
    });
  }
  if (body.enabledPages !== undefined || body.enabledFeatures !== undefined) {
    const currentRows = await supabaseRequest(
      `licenses?shop_id=eq.${encodeURIComponent(id)}&select=enabled_pages,enabled_features`,
    ) as Array<{ enabled_pages?: unknown; enabled_features?: unknown }>;
    const current = currentRows[0];
    if (!current) return reply.status(404).send({ error: 'Pharmacy license was not found.' });
    const access = normalizeLicenseAccess(
      body.enabledPages === undefined ? current.enabled_pages : body.enabledPages,
      body.enabledFeatures === undefined ? current.enabled_features : body.enabledFeatures,
    );
    if (!access) return reply.status(400).send({ error: 'One or more page or feature entitlements are invalid.' });
    await supabaseRequest(`licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        enabled_pages: access.enabledPages,
        enabled_features: access.enabledFeatures,
      }),
    });
  }
  if (body.status) {
    await supabaseRequest(`shops?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }),
    });
    await supabaseRequest(`licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.status }),
    });
  }
  return reply.send({ success: true });
});

app.post('/api/licensing/check-in', async (request, reply) => {
  const body = request.body as { shopId?: string; hardwareId?: string; appVersion?: string; osVersion?: string };
  if (!body.shopId || !body.hardwareId || !/^[a-f0-9]{64}$/i.test(body.hardwareId)) {
    return reply.status(400).send({ error: 'Shop ID and a valid device fingerprint are required.' });
  }
  const signingKey = process.env.CENTRAL_LICENSE_PRIVATE_KEY || '';
  try {
    signLicenseToken({
      shopId: 'validation',
      shopName: 'validation',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      hardwareId: body.hardwareId,
      status: 'ACTIVE',
      graceDays: 30,
    }, signingKey);
  } catch {
    return reply.status(503).send({ error: 'Central license signing is not configured.' });
  }
  const registeredDevices = await supabaseRequest(
    `shop_activations?shop_id=eq.${encodeURIComponent(body.shopId)}&is_used=eq.true&installation_fingerprint=eq.${encodeURIComponent(body.hardwareId)}&select=id`,
  ) as Array<{ id: string }>;
  if (!registeredDevices.length) {
    return reply.status(403).send({ error: 'This device is not registered for the pharmacy license.' });
  }
  const shops = await supabaseRequest(
    `shops?id=eq.${encodeURIComponent(body.shopId)}&select=id,shop_name,status,licenses(expires_at,grace_days,status,enabled_pages,enabled_features)`,
  ) as Array<Record<string, any>>;
  const shop = shops[0];
  const license = Array.isArray(shop?.licenses) ? shop.licenses[0] : null;
  if (!shop || !license) return reply.status(404).send({ error: 'Pharmacy license was not found.' });
  const status = shop.status === 'ACTIVE' && license.status === 'ACTIVE' ? 'ACTIVE'
    : shop.status === 'REVOKED' || license.status === 'REVOKED' ? 'REVOKED'
      : 'SUSPENDED';
  const access = normalizeLicenseAccess(license.enabled_pages, license.enabled_features);
  if (!access) return reply.status(503).send({ error: 'Stored license entitlements are invalid.' });
  const licenseToken = signLicenseToken({
    shopId: shop.id,
    shopName: shop.shop_name,
    expiresAt: license.expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    hardwareId: body.hardwareId,
    status,
    graceDays: getLicenseGraceDays(license.grace_days),
    ...access,
  }, signingKey);
  await supabaseRequest('shop_checkins', {
    method: 'POST',
    body: JSON.stringify({
      shop_id: body.shopId,
      app_version: body.appVersion || 'unknown',
      os_version: body.osVersion || 'unknown',
    }),
  });
  return reply.send({ success: true, licenseToken });
});

const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
