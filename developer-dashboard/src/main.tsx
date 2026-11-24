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
import './styles.css';

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
  grace_days: number;
  warning_days: number;
}

interface ShopCheckin {
  app_version: string;
  os_version: string;
  admin_setup_complete: boolean;
  checkin_time: string;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  target_shop_ids: string[];
  is_global: boolean;
  is_published: boolean;
  created_at: string;
  published_at: string | null;
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
  latestCheckin: ShopCheckin | null;
}

const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
const demoShopId = 'demo-shop-sunrise';
const demoShops: Shop[] = [
  {
    id: demoShopId,
    shop_code: 'DEMO-1042',
    shop_name: 'Sunrise Demo Pharmacy',
    owner_email: 'owner@sunrise-demo.example',
    owner_phone: null,
    status: 'ACTIVE',
    created_at: '2026-10-10T09:00:00.000Z',
    licenses: [{
      expires_at: '2027-11-23T23:59:59.999Z',
      license_type: 'STANDARD',
      status: 'ACTIVE',
      enabled_pages: [...ALL_LICENSE_PAGES],
      enabled_features: [...ALL_LICENSE_FEATURES],
      grace_days: 30,
      warning_days: 14,
    }],
    latestCheckin: {
      app_version: '1.0.0',
      os_version: 'Windows 11',
      admin_setup_complete: true,
      checkin_time: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    },
  },
  {
    id: 'demo-shop-green-valley',
    shop_code: 'DEMO-2086',
    shop_name: 'Green Valley Demo Pharmacy',
    owner_email: 'owner@greenvalley-demo.example',
    owner_phone: null,
    status: 'ACTIVE',
    created_at: '2026-09-04T12:00:00.000Z',
    licenses: [{
      expires_at: '2027-06-30T23:59:59.999Z',
      license_type: 'TRIAL',
      status: 'ACTIVE',
      enabled_pages: [...ALL_LICENSE_PAGES],
      enabled_features: [...ALL_LICENSE_FEATURES],
      grace_days: 14,
      warning_days: 7,
    }],
    latestCheckin: {
      app_version: '0.9.8',
      os_version: 'Windows 10',
      admin_setup_complete: false,
      checkin_time: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
];
const demoAnnouncements: Announcement[] = [
  {
    id: 'demo-announcement-published',
    title: 'Welcome to the demo',
    body: 'This sample notice is visible to the Shop Admin after the next successful check-in.',
    target_shop_ids: [demoShopId],
    is_global: false,
    is_published: true,
    created_at: '2026-11-22T09:00:00.000Z',
    published_at: '2026-11-22T09:15:00.000Z',
  },
  {
    id: 'demo-announcement-draft',
    title: 'Private draft example',
    body: 'Drafts are private to authorized Developer Owners.',
    target_shop_ids: [],
    is_global: false,
    is_published: false,
    created_at: '2026-11-22T10:00:00.000Z',
    published_at: null,
  },
];

function App() {
  const [sessionEmail, setSessionEmail] = useState(demoMode ? 'demo.owner@example.test' : '');
  const [accessToken, setAccessToken] = useState('');
  const [shops, setShops] = useState<Shop[]>(demoMode ? demoShops : []);
  const [announcements, setAnnouncements] = useState<Announcement[]>(demoMode ? demoAnnouncements : []);
  const [shopName, setShopName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [licenseType, setLicenseType] = useState('STANDARD');
  const [licenseExpiry, setLicenseExpiry] = useState('');
  const [activationExpiry, setActivationExpiry] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [activationId, setActivationId] = useState('');
  const [activationMessage, setActivationMessage] = useState('');
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementBody, setAnnouncementBody] = useState('');
  const [announcementIsGlobal, setAnnouncementIsGlobal] = useState(false);
  const [announcementTargets, setAnnouncementTargets] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(demoMode);

  useEffect(() => {
    if (!supabase || demoMode) return;
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
    if (demoMode) return;
    if (!accessToken) {
      setShops([]);
      return;
    }
    void refreshShops();
  }, [accessToken]);

  async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (demoMode) throw new Error('The dashboard demo is read-only.');
    if (!centralUrl) throw new Error('VITE_CENTRAL_API_URL is not configured.');
    if (!accessToken) throw new Error('Sign in before managing licenses.');
    const response = await fetch(`${centralUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
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
      const [nextShops, nextAnnouncements] = await Promise.all([
        apiRequest<Shop[]>('/api/licensing/shops'),
        apiRequest<Announcement[]>('/api/licensing/announcements'),
      ]);
      setShops(nextShops);
      setAnnouncements(nextAnnouncements);
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
      setActivationMessage('New pharmacy activation key. Copy it now; it will not be shown again.');
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
      setActivationMessage('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke activation key.');
    } finally {
      setBusy(false);
    }
  }

  async function reissueLicense(shop: Shop) {
    setBusy(true);
    setError('');
    setActivationCode('');
    setActivationId('');
    try {
      const result = await apiRequest<{ activationCode: string; activationId: string }>(
        `/api/licensing/shops/${encodeURIComponent(shop.id)}/reissue`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setActivationCode(result.activationCode);
      setActivationId(result.activationId);
      setActivationMessage(
        `Replacement activation key for ${shop.shop_name}. Existing device registrations and unused keys were revoked.`,
      );
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reissue the license.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLicense(
    shop: Shop,
    status: string,
    expiry: string,
    graceDays: number,
    warningDays: number,
    enabledPages: LicensePageKey[],
    enabledFeatures: LicenseFeatureKey[],
  ) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/licensing/shops/${encodeURIComponent(shop.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(status === 'PENDING_ACTIVATION' ? {} : { status }),
          licenseExpiresAt: expiry ? new Date(`${expiry}T23:59:59.999Z`).toISOString() : null,
          graceDays,
          warningDays,
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

  async function saveAnnouncement(isPublished: boolean) {
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/licensing/announcements', {
        method: 'POST',
        body: JSON.stringify({
          title: announcementTitle,
          message: announcementBody,
          isGlobal: announcementIsGlobal,
          targetShopIds: announcementTargets,
          isPublished,
        }),
      });
      setAnnouncementTitle('');
      setAnnouncementBody('');
      setAnnouncementTargets([]);
      setAnnouncementIsGlobal(false);
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save announcement.');
    } finally {
      setBusy(false);
    }
  }

  async function setAnnouncementPublished(announcement: Announcement, isPublished: boolean) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/licensing/announcements/${encodeURIComponent(announcement.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPublished }),
      });
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update announcement.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAnnouncement(announcement: Announcement) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/licensing/announcements/${encodeURIComponent(announcement.id)}`, {
        method: 'DELETE',
      });
      await refreshShops();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete announcement.');
    }
    finally {
      setBusy(false);
    }
  }

  if (!sessionEmail) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-mark">PC</div>
          <p className="eyebrow">PHARMA CARE · OWNER CONSOLE</p>
          <h1>Developer Owner</h1>
          <p className="muted-copy">Sign in to manage pharmacy licenses and updates.</p>
          <form className="login-form" onSubmit={(event) => void signIn(event)}>
            <label>Email address
              <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Owner email" />
            </label>
            <label>Password
              <input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" />
            </label>
            <button className="button button-primary button-wide" disabled={busy}>Sign in</button>
          </form>
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-layout">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">PHARMA CARE · DEVELOPER PORTAL</p>
          <h1>Licensing dashboard</h1>
          <p className="header-subtitle">Signed in as <strong>{sessionEmail}</strong></p>
        </div>
        <button className="button button-quiet" disabled={demoMode} onClick={() => void supabase?.auth.signOut()}>Sign out</button>
      </header>
      {demoMode && (
        <aside className="demo-banner" role="status">
          <span className="demo-banner-icon">i</span>
          <div><strong>Read-only demo</strong><span>Sample shops and notices only. Nothing is connected or saved.</span></div>
          <span className="demo-tag">PREVIEW</span>
        </aside>
      )}
      <section className="summary-section">
        <div className="section-title-row">
          <div><p className="eyebrow">WORKSPACE OVERVIEW</p><h2>Shop portfolio</h2><p className="muted-copy">Monitor license health, check-ins, and setup progress.</p></div>
          <button className="button button-secondary" disabled={busy} onClick={() => void refreshShops()}><span aria-hidden="true">↻</span> Refresh data</button>
        </div>
        <div className="summary-grid">
          <article className="summary-card"><span className="summary-icon icon-blue">▦</span><span>Registered shops</span><strong>{shops.length}</strong><small>Across your workspace</small></article>
          <article className="summary-card"><span className="summary-icon icon-green">✓</span><span>Active licenses</span><strong>{shops.filter((shop) => shop.status === 'ACTIVE' && shop.licenses[0]?.status === 'ACTIVE').length}</strong><small>Currently valid</small></article>
          <article className="summary-card"><span className="summary-icon icon-violet">◷</span><span>Checked in recently</span><strong>{shops.filter((shop) => shop.latestCheckin && Date.now() - Date.parse(shop.latestCheckin.checkin_time) <= 24 * 60 * 60 * 1000).length}</strong><small>Within the last 24 hours</small></article>
          <article className="summary-card"><span className="summary-icon icon-amber">!</span><span>Setup needs attention</span><strong>{shops.filter((shop) => !shop.latestCheckin?.admin_setup_complete).length}</strong><small>Shop Admin setup pending</small></article>
        </div>
      </section>
      {activationCode && (
        <section className="activation-result" role="status">
          <strong>Copy this activation key now. It will not be shown again.</strong>
          {activationMessage && <p>{activationMessage}</p>}
          <div className="button-row">
            <code>{activationCode}</code>
            <button className="button button-secondary" onClick={() => void navigator.clipboard.writeText(activationCode)}>Copy</button>
            <button className="button button-quiet" disabled={busy || !activationId} onClick={() => void revokeActivationKey()}>Revoke unused key</button>
          </div>
        </section>
      )}
      <section className="shop-section" id="shops">
        <div className="section-title-row">
          <div><p className="eyebrow">LICENSE MANAGEMENT</p><h2>Pharmacies and licenses</h2></div>
          <span className="count-chip">{shops.length} shops</span>
        </div>
        <div className="shop-list">
          {shops.map((shop) => (
            <LicenseCard
              key={shop.id}
              shop={shop}
              license={shop.licenses?.[0]}
              busy={busy}
              onSave={saveLicense}
              onReissue={reissueLicense}
            />
          ))}
          {shops.length === 0 && <p className="empty-state">No pharmacies registered yet.</p>}
        </div>
      </section>
      <section className="workspace-grid">
        <section className="panel" id="register">
          <div className="panel-heading">
            <span className="panel-icon icon-blue">＋</span>
            <div><h2>Register pharmacy</h2><p>Create a shop and issue a single-use activation key.</p></div>
          </div>
          <form className="form-grid" onSubmit={(event) => void submitShop(event)}>
            <label className="field field-full">Pharmacy name
              <input required value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="e.g. Sunrise Pharmacy" />
            </label>
            <label className="field">Owner email <span className="optional">(optional)</span>
              <input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" />
            </label>
            <label className="field">Owner phone <span className="optional">(optional)</span>
              <input value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} placeholder="Phone number" />
            </label>
            <label className="field">License type
              <select value={licenseType} onChange={(event) => setLicenseType(event.target.value)}>
                <option value="STANDARD">Standard</option><option value="TRIAL">Trial</option>
              </select>
            </label>
            <label className="field">License expiry <span className="optional">(optional)</span>
              <input type="date" value={licenseExpiry} onChange={(event) => setLicenseExpiry(event.target.value)} />
            </label>
            <label className="field field-full">Activation key expiry <span className="optional">(default 7 days)</span>
              <input type="date" value={activationExpiry} onChange={(event) => setActivationExpiry(event.target.value)} />
            </label>
            <button className="button button-primary field-full" disabled={busy}>Generate activation key <span aria-hidden="true">→</span></button>
          </form>
        </section>

        <section className="panel" id="announcements">
          <div className="panel-heading">
            <span className="panel-icon icon-violet">✉</span>
            <div><h2>Admin announcements</h2><p>Draft privately or publish to selected shops.</p></div>
          </div>
          <p className="panel-note">Published messages arrive after a shop's next successful online check-in.</p>
          <form className="announcement-form" onSubmit={(event) => {
            event.preventDefault();
            void saveAnnouncement(false);
          }}>
            <label className="field">Message title
              <input required maxLength={120} value={announcementTitle} onChange={(event) => setAnnouncementTitle(event.target.value)} placeholder="Short update title" />
            </label>
            <label className="field">Message
              <textarea required maxLength={2000} value={announcementBody} onChange={(event) => setAnnouncementBody(event.target.value)} placeholder="Write an update for the Shop Admin..." rows={3} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={announcementIsGlobal} onChange={(event) => setAnnouncementIsGlobal(event.target.checked)} />
              Send to all current shops
            </label>
            {!announcementIsGlobal && (
              <fieldset className="target-list">
                <legend>Target shops</legend>
                {shops.length === 0 ? <p>Create a shop before targeting an announcement.</p> : shops.map((shop) => (
                  <label key={shop.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={announcementTargets.includes(shop.id)}
                      onChange={() => setAnnouncementTargets((current) => (
                        current.includes(shop.id) ? current.filter((id) => id !== shop.id) : [...current, shop.id]
                      ))}
                    /> {shop.shop_name}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="button-row">
              <button className="button button-secondary" type="submit" disabled={busy}>Save private draft</button>
              <button className="button button-primary" type="button" disabled={busy} onClick={() => void saveAnnouncement(true)}>Publish message</button>
            </div>
          </form>
          <div className="announcement-list">
            <h3>Recent messages</h3>
            {announcements.map((announcement) => (
              <article className="announcement-item" key={announcement.id}>
                <div className="announcement-item-heading">
                  <strong>{announcement.title}</strong>
                  <span className={`status-pill ${announcement.is_published ? 'status-published' : 'status-draft'}`}>
                    {announcement.is_published ? 'Published' : 'Private draft'}
                  </span>
                </div>
                <p>{announcement.body}</p>
                <small>{announcement.is_global ? 'All shops' : `${announcement.target_shop_ids.length} selected shop(s)`}</small>
                <div className="button-row">
                  <button className="button button-quiet" type="button" disabled={busy} onClick={() => void setAnnouncementPublished(announcement, !announcement.is_published)}>
                    {announcement.is_published ? 'Unpublish' : 'Publish'}
                  </button>
                  <button className="button button-danger-quiet" type="button" disabled={busy} onClick={() => void deleteAnnouncement(announcement)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
      {error && <p className="error-message" role="alert">{error}</p>}
      <footer className="page-footer">PharmaCare Developer Portal <span>·</span> License and shop administration</footer>
    </main>
  );
}

function LicenseCard({
  shop,
  license,
  busy,
  onSave,
  onReissue,
}: {
  shop: Shop;
  license?: License;
  busy: boolean;
  onSave: (
    shop: Shop,
    status: string,
    expiry: string,
    graceDays: number,
    warningDays: number,
    enabledPages: LicensePageKey[],
    enabledFeatures: LicenseFeatureKey[],
  ) => Promise<void>;
  onReissue: (shop: Shop) => Promise<void>;
}) {
  const [status, setStatus] = useState(shop.status);
  const [expiry, setExpiry] = useState(license?.expires_at?.slice(0, 10) || '');
  const [graceDays, setGraceDays] = useState(license?.grace_days || 30);
  const [warningDays, setWarningDays] = useState(license?.warning_days || 14);
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
  const checkinTime = shop.latestCheckin
    ? new Date(shop.latestCheckin.checkin_time).toLocaleString()
    : 'Never';
  const checkedInRecently = shop.latestCheckin
    ? Date.now() - Date.parse(shop.latestCheckin.checkin_time) <= 24 * 60 * 60 * 1000
    : false;
  return (
    <article className="shop-card">
      <div className="shop-card-heading">
        <div>
          <div className="shop-title-row">
            <h3>{shop.shop_name}</h3>
            <span className={`status-pill status-${status.toLowerCase()}`}>{status.replaceAll('_', ' ')}</span>
          </div>
          <p>{shop.owner_email || 'No owner email'} <span className="meta-divider">·</span> {shop.shop_code}</p>
        </div>
        <span className="license-type">{license?.license_type || 'Unknown'} license</span>
      </div>
      <div className="shop-signals">
        <div className="signal-card">
          <span>Last check-in</span>
          <strong>{checkinTime}</strong>
          <small>{shop.latestCheckin ? `App ${shop.latestCheckin.app_version} · ${shop.latestCheckin.os_version}` : 'No device has checked in yet'}</small>
        </div>
        <div className="signal-card">
          <span>Shop Admin setup</span>
          <strong className={shop.latestCheckin?.admin_setup_complete ? 'signal-good' : 'signal-warn'}>
            {shop.latestCheckin ? shop.latestCheckin.admin_setup_complete ? 'Complete' : 'Pending' : 'Not reported'}
          </strong>
          <small>Initial account configuration</small>
        </div>
        <div className="signal-card">
          <span>Connection report</span>
          <strong className={checkedInRecently ? 'signal-good' : 'signal-warn'}>
            {shop.latestCheckin ? checkedInRecently ? 'Recent check-in' : 'No recent check-in' : 'Never connected'}
          </strong>
          <small>{shop.latestCheckin ? 'Last 24 hours' : 'Waiting for first activation'}</small>
        </div>
      </div>
      <details className="license-details">
        <summary>License settings and page access</summary>
        <div className="license-detail-body">
          <div className="license-fields">
            <label className="field">Status
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {status === 'PENDING_ACTIVATION' && <option value="PENDING_ACTIVATION">Pending activation</option>}
                <option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="REVOKED">Revoked</option>
              </select>
            </label>
            <label className="field">License expiry
              <input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            </label>
            <label className="field">Offline grace (days)
              <input
                type="number"
                min={1}
                max={365}
                value={graceDays}
                onChange={(event) => {
                  const nextGraceDays = Number(event.target.value);
                  setGraceDays(nextGraceDays);
                  setWarningDays((current) => Math.min(current, nextGraceDays));
                }}
              />
            </label>
            <label className="field">Warning before lockout (days)
              <input type="number" min={1} max={graceDays} value={warningDays} onChange={(event) => setWarningDays(Number(event.target.value))} />
            </label>
          </div>
          <fieldset className="access-fieldset">
            <legend>Included pages</legend>
            <div className="access-grid">
              {MODULES.map(({ key, label }) => (
                <label key={key} className="check-row">
                  <input type="checkbox" checked={enabledPages.includes(key)} onChange={() => toggleEntitlement(enabledPages, key, setEnabledPages)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="access-fieldset">
            <legend>Included features</legend>
            <div className="access-grid">
              {POS_PRINT_PERMISSION_KEYS.map((key) => (
                <label key={key} className="check-row">
                  <input type="checkbox" checked={enabledFeatures.includes(key)} onChange={() => toggleEntitlement(enabledFeatures, key, setEnabledFeatures)} />
                  {key === 'pos_print_sale' ? 'Print sale receipts' : 'Print payment receipts'}
                </label>
              ))}
              {SETTINGS_SECTION_PERMISSIONS.map(({ key, label }) => (
                <label key={key} className="check-row">
                  <input type="checkbox" checked={enabledFeatures.includes(key)} onChange={() => toggleEntitlement(enabledFeatures, key, setEnabledFeatures)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="license-actions">
            <button className="button button-primary" disabled={busy} onClick={() => void onSave(
              shop, status, expiry, graceDays, warningDays, enabledPages, enabledFeatures,
            )}>Save license settings</button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || status !== 'ACTIVE' || license?.status !== 'ACTIVE'}
              onClick={() => {
                const confirmed = window.confirm(
                  `Reissue this license for a new PC? Existing device registrations and unused activation keys for ${shop.shop_name} will be revoked.`,
                );
                if (confirmed) void onReissue(shop);
              }}
            >Reissue key for a new PC</button>
            <p>A replacement key revokes existing device registrations and unused keys.</p>
          </div>
        </div>
      </details>
    </article>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
