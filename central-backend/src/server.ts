import fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { createActivationCode, hashActivationCode, signLicenseToken } from './licensingCrypto.js';
import { normalizeLicenseAccess } from './entitlementModel.js';
import { issueReplacementActivation } from './reissueActivation.js';
import { defaultWarningDays, normalizeOfflineLicensePolicy } from './licensePolicy.js';

const app = fastify({ logger: true });
const serviceUrl = process.env.CENTRAL_SUPABASE_URL;
const serviceKey = process.env.CENTRAL_SUPABASE_SERVICE_KEY;

function getLicenseGraceDays(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 365
    ? Number(value)
    : 30;
}

function getLicenseWarningDays(value: unknown, graceDays: number): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= graceDays
    ? Number(value)
    : defaultWarningDays(graceDays);
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

async function getDeveloperOwnerId(authorization: string | undefined): Promise<string | null> {
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken || !serviceUrl || !serviceKey) return null;
  const identityResponse = await fetch(`${serviceUrl.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!identityResponse.ok) return null;
  const identity = await identityResponse.json() as { id?: string };
  if (!identity.id) return null;
  const owners = await supabaseRequest(
    `central_developer_owners?user_id=eq.${encodeURIComponent(identity.id)}&is_active=eq.true&select=user_id`,
  ) as Array<{ user_id: string }>;
  return owners.length === 1 ? identity.id : null;
}

async function isDeveloperOwner(authorization: string | undefined): Promise<boolean> {
  return Boolean(await getDeveloperOwnerId(authorization));
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
    graceDays?: unknown;
    warningDays?: unknown;
  };
  const access = normalizeLicenseAccess(body.enabledPages, body.enabledFeatures);
  if (!body.shopName) return reply.status(400).send({ error: 'shopName is required.' });
  if (body.shopName.trim().length > 160) return reply.status(400).send({ error: 'shopName is too long.' });
  if (!access) return reply.status(400).send({ error: 'One or more page or feature entitlements are invalid.' });
  const requestedGraceDays = body.graceDays ?? 30;
  const defaultWarning = Number.isInteger(requestedGraceDays)
    ? defaultWarningDays(Number(requestedGraceDays))
    : 14;
  const policy = normalizeOfflineLicensePolicy(requestedGraceDays, body.warningDays ?? defaultWarning);
  if (!policy) return reply.status(400).send({ error: 'Offline grace must be 1-365 days and the warning period must be within grace.' });
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
  const activationCode = createActivationCode();
  const licenseKey = crypto.randomBytes(32).toString('hex');
  const created = await supabaseRequest('rpc/central_create_shop', {
    method: 'POST',
    body: JSON.stringify({
      p_shop_code: shopCode,
      p_shop_name: body.shopName.trim(),
      p_owner_email: body.ownerEmail?.trim() || null,
      p_owner_phone: body.ownerPhone?.trim() || null,
      p_license_key: licenseKey,
      p_license_type: body.licenseType || 'STANDARD',
      p_license_expires_at: licenseExpiresAt?.toISOString() || null,
      p_grace_days: policy.graceDays,
      p_warning_days: policy.warningDays,
      p_enabled_pages: access.enabledPages,
      p_enabled_features: access.enabledFeatures,
      p_activation_code_hash: hashActivationCode(activationCode),
      p_activation_expires_at: activationExpiresAt.toISOString(),
    }),
  }) as { shop: Record<string, unknown>; activationId: string };
  return reply.status(201).send({
    shop: created.shop,
    activationCode,
    activationId: created.activationId,
  });
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
  const claimed = await supabaseRequest('rpc/central_consume_shop_activation', {
    method: 'POST',
    body: JSON.stringify({
      p_activation_hash: codeHash,
      p_hardware_fingerprint: body.hardwareId || null,
    }),
  }) as Array<{ shop_id: string }>;
  const activation = claimed[0];
  if (!activation) return reply.status(404).send({ error: 'Activation code is invalid, expired, used, or unavailable.' });
  const shops = await supabaseRequest(
    `central_shops?id=eq.${encodeURIComponent(activation.shop_id)}&select=*,central_licenses(expires_at,license_type,status,grace_days,warning_days,enabled_pages,enabled_features)`,
  ) as Array<Record<string, any>>;
  const shop = shops[0];
  const license = Array.isArray(shop?.central_licenses) ? shop.central_licenses[0] : null;
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
    warningDays: getLicenseWarningDays(license?.warning_days, getLicenseGraceDays(license?.grace_days)),
    ...access,
  }, signingKey);
  return reply.send({ success: true, licenseToken, shop });
});

app.get('/api/licensing/shops', async () => {
  const [shops, licenses, checkins] = await Promise.all([
    supabaseRequest(
      'central_shops?select=id,shop_code,shop_name,owner_email,owner_phone,status,created_at&order=created_at.desc',
    ) as Promise<Array<Record<string, any>>>,
    supabaseRequest(
      'central_licenses?select=shop_id,expires_at,license_type,status,grace_days,warning_days,enabled_pages,enabled_features',
    ) as Promise<Array<Record<string, any>>>,
    supabaseRequest(
      'central_latest_shop_checkins?select=shop_id,app_version,os_version,admin_setup_complete,checkin_time',
    ) as Promise<Array<Record<string, any>>>,
  ]);
  const licensesByShop = new Map(licenses.map((license) => [license.shop_id, license]));
  const latestByShop = new Map(checkins.map((row) => [row.shop_id, row]));
  return shops.map((shop) => {
    const license = licensesByShop.get(shop.id);
    return {
      ...shop,
      licenses: license ? [license] : [],
      latestCheckin: latestByShop.get(shop.id) || null,
    };
  });
});

app.get('/api/licensing/announcements', async () => {
  return supabaseRequest(
    'central_shop_announcements?select=id,title,body,target_shop_ids,is_global,is_published,created_at,updated_at,published_at,created_by&order=created_at.desc',
  );
});

app.post('/api/licensing/announcements', async (request, reply) => {
  const body = request.body as {
    title?: string;
    message?: string;
    targetShopIds?: unknown;
    isGlobal?: boolean;
    isPublished?: boolean;
  };
  if (!body || typeof body !== 'object') {
    return reply.status(400).send({ error: 'Announcement details are required.' });
  }
  const title = body.title?.trim();
  const message = body.message?.trim();
  const targetShopIds = body.targetShopIds;
  if (!title || title.length > 120 || !message || message.length > 2000) {
    return reply.status(400).send({ error: 'A title (1-120 characters) and message (1-2000 characters) are required.' });
  }
  if (typeof body.isPublished !== 'boolean' || (
    typeof body.isGlobal !== 'boolean'
    || (body.isGlobal !== true && (
      !Array.isArray(targetShopIds)
      || targetShopIds.length < 1
      || targetShopIds.length > 500
      || targetShopIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
    ))
  )) return reply.status(400).send({ error: 'Select at least one valid target shop, or choose all shops.' });
  const uniqueTargetShopIds = body.isGlobal ? [] : [...new Set(targetShopIds as string[])];
  if (!body.isGlobal) {
    const targetRows = await supabaseRequest(
      `central_shops?id=in.(${uniqueTargetShopIds.map(encodeURIComponent).join(',')})&select=id`,
    ) as Array<{ id: string }>;
    if (targetRows.length !== uniqueTargetShopIds.length) {
      return reply.status(400).send({ error: 'One or more selected shops do not exist.' });
    }
  }
  const published = body.isPublished;
  const ownerId = await getDeveloperOwnerId(request.headers.authorization);
  if (!ownerId) return reply.status(403).send({ error: 'Developer Owner access is required.' });
  const rows = await supabaseRequest('central_shop_announcements', {
    method: 'POST',
    body: JSON.stringify({
      title,
      body: message,
      target_shop_ids: uniqueTargetShopIds,
      is_global: body.isGlobal,
      is_published: published,
      created_by: ownerId,
      published_at: published ? new Date().toISOString() : null,
    }),
  }) as Array<Record<string, unknown>>;
  return reply.status(201).send(rows[0]);
});

app.patch('/api/licensing/announcements/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid announcement ID.' });
  const body = request.body as { isPublished?: unknown } | null;
  if (!body || typeof body.isPublished !== 'boolean') {
    return reply.status(400).send({ error: 'isPublished must be true or false.' });
  }
  const rows = await supabaseRequest(`central_shop_announcements?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      is_published: body.isPublished,
      published_at: body.isPublished ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  }) as Array<Record<string, unknown>>;
  if (!rows.length) return reply.status(404).send({ error: 'Announcement was not found.' });
  return reply.send(rows[0]);
});

app.delete('/api/licensing/announcements/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid announcement ID.' });
  const rows = await supabaseRequest(`central_shop_announcements?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }) as Array<Record<string, unknown>>;
  if (!rows.length) return reply.status(404).send({ error: 'Announcement was not found.' });
  return reply.send({ success: true });
});

app.delete('/api/licensing/activations/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid activation key ID.' });
  const deleted = await supabaseRequest(
    `central_shop_activations?id=eq.${encodeURIComponent(id)}&is_used=eq.false`,
    { method: 'DELETE' },
  ) as Array<{ id: string }>;
  if (!deleted?.length) return reply.status(404).send({ error: 'Unused activation key was not found.' });
  return reply.send({ success: true });
});

app.post('/api/licensing/shops/:id/reissue', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid pharmacy ID.' });

  const body = request.body as { activationExpiresAt?: string };
  const expiresAt = body?.activationExpiresAt
    ? new Date(body.activationExpiresAt)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return reply.status(400).send({ error: 'Activation key expiry must be a valid future date.' });
  }

  const activation = await issueReplacementActivation(id, expiresAt.toISOString(), async (replacement) => {
    const rows = await supabaseRequest('rpc/central_reissue_shop_activation', {
      method: 'POST',
      body: JSON.stringify({
        p_shop_id: replacement.shopId,
        p_activation_hash: replacement.activationHash,
        p_expires_at: replacement.expiresAt,
      }),
    }) as Array<{ id: string }>;
    return rows[0]?.id || null;
  });
  if (!activation) {
    return reply.status(409).send({ error: 'An active pharmacy license is required to reissue for a new PC.' });
  }
  return reply.status(201).send(activation);
});

app.patch('/api/licensing/shops/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Invalid shop ID.' });
  const body = request.body as {
    status?: string;
    licenseExpiresAt?: string | null;
    enabledPages?: unknown;
    enabledFeatures?: unknown;
    graceDays?: unknown;
    warningDays?: unknown;
  };
  const allowedStatuses = new Set(['ACTIVE', 'SUSPENDED', 'REVOKED']);
  if (body.status && !allowedStatuses.has(body.status)) {
    return reply.status(400).send({ error: 'Status must be ACTIVE, SUSPENDED, or REVOKED.' });
  }
  if (body.graceDays !== undefined || body.warningDays !== undefined) {
    const currentRows = await supabaseRequest(
      `central_licenses?shop_id=eq.${encodeURIComponent(id)}&select=grace_days,warning_days`,
    ) as Array<{ grace_days?: unknown; warning_days?: unknown }>;
    const current = currentRows[0];
    if (!current) return reply.status(404).send({ error: 'Pharmacy license was not found.' });
    const policy = normalizeOfflineLicensePolicy(
      body.graceDays ?? current.grace_days ?? 30,
      body.warningDays ?? current.warning_days ?? 14,
    );
    if (!policy) return reply.status(400).send({ error: 'Offline grace must be 1-365 days and the warning period must be within grace.' });
    await supabaseRequest(`central_licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ grace_days: policy.graceDays, warning_days: policy.warningDays }),
    });
  }
  if (body.licenseExpiresAt !== undefined) {
    const expiresAt = body.licenseExpiresAt === null ? null : new Date(body.licenseExpiresAt);
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) return reply.status(400).send({ error: 'Invalid license expiry date.' });
    await supabaseRequest(`central_licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ expires_at: expiresAt?.toISOString() || null }),
    });
  }
  if (body.enabledPages !== undefined || body.enabledFeatures !== undefined) {
    const currentRows = await supabaseRequest(
      `central_licenses?shop_id=eq.${encodeURIComponent(id)}&select=enabled_pages,enabled_features`,
    ) as Array<{ enabled_pages?: unknown; enabled_features?: unknown }>;
    const current = currentRows[0];
    if (!current) return reply.status(404).send({ error: 'Pharmacy license was not found.' });
    const access = normalizeLicenseAccess(
      body.enabledPages === undefined ? current.enabled_pages : body.enabledPages,
      body.enabledFeatures === undefined ? current.enabled_features : body.enabledFeatures,
    );
    if (!access) return reply.status(400).send({ error: 'One or more page or feature entitlements are invalid.' });
    await supabaseRequest(`central_licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        enabled_pages: access.enabledPages,
        enabled_features: access.enabledFeatures,
      }),
    });
  }
  if (body.status) {
    await supabaseRequest(`central_shops?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }),
    });
    await supabaseRequest(`central_licenses?shop_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.status }),
    });
  }
  return reply.send({ success: true });
});

app.post('/api/licensing/check-in', async (request, reply) => {
  const body = request.body as {
    shopId?: string;
    hardwareId?: string;
    appVersion?: string;
    osVersion?: string;
    adminSetupComplete?: boolean;
  };
  if (!body.shopId || !body.hardwareId || !/^[a-f0-9]{64}$/i.test(body.hardwareId)) {
    return reply.status(400).send({ error: 'Shop ID and a valid device fingerprint are required.' });
  }
  if (
    (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.length > 80))
    || (body.osVersion !== undefined && (typeof body.osVersion !== 'string' || body.osVersion.length > 160))
    || (body.adminSetupComplete !== undefined && typeof body.adminSetupComplete !== 'boolean')
  ) return reply.status(400).send({ error: 'Check-in metadata is invalid.' });
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
    `central_shop_activations?shop_id=eq.${encodeURIComponent(body.shopId)}&is_used=eq.true&installation_fingerprint=eq.${encodeURIComponent(body.hardwareId)}&select=id`,
  ) as Array<{ id: string }>;
  if (!registeredDevices.length) {
    return reply.status(403).send({ error: 'This device is not registered for the pharmacy license.' });
  }
  const shops = await supabaseRequest(
    `central_shops?id=eq.${encodeURIComponent(body.shopId)}&select=id,shop_name,status,central_licenses(expires_at,grace_days,warning_days,status,enabled_pages,enabled_features)`,
  ) as Array<Record<string, any>>;
  const shop = shops[0];
  const license = Array.isArray(shop?.central_licenses) ? shop.central_licenses[0] : null;
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
    warningDays: getLicenseWarningDays(license.warning_days, getLicenseGraceDays(license.grace_days)),
    ...access,
  }, signingKey);
  await supabaseRequest('central_shop_checkins', {
    method: 'POST',
    body: JSON.stringify({
      shop_id: body.shopId,
      app_version: body.appVersion || 'unknown',
      os_version: body.osVersion || 'unknown',
      admin_setup_complete: body.adminSetupComplete === true,
    }),
  });
  const globalAnnouncements = await supabaseRequest(
    'central_shop_announcements?is_published=eq.true&is_global=eq.true&select=id,title,body,published_at&order=published_at.desc&limit=200',
  ) as Array<Record<string, unknown>>;
  const targetedAnnouncements = await supabaseRequest(
    `central_shop_announcements?is_published=eq.true&is_global=eq.false&target_shop_ids=cs.{${encodeURIComponent(body.shopId)}}&select=id,title,body,published_at&order=published_at.desc&limit=200`,
  ) as Array<Record<string, unknown>>;
  return reply.send({
    success: true,
    licenseToken,
    announcements: [...globalAnnouncements, ...targetedAnnouncements].slice(0, 200),
  });
});

const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
