import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import {
  ALL_LICENSE_FEATURES,
  ALL_LICENSE_PAGES,
  MODULES,
  POS_PRINT_PERMISSION_KEYS,
  SETTINGS_SECTION_PERMISSIONS,
  normalizeLicenseAccess,
  type LicenseFeatureKey,
  type LicensePageKey,
} from '../../central-backend/src/entitlementModel';

const centralUrl = import.meta.env.VITE_CENTRAL_API_URL;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && anonKey ? createClient(supabaseUrl, anonKey) : null;

interface License {
  expires_at: string | null;
  license_type: string;
  status: string;
  enabled_pages: LicensePageKey[];
  enabled_features: LicenseFeatureKey[];
}

interface Shop {
  id: string;
  shop_code: string;
  shop_name: string;
  owner_email: string | null;
  owner_phone: string | null;
  status: string;
  created_at: string;
  licenses: License[];
}

function App() {
  const [sessionEmail, setSessionEmail] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [shops, setShops] = useState<Shop[]>([]);
  const [shopName, setShopName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [licenseType, setLicenseType] = useState('STANDARD');
  const [licenseExpiry, setLicenseExpiry] = useState('');
  const [activationExpiry, setActivationExpiry] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [activationId, setActivationId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setError(sessionError.message);
      setSessionEmail(data.session?.user.email || '');
      setAccessToken(data.session?.access_token || '');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user.email || '');
      setAccessToken(session?.access_token || '');
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setShops([]);
      return;
    }
    void refreshShops();
  }, [accessToken]);

  async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!centralUrl) throw new Error('VITE_CENTRAL_API_URL is not configured.');
    if (!accessToken) throw new Error('Sign in before managing licenses.');
    const response = await fetch(`${centralUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body && typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`);
    }
    return body as T;
  }

  async function refreshShops() {
    try {
      setShops(await apiRequest<Shop[]>('/api/licensing/shops'));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load pharmacies.');
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) {
      setError('Dashboard Supabase configuration is missing.');
      return;
    }
    setBusy(true);
    setError('');
    const result = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) setError(result.error.message);
    else {
      setSessionEmail(result.data.user?.email || '');
      setAccessToken(result.data.session?.access_token || '');
      setPassword('');
    }
  }

  async function submitShop(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setActivationCode('');
    try {
      const result = await apiRequest<{ activationCode: string; activationId: string }>('/api/licensing/shops', {
        method: 'POST',
        body: JSON.stringify({
          shopName,
          ownerEmail: ownerEmail || undefined,
          ownerPhone: ownerPhone || undefined,
          licenseType,
          licenseExpiresAt: licenseExpiry ? new Date(`${licenseExpiry}T23:59:59.999Z`).toISOString() : null,
          activationExpiresAt: activationExpiry ? new Date(`${activationExpiry}T23:59:59.999Z`).toISOString() : undefined,
        }),
      });
      setActivationCode(result.activationCode);
      setActivationId(result.activationId);
      setShopName('');
      setOwnerEmail('');
      setOwnerPhone('');
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create pharmacy.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeActivationKey() {
    if (!activationId) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/licensing/activations/${encodeURIComponent(activationId)}`, { method: 'DELETE' });
      setActivationCode('');
      setActivationId('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke activation key.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLicense(
    shop: Shop,
    status: string,
    expiry: string,
    enabledPages: LicensePageKey[],
    enabledFeatures: LicenseFeatureKey[],
  ) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/licensing/shops/${encodeURIComponent(shop.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          licenseExpiresAt: expiry ? new Date(`${expiry}T23:59:59.999Z`).toISOString() : null,
          enabledPages,
          enabledFeatures,
        }),
      });
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update license.');
    } finally {
      setBusy(false);
    }
  }

  if (!sessionEmail) {
    return (
      <main style={{ maxWidth: 420, margin: '15vh auto', fontFamily: 'system-ui' }}>
        <h1>Developer Owner</h1>
        <form onSubmit={(event) => void signIn(event)}>
          <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Owner email" style={{ width: '100%', padding: 10, marginBottom: 8 }} />
          <input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" style={{ width: '100%', padding: 10, marginBottom: 8 }} />
          <button disabled={busy} style={{ width: '100%', padding: 10 }}>Sign in</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 900, margin: '5vh auto', padding: 20, fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Pharma Care Licensing</h1>
          <p>Signed in as {sessionEmail}</p>
        </div>
        <button onClick={() => void supabase?.auth.signOut()}>Sign out</button>
      </header>
      <h2>Register pharmacy</h2>
      <form onSubmit={(event) => void submitShop(event)} style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
        <input required value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Pharmacy name" style={{ padding: 10 }} />
        <input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="Owner email (optional)" style={{ padding: 10 }} />
        <input value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} placeholder="Owner phone (optional)" style={{ padding: 10 }} />
        <label>License type <select value={licenseType} onChange={(event) => setLicenseType(event.target.value)}><option value="STANDARD">Standard</option><option value="TRIAL">Trial</option></select></label>
        <label>License expiry (optional) <input type="date" value={licenseExpiry} onChange={(event) => setLicenseExpiry(event.target.value)} /></label>
        <label>Activation key expiry (optional; default 7 days) <input type="date" value={activationExpiry} onChange={(event) => setActivationExpiry(event.target.value)} /></label>
        <button disabled={busy} style={{ padding: 10 }}>Generate single-use activation key</button>
      </form>
      {activationCode && (
        <section role="status" style={{ padding: 16, marginBottom: 24, background: '#eef6ff' }}>
          <strong>Copy this activation key now. It will not be shown again.</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <code style={{ overflowWrap: 'anywhere' }}>{activationCode}</code>
            <button onClick={() => void navigator.clipboard.writeText(activationCode)}>Copy</button>
            <button disabled={busy || !activationId} onClick={() => void revokeActivationKey()}>Revoke unused key</button>
          </div>
        </section>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Pharmacies and licenses</h2>
        <button onClick={() => void refreshShops()} disabled={busy}>Refresh</button>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {shops.map((shop) => {
          const license = shop.licenses?.[0];
          return (
            <LicenseCard key={shop.id} shop={shop} license={license} busy={busy} onSave={saveLicense} />
          );
        })}
      </div>
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
    </main>
  );
}

function LicenseCard({
  shop,
  license,
  busy,
  onSave,
}: {
  shop: Shop;
  license?: License;
  busy: boolean;
  onSave: (
    shop: Shop,
    status: string,
    expiry: string,
    enabledPages: LicensePageKey[],
    enabledFeatures: LicenseFeatureKey[],
  ) => Promise<void>;
}) {
  const [status, setStatus] = useState(shop.status);
  const [expiry, setExpiry] = useState(license?.expires_at?.slice(0, 10) || '');
  const initialAccess = normalizeLicenseAccess(license?.enabled_pages, license?.enabled_features);
  const [enabledPages, setEnabledPages] = useState<LicensePageKey[]>(
    initialAccess?.enabledPages || ALL_LICENSE_PAGES,
  );
  const [enabledFeatures, setEnabledFeatures] = useState<LicenseFeatureKey[]>(
    initialAccess?.enabledFeatures || ALL_LICENSE_FEATURES,
  );
  const toggleEntitlement = <T extends string,>(
    selected: T[],
    key: T,
    update: (next: T[]) => void,
  ) => {
    update(selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
  };
  return (
    <section style={{ border: '1px solid #d0d5dd', borderRadius: 8, padding: 16 }}>
      <h3>{shop.shop_name} ({shop.shop_code})</h3>
      <p>{shop.owner_email || 'No owner email'} · License: {license?.license_type || 'Unknown'}</p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="REVOKED">Revoked</option>
        </select></label>
        <label>Expires <input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
      </div>
      <fieldset style={{ marginTop: 12 }}>
        <legend>Included pages</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6 }}>
          {MODULES.map(({ key, label }) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={enabledPages.includes(key)}
                onChange={() => toggleEntitlement(enabledPages, key, setEnabledPages)}
              /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset style={{ marginTop: 12 }}>
        <legend>Included features</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6 }}>
          {POS_PRINT_PERMISSION_KEYS.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={enabledFeatures.includes(key)}
                onChange={() => toggleEntitlement(enabledFeatures, key, setEnabledFeatures)}
              /> {key === 'pos_print_sale' ? 'Print sale receipts' : 'Print payment receipts'}
            </label>
          ))}
          {SETTINGS_SECTION_PERMISSIONS.map(({ key, label }) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={enabledFeatures.includes(key)}
                onChange={() => toggleEntitlement(enabledFeatures, key, setEnabledFeatures)}
              /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <button style={{ marginTop: 12 }} disabled={busy} onClick={() => void onSave(
        shop,
        status,
        expiry,
        enabledPages,
        enabledFeatures,
      )}>Save license</button>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
