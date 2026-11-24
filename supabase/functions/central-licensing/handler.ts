type JsonRecord = Record<string, unknown>;

interface CentralConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  licensePrivateKey: string;
  corsOrigins: string[];
}

interface LicenseAccess {
  enabledPages: string[];
  enabledFeatures: string[];
}

interface LicenseClaims extends LicenseAccess {
  shopId: string;
  shopName: string;
  expiresAt: string;
  hardwareId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  graceDays: number;
  warningDays: number;
}

const pageKeys = [
  'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
  'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
  'manage_users', 'settings',
];
const featureKeys = [
  'pos_print_sale', 'pos_print_payment', 'settings_shop_profile',
  'settings_receipt_memo', 'settings_receipt_qr', 'settings_operations',
  'settings_demo_data', 'settings_whatsapp_templates',
];
const encoder = new TextEncoder();

class SupabaseRequestError extends Error {
  constructor(readonly status: number) {
    super(`Supabase request failed (${status}).`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAccess(pages: unknown, features: unknown): LicenseAccess | null {
  const normalize = (value: unknown, allowed: string[]) => {
    if (value === undefined || value === null) return [...allowed];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry))) {
      return null;
    }
    return [...new Set(value as string[])];
  };
  const enabledPages = normalize(pages, pageKeys);
  const enabledFeatures = normalize(features, featureKeys);
  return enabledPages && enabledFeatures ? { enabledPages, enabledFeatures } : null;
}

function normalizePolicy(graceDays: unknown, warningDays: unknown): { graceDays: number; warningDays: number } | null {
  if (
    !Number.isInteger(graceDays) || Number(graceDays) < 1 || Number(graceDays) > 365
    || !Number.isInteger(warningDays) || Number(warningDays) < 1
    || Number(warningDays) > Number(graceDays)
  ) return null;
  return { graceDays: Number(graceDays), warningDays: Number(warningDays) };
}

function defaultWarningDays(graceDays: number): number {
  return Math.min(14, graceDays);
}

function boundedDays(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 365
    ? Number(value)
    : fallback;
}

function boundedWarningDays(value: unknown, graceDays: number): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= graceDays
    ? Number(value)
    : defaultWarningDays(graceDays);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const decoded = atob(body);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function signLicenseToken(claims: LicenseClaims, pem: string): Promise<string> {
  if (!pem) throw new Error('License signing is not configured.');
  const policy = normalizePolicy(claims.graceDays, claims.warningDays);
  if (!policy) throw new Error('License offline policy is invalid.');
  const access = normalizeAccess(claims.enabledPages, claims.enabledFeatures);
  if (!access) throw new Error('License entitlements are invalid.');
  const keyBytes = pemToBytes(pem);
  const keyData = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyData).set(keyBytes);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({
    ...claims,
    ...policy,
    ...access,
  })));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('Ed25519', key, encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashActivationCode(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createActivationCode(): string {
  return randomHex(24).toUpperCase();
}

function getFunctionRoute(pathname: string): string {
  const prefixes = [
    '/functions/v1/central-licensing',
    '/central-licensing',
  ];
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length) || '/';
    }
  }
  return pathname || '/';
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

async function readJson(request: Request): Promise<JsonRecord | null> {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 64 * 1024) return null;
  const text = await request.text();
  if (text.length > 64 * 1024) return null;
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value);
}

export function createCentralLicensingHandler(
  config: CentralConfig,
  fetcher: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  const baseUrl = config.supabaseUrl.replace(/\/+$/, '');
  const corsOrigins = new Set(config.corsOrigins.filter(Boolean));

  function corsHeaders(request: Request): HeadersInit {
    const origin = request.headers.get('origin');
    const allowedOrigin = origin && (corsOrigins.has(origin) || corsOrigins.has('*'))
      ? origin
      : null;
    return {
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      Vary: 'Origin',
    };
  }

  async function supabaseRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!baseUrl || !config.serviceRoleKey) {
      throw new Error('Supabase function secrets are not configured.');
    }
    const response = await fetcher(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new SupabaseRequestError(response.status);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : null;
  }

  async function developerOwnerId(authorization: string | null): Promise<string | null> {
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken || !baseUrl || !config.serviceRoleKey) return null;
    const response = await fetcher(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return null;
    const identity: unknown = await response.json();
    if (!isRecord(identity) || typeof identity.id !== 'string') return null;
    const owners = await supabaseRequest(
      `central_developer_owners?user_id=eq.${encodeFilter(identity.id)}&is_active=eq.true&select=user_id`,
    ) as Array<{ user_id: string }>;
    return owners.length === 1 ? identity.id : null;
  }

  async function databaseArray<T>(path: string, init?: RequestInit): Promise<T[]> {
    const value = await supabaseRequest(path, init);
    return Array.isArray(value) ? value as T[] : [];
  }

  return async (request: Request): Promise<Response> => {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const route = getFunctionRoute(new URL(request.url).pathname);
    if (route === '/api/health' && request.method === 'GET') {
      return jsonResponse(200, { status: 'ok', time: Date.now() }, headers);
    }

    const isPublicRoute = (
      route === '/api/licensing/activate' && request.method === 'POST'
    ) || (
      route === '/api/licensing/check-in' && request.method === 'POST'
    );
    if (!isPublicRoute) {
      if (!baseUrl || !config.serviceRoleKey) {
        return jsonResponse(503, { error: 'Central licensing service is not configured.' }, headers);
      }
      try {
        if (!await developerOwnerId(request.headers.get('authorization'))) {
          return jsonResponse(403, { error: 'Developer Owner access is required.' }, headers);
        }
      } catch {
        return jsonResponse(503, { error: 'Developer Owner verification is unavailable.' }, headers);
      }
    }

    try {
      if (route === '/api/licensing/shops' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body) return jsonResponse(400, { error: 'A valid JSON request body is required.' }, headers);
        const access = normalizeAccess(body.enabledPages, body.enabledFeatures);
        if (typeof body.shopName !== 'string' || !body.shopName.trim()) {
          return jsonResponse(400, { error: 'shopName is required.' }, headers);
        }
        if (body.shopName.trim().length > 160) return jsonResponse(400, { error: 'shopName is too long.' }, headers);
        if (!access) return jsonResponse(400, { error: 'One or more page or feature entitlements are invalid.' }, headers);
        const requestedGrace = body.graceDays ?? 30;
        const graceDays = Number.isInteger(requestedGrace) ? Number(requestedGrace) : 30;
        const policy = normalizePolicy(graceDays, body.warningDays ?? defaultWarningDays(graceDays));
        if (!policy) return jsonResponse(400, { error: 'Offline grace must be 1-365 days and the warning period must be within grace.' }, headers);
        const licenseExpiresAt = body.licenseExpiresAt ? new Date(String(body.licenseExpiresAt)) : null;
        const activationExpiresAt = body.activationExpiresAt
          ? new Date(String(body.activationExpiresAt))
          : new Date(Date.now() + 7 * 86400000);
        if (
          (licenseExpiresAt && !Number.isFinite(licenseExpiresAt.getTime()))
          || !Number.isFinite(activationExpiresAt.getTime())
          || activationExpiresAt.getTime() <= Date.now()
        ) return jsonResponse(400, { error: 'License and activation expiry dates must be valid future dates.' }, headers);
        const activationCode = createActivationCode();
        const created = await supabaseRequest('rpc/central_create_shop', {
          method: 'POST',
          body: JSON.stringify({
            p_shop_code: `SHP-${randomHex(4).toUpperCase()}`,
            p_shop_name: body.shopName.trim(),
            p_owner_email: typeof body.ownerEmail === 'string' ? body.ownerEmail.trim() || null : null,
            p_owner_phone: typeof body.ownerPhone === 'string' ? body.ownerPhone.trim() || null : null,
            p_license_key: randomHex(32),
            p_license_type: typeof body.licenseType === 'string' ? body.licenseType : 'STANDARD',
            p_license_expires_at: licenseExpiresAt?.toISOString() || null,
            p_grace_days: policy.graceDays,
            p_warning_days: policy.warningDays,
            p_enabled_pages: access.enabledPages,
            p_enabled_features: access.enabledFeatures,
            p_activation_code_hash: await hashActivationCode(activationCode),
            p_activation_expires_at: activationExpiresAt.toISOString(),
          }),
        }) as { shop: JsonRecord; activationId: string };
        return jsonResponse(201, {
          shop: created.shop,
          activationCode,
          activationId: created.activationId,
        }, headers);
      }

      if (route === '/api/licensing/activate' && request.method === 'POST') {
        const body = await readJson(request);
        if (
          !body || typeof body.activationCode !== 'string'
          || typeof body.hardwareId !== 'string' || !/^[a-f0-9]{64}$/i.test(body.hardwareId)
        ) return jsonResponse(400, { error: 'Activation code and a valid device fingerprint are required.' }, headers);
        const signingKey = config.licensePrivateKey;
        try {
          await signLicenseToken({
            shopId: 'validation',
            shopName: 'validation',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            hardwareId: body.hardwareId,
            status: 'ACTIVE',
            graceDays: 30,
            warningDays: 14,
            enabledPages: pageKeys,
            enabledFeatures: featureKeys,
          }, signingKey);
        } catch {
          return jsonResponse(503, { error: 'Central license signing is not configured.' }, headers);
        }
        const claimed = await supabaseRequest('rpc/central_consume_shop_activation', {
          method: 'POST',
          body: JSON.stringify({
            p_activation_hash: await hashActivationCode(body.activationCode),
            p_hardware_fingerprint: body.hardwareId,
          }),
        }) as Array<{ shop_id: string }>;
        const activation = claimed[0];
        if (!activation) return jsonResponse(404, { error: 'Activation code is invalid, expired, used, or unavailable.' }, headers);
        const shops = await databaseArray<JsonRecord>(
          `central_shops?id=eq.${encodeFilter(activation.shop_id)}&select=*`,
        );
        const shop = shops[0];
        const licenses = await databaseArray<JsonRecord>(
          `central_licenses?shop_id=eq.${encodeFilter(activation.shop_id)}&select=expires_at,license_type,status,grace_days,warning_days,enabled_pages,enabled_features`,
        );
        const license = licenses[0];
        if (
          !shop || !license || shop.status !== 'ACTIVE'
          || (license.expires_at && Date.parse(String(license.expires_at)) < Date.now())
        ) return jsonResponse(403, { error: 'This pharmacy license is not active.' }, headers);
        const access = normalizeAccess(license.enabled_pages, license.enabled_features);
        if (!access) return jsonResponse(503, { error: 'Stored license entitlements are invalid.' }, headers);
        const graceDays = boundedDays(license.grace_days, 30);
        const licenseToken = await signLicenseToken({
          shopId: activation.shop_id,
          shopName: String(shop.shop_name),
          expiresAt: typeof license.expires_at === 'string'
            ? license.expires_at
            : new Date(Date.now() + 365 * 86400000).toISOString(),
          hardwareId: body.hardwareId,
          status: license.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
          graceDays,
          warningDays: boundedWarningDays(license.warning_days, graceDays),
          ...access,
        }, signingKey);
        return jsonResponse(200, { success: true, licenseToken, shop }, headers);
      }

      if (route === '/api/licensing/shops' && request.method === 'GET') {
        const shops = await databaseArray<JsonRecord>(
          'central_shops?select=id,shop_code,shop_name,owner_email,owner_phone,status,created_at&order=created_at.desc',
        );
        const licenses = await databaseArray<JsonRecord>(
          'central_licenses?select=shop_id,expires_at,license_type,status,grace_days,warning_days,enabled_pages,enabled_features',
        );
        const checkins = await databaseArray<JsonRecord>(
          'central_latest_shop_checkins?select=shop_id,app_version,os_version,admin_setup_complete,checkin_time',
        );
        const licensesByShop = new Map(licenses.map((license) => [String(license.shop_id), license]));
        const checkinsByShop = new Map(checkins.map((row) => [String(row.shop_id), row]));
        return jsonResponse(200, shops.map((shop) => {
          const license = licensesByShop.get(String(shop.id));
          return {
            ...shop,
            licenses: license ? [license] : [],
            latestCheckin: checkinsByShop.get(String(shop.id)) || null,
          };
        }), headers);
      }

      if (route === '/api/licensing/announcements' && request.method === 'GET') {
        const announcements = await databaseArray<JsonRecord>(
          'central_shop_announcements?select=id,title,body,target_shop_ids,is_global,is_published,created_at,updated_at,published_at,created_by&order=created_at.desc',
        );
        return jsonResponse(200, announcements, headers);
      }

      if (route === '/api/licensing/announcements' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body) return jsonResponse(400, { error: 'Announcement details are required.' }, headers);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        const isGlobal = body.isGlobal === true;
        if (
          !title || title.length > 120 || !message || message.length > 2000
          || typeof body.isPublished !== 'boolean'
          || typeof body.isGlobal !== 'boolean'
          || (!isGlobal && (
            !Array.isArray(body.targetShopIds)
            || body.targetShopIds.length < 1
            || body.targetShopIds.length > 500
            || body.targetShopIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
          ))
        ) return jsonResponse(400, { error: 'Select valid announcement details and at least one target shop, or choose all shops.' }, headers);
        const targetShopIds = isGlobal ? [] : [...new Set(body.targetShopIds as string[])];
        if (!isGlobal) {
          const targets = await databaseArray<{ id: string }>(
            `central_shops?id=in.(${targetShopIds.map(encodeFilter).join(',')})&select=id`,
          );
          if (targets.length !== targetShopIds.length) {
            return jsonResponse(400, { error: 'One or more selected shops do not exist.' }, headers);
          }
        }
        const ownerId = await developerOwnerId(request.headers.get('authorization'));
        if (!ownerId) return jsonResponse(403, { error: 'Developer Owner access is required.' }, headers);
        const published = body.isPublished;
        const rows = await databaseArray<JsonRecord>('central_shop_announcements', {
          method: 'POST',
          body: JSON.stringify({
            title,
            body: message,
            target_shop_ids: targetShopIds,
            is_global: isGlobal,
            is_published: published,
            created_by: ownerId,
            published_at: published ? new Date().toISOString() : null,
          }),
        });
        return jsonResponse(201, rows[0] || {}, headers);
      }

      const announcementMatch = route.match(/^\/api\/licensing\/announcements\/([0-9a-f-]{36})$/i);
      if (announcementMatch && request.method === 'PATCH') {
        const body = await readJson(request);
        if (!body || typeof body.isPublished !== 'boolean') {
          return jsonResponse(400, { error: 'isPublished must be true or false.' }, headers);
        }
        const published = body.isPublished;
        const rows = await databaseArray<JsonRecord>(
          `central_shop_announcements?id=eq.${encodeFilter(announcementMatch[1])}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              is_published: published,
              published_at: published ? new Date().toISOString() : null,
              updated_at: new Date().toISOString(),
            }),
          },
        );
        if (!rows.length) return jsonResponse(404, { error: 'Announcement was not found.' }, headers);
        return jsonResponse(200, rows[0], headers);
      }

      if (announcementMatch && request.method === 'DELETE') {
        const rows = await databaseArray<JsonRecord>(
          `central_shop_announcements?id=eq.${encodeFilter(announcementMatch[1])}`,
          { method: 'DELETE' },
        );
        if (!rows.length) return jsonResponse(404, { error: 'Announcement was not found.' }, headers);
        return jsonResponse(200, { success: true }, headers);
      }

      const activationMatch = route.match(/^\/api\/licensing\/activations\/([0-9a-f-]{36})$/i);
      if (activationMatch && request.method === 'DELETE') {
        const rows = await databaseArray<{ id: string }>(
          `central_shop_activations?id=eq.${encodeFilter(activationMatch[1])}&is_used=eq.false`,
          { method: 'DELETE' },
        );
        if (!rows.length) return jsonResponse(404, { error: 'Unused activation key was not found.' }, headers);
        return jsonResponse(200, { success: true }, headers);
      }

      const reissueMatch = route.match(/^\/api\/licensing\/shops\/([0-9a-f-]{36})\/reissue$/i);
      if (reissueMatch && request.method === 'POST') {
        const body = await readJson(request) || {};
        const expiresAt = body.activationExpiresAt
          ? new Date(String(body.activationExpiresAt))
          : new Date(Date.now() + 7 * 86400000);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
          return jsonResponse(400, { error: 'Activation key expiry must be a valid future date.' }, headers);
        }
        const activationCode = createActivationCode();
        const rows = await databaseArray<{ id: string }>('rpc/central_reissue_shop_activation', {
          method: 'POST',
          body: JSON.stringify({
            p_shop_id: reissueMatch[1],
            p_activation_hash: await hashActivationCode(activationCode),
            p_expires_at: expiresAt.toISOString(),
          }),
        });
        if (!rows[0]?.id) return jsonResponse(409, { error: 'An active pharmacy license is required to reissue for a new PC.' }, headers);
        return jsonResponse(201, { activationCode, activationId: rows[0].id }, headers);
      }

      const shopMatch = route.match(/^\/api\/licensing\/shops\/([0-9a-f-]{36})$/i);
      if (shopMatch && request.method === 'PATCH') {
        const body = await readJson(request);
        if (!body) return jsonResponse(400, { error: 'A valid JSON request body is required.' }, headers);
        const shopId = shopMatch[1];
        const allowedStatuses = new Set(['ACTIVE', 'SUSPENDED', 'REVOKED']);
        if (body.status && (typeof body.status !== 'string' || !allowedStatuses.has(body.status))) {
          return jsonResponse(400, { error: 'Status must be ACTIVE, SUSPENDED, or REVOKED.' }, headers);
        }
        if (body.graceDays !== undefined || body.warningDays !== undefined) {
          const current = await databaseArray<JsonRecord>(
            `central_licenses?shop_id=eq.${encodeFilter(shopId)}&select=grace_days,warning_days`,
          );
          if (!current[0]) return jsonResponse(404, { error: 'Pharmacy license was not found.' }, headers);
          const policy = normalizePolicy(
            body.graceDays ?? current[0].grace_days ?? 30,
            body.warningDays ?? current[0].warning_days ?? 14,
          );
          if (!policy) return jsonResponse(400, { error: 'Offline grace must be 1-365 days and the warning period must be within grace.' }, headers);
          await supabaseRequest(`central_licenses?shop_id=eq.${encodeFilter(shopId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ grace_days: policy.graceDays, warning_days: policy.warningDays }),
          });
        }
        if (body.licenseExpiresAt !== undefined) {
          const expiresAt = body.licenseExpiresAt === null ? null : new Date(String(body.licenseExpiresAt));
          if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
            return jsonResponse(400, { error: 'Invalid license expiry date.' }, headers);
          }
          await supabaseRequest(`central_licenses?shop_id=eq.${encodeFilter(shopId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ expires_at: expiresAt?.toISOString() || null }),
          });
        }
        if (body.enabledPages !== undefined || body.enabledFeatures !== undefined) {
          const current = await databaseArray<JsonRecord>(
            `central_licenses?shop_id=eq.${encodeFilter(shopId)}&select=enabled_pages,enabled_features`,
          );
          if (!current[0]) return jsonResponse(404, { error: 'Pharmacy license was not found.' }, headers);
          const access = normalizeAccess(
            body.enabledPages === undefined ? current[0].enabled_pages : body.enabledPages,
            body.enabledFeatures === undefined ? current[0].enabled_features : body.enabledFeatures,
          );
          if (!access) return jsonResponse(400, { error: 'One or more page or feature entitlements are invalid.' }, headers);
          await supabaseRequest(`central_licenses?shop_id=eq.${encodeFilter(shopId)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              enabled_pages: access.enabledPages,
              enabled_features: access.enabledFeatures,
            }),
          });
        }
        if (typeof body.status === 'string') {
          await supabaseRequest(`central_shops?id=eq.${encodeFilter(shopId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }),
          });
          await supabaseRequest(`central_licenses?shop_id=eq.${encodeFilter(shopId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: body.status }),
          });
        }
        return jsonResponse(200, { success: true }, headers);
      }

      if (route === '/api/licensing/check-in' && request.method === 'POST') {
        const body = await readJson(request);
        if (
          !body || typeof body.shopId !== 'string' || typeof body.hardwareId !== 'string'
          || !/^[a-f0-9]{64}$/i.test(body.hardwareId)
        ) return jsonResponse(400, { error: 'Shop ID and a valid device fingerprint are required.' }, headers);
        if (
          (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.length > 80))
          || (body.osVersion !== undefined && (typeof body.osVersion !== 'string' || body.osVersion.length > 160))
          || (body.adminSetupComplete !== undefined && typeof body.adminSetupComplete !== 'boolean')
        ) return jsonResponse(400, { error: 'Check-in metadata is invalid.' }, headers);
        try {
          await signLicenseToken({
            shopId: 'validation',
            shopName: 'validation',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            hardwareId: body.hardwareId,
            status: 'ACTIVE',
            graceDays: 30,
            warningDays: 14,
            enabledPages: pageKeys,
            enabledFeatures: featureKeys,
          }, config.licensePrivateKey);
        } catch {
          return jsonResponse(503, { error: 'Central license signing is not configured.' }, headers);
        }
        const registered = await databaseArray<{ id: string }>(
          `central_shop_activations?shop_id=eq.${encodeFilter(body.shopId)}&is_used=eq.true&installation_fingerprint=eq.${encodeFilter(body.hardwareId)}&select=id`,
        );
        if (!registered.length) return jsonResponse(403, { error: 'This device is not registered for the pharmacy license.' }, headers);
        const shops = await databaseArray<JsonRecord>(
          `central_shops?id=eq.${encodeFilter(body.shopId)}&select=id,shop_name,status`,
        );
        const shop = shops[0];
        const licenses = await databaseArray<JsonRecord>(
          `central_licenses?shop_id=eq.${encodeFilter(body.shopId)}&select=expires_at,grace_days,warning_days,status,enabled_pages,enabled_features`,
        );
        const license = licenses[0];
        if (!shop || !license) return jsonResponse(404, { error: 'Pharmacy license was not found.' }, headers);
        const status = shop.status === 'ACTIVE' && license.status === 'ACTIVE' ? 'ACTIVE'
          : shop.status === 'REVOKED' || license.status === 'REVOKED' ? 'REVOKED'
            : 'SUSPENDED';
        const access = normalizeAccess(license.enabled_pages, license.enabled_features);
        if (!access) return jsonResponse(503, { error: 'Stored license entitlements are invalid.' }, headers);
        const graceDays = boundedDays(license.grace_days, 30);
        const licenseToken = await signLicenseToken({
          shopId: String(shop.id),
          shopName: String(shop.shop_name),
          expiresAt: typeof license.expires_at === 'string'
            ? license.expires_at
            : new Date(Date.now() + 365 * 86400000).toISOString(),
          hardwareId: body.hardwareId,
          status,
          graceDays,
          warningDays: boundedWarningDays(license.warning_days, graceDays),
          ...access,
        }, config.licensePrivateKey);
        await supabaseRequest('central_shop_checkins', {
          method: 'POST',
          body: JSON.stringify({
            shop_id: body.shopId,
            app_version: body.appVersion || 'unknown',
            os_version: body.osVersion || 'unknown',
            admin_setup_complete: body.adminSetupComplete === true,
          }),
        });
        const [globalAnnouncements, targetedAnnouncements] = await Promise.all([
          databaseArray<JsonRecord>(
            'central_shop_announcements?is_published=eq.true&is_global=eq.true&select=id,title,body,published_at&order=published_at.desc&limit=200',
          ),
          databaseArray<JsonRecord>(
            `central_shop_announcements?is_published=eq.true&is_global=eq.false&target_shop_ids=cs.{${encodeFilter(body.shopId)}}&select=id,title,body,published_at&order=published_at.desc&limit=200`,
          ),
        ]);
        return jsonResponse(200, {
          success: true,
          licenseToken,
          announcements: [...globalAnnouncements, ...targetedAnnouncements].slice(0, 200),
        }, headers);
      }

      return jsonResponse(404, { error: 'Not found.' }, headers);
    } catch (error) {
      console.error('Central licensing request failed.', error instanceof SupabaseRequestError ? error.status : 'internal');
      if (error instanceof SupabaseRequestError && error.status === 404) {
        return jsonResponse(404, { error: 'The requested licensing record was not found.' }, headers);
      }
      return jsonResponse(500, { error: 'Central licensing request failed.' }, headers);
    }
  };
}
