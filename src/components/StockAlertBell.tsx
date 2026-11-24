import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Bell, RefreshCw } from 'lucide-react';
import { usePermissions } from '../permissions';
import { loadStockAlertsSummary } from '../data/stockAlerts';
import { isDesktopMode, localApiRequest } from '../services/localApi';
import {
  formatStockAlertBadgeCount,
  getStockAlertLinkTarget,
  getUnseenStockAlertKeys,
  stockAlertKey,
  type StockAlertItem,
  type StockAlertsSummary,
  type StockAlertLinkTarget,
} from '../data/stockAlertLogic';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { STOCK_CHANGED_EVENT } from '../utils/stockAlertsEvents';

const seenAlertsStorageKey = (userId: string) => `pharma-care.stock-alerts.seen.${userId}`;

interface DeveloperAnnouncement {
  id: string;
  title: string;
  body: string;
  published_at: string;
  read_at: number | null;
}

function readSeenKeys(userId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(seenAlertsStorageKey(userId)) ?? '[]');
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((key): key is string => typeof key === 'string'));
  } catch {
    return new Set();
  }
}

function persistSeenKeys(userId: string, keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(seenAlertsStorageKey(userId), JSON.stringify([...keys]));
  } catch {
    // The alert panel remains usable when browser storage is unavailable.
  }
}

interface StockAlertBellProps {
  userId: string;
  animationsEnabled: boolean;
  onOpenStockInventory: (medicineId: string | null) => void;
  onOpenProducts: (searchText: string | null) => void;
}

export function StockAlertBell({
  userId,
  animationsEnabled,
  onOpenStockInventory,
  onOpenProducts,
}: StockAlertBellProps) {
  const { can } = usePermissions();
  const [summary, setSummary] = useState<StockAlertsSummary | null>(null);
  const [announcements, setAnnouncements] = useState<DeveloperAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [announcementError, setAnnouncementError] = useState('');
  const [open, setOpen] = useState(false);
  const [seenKeys, setSeenKeys] = useState<Set<string>>(() => readSeenKeys(userId));
  const [panelTop, setPanelTop] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const canOpenStockInventory = can('stock_inventory');
  const canOpenProducts = can('products');
  const linkTarget = getStockAlertLinkTarget(canOpenStockInventory, canOpenProducts);
  const items = summary?.items ?? [];
  const totalCount = (summary?.low_count ?? 0) + (summary?.out_count ?? 0);
  const unreadAnnouncements = announcements.filter((announcement) => announcement.read_at === null);
  const combinedCount = totalCount + unreadAnnouncements.length;
  const badgeCount = error ? null : formatStockAlertBadgeCount(combinedCount);
  const unseenKeys = useMemo(() => getUnseenStockAlertKeys(items, seenKeys), [items, seenKeys]);
  const lowItems = items.filter((item) => item.kind === 'low');
  const outItems = items.filter((item) => item.kind === 'out');

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await loadStockAlertsSummary();
      if (sequence !== requestSequence.current) return;
      setSummary(result);
      setError('');
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      setError(getSupabaseErrorMessage(caught, 'Could not load stock alerts.'));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  const refreshAnnouncements = useCallback(async () => {
    if (!isDesktopMode()) {
      setAnnouncements([]);
      setAnnouncementError('');
      return;
    }
    try {
      const result = await localApiRequest<unknown>('/api/notifications/developer-announcements');
      if (
        !Array.isArray(result)
        || result.some((item) => (
          !item || typeof item !== 'object'
          || typeof (item as DeveloperAnnouncement).id !== 'string'
          || typeof (item as DeveloperAnnouncement).title !== 'string'
          || typeof (item as DeveloperAnnouncement).body !== 'string'
          || typeof (item as DeveloperAnnouncement).published_at !== 'string'
          || !((item as DeveloperAnnouncement).read_at === null || typeof (item as DeveloperAnnouncement).read_at === 'number')
        ))
      ) throw new Error('The local announcements service returned invalid data.');
      setAnnouncements(result as DeveloperAnnouncement[]);
      setAnnouncementError('');
    } catch (caught) {
      setAnnouncementError(caught instanceof Error ? caught.message : 'Could not load developer announcements.');
    }
  }, []);

  useEffect(() => {
    setSeenKeys(readSeenKeys(userId));
  }, [userId]);

  useEffect(() => {
    let intervalId: number | undefined;
    const stopPolling = () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    };
    const startPolling = () => {
      stopPolling();
      if (document.visibilityState === 'visible') {
        intervalId = window.setInterval(() => {
          void refresh();
          void refreshAnnouncements();
        }, 60_000);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        void refreshAnnouncements();
        startPolling();
      } else {
        stopPolling();
      }
    };
    const onStockChanged = () => void refresh();

    void refresh();
    void refreshAnnouncements();
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener(STOCK_CHANGED_EVENT, onStockChanged);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener(STOCK_CHANGED_EVENT, onStockChanged);
      requestSequence.current += 1;
    };
  }, [refresh, refreshAnnouncements, userId]);

  useEffect(() => {
    if (!open) return;
    const onOutsidePointer = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node)
        && !buttonRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onResize = () => {
      setPanelTop(buttonRef.current?.getBoundingClientRect().bottom ?? 0);
    };
    document.addEventListener('pointerdown', onOutsidePointer);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const markCurrentAlertsSeen = (currentItems: readonly StockAlertItem[]) => {
    const next = new Set(currentItems.map(stockAlertKey));
    setSeenKeys(next);
    persistSeenKeys(userId, next);
  };

  const markAnnouncementsRead = async () => {
    const unread = announcements.filter((announcement) => announcement.read_at === null);
    if (!unread.length) return;
    try {
      await Promise.all(unread.map((announcement) => localApiRequest(
        `/api/notifications/developer-announcements/${encodeURIComponent(announcement.id)}/read`,
        'POST',
      )));
      const readAt = Math.floor(Date.now() / 1000);
      setAnnouncements((current) => current.map((announcement) => (
        announcement.read_at === null ? { ...announcement, read_at: readAt } : announcement
      )));
      setAnnouncementError('');
    } catch (caught) {
      setAnnouncementError(caught instanceof Error ? caught.message : 'Could not mark announcements as read.');
    }
  };

  const openPanel = () => {
    if (!open) {
      markCurrentAlertsSeen(items);
      setPanelTop(buttonRef.current?.getBoundingClientRect().bottom ?? 0);
      void refresh();
      void refreshAnnouncements().then(() => markAnnouncementsRead());
    }
    setOpen((current) => !current);
  };

  const navigate = (target: StockAlertLinkTarget, item?: StockAlertItem) => {
    if (!target) return;
    setOpen(false);
    if (target === 'stock-inventory') onOpenStockInventory(item?.medicine_id ?? null);
    else onOpenProducts(item?.name ?? null);
  };

  const renderAlertRow = (item: StockAlertItem) => {
    const rowContent = (
      <>
        <span className="block truncate font-bold text-text">{item.name}</span>
        <span className="block text-xs text-muted">
          {item.strength ? `${item.strength} · ` : ''}Stock {item.stock.toLocaleString()}, reorder at {item.min_stock_alert.toLocaleString()}
        </span>
      </>
    );

    return linkTarget ? (
      <a
        key={stockAlertKey(item)}
        href={linkTarget === 'stock-inventory' ? '/stock-inventory' : '/products'}
        onClick={(event) => {
          event.preventDefault();
          navigate(linkTarget, item);
        }}
        className="block rounded-control px-3 py-2 text-sm hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {rowContent}
      </a>
    ) : (
      <div key={stockAlertKey(item)} className="px-3 py-2 text-sm">
        {rowContent}
      </div>
    );
  };

  const renderSection = (
    title: string,
    kind: StockAlertItem['kind'],
    sectionItems: StockAlertItem[],
    count: number,
  ) => (
    <section aria-labelledby={`stock-alert-${kind}-title`}>
      <div className="flex items-center justify-between px-3 pb-1">
        <h3 id={`stock-alert-${kind}-title`} className="text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>
        <span className="text-xs font-semibold text-muted">{count.toLocaleString()}</span>
      </div>
      <div className="divide-y divide-border">
        {sectionItems.map(renderAlertRow)}
      </div>
      {count > sectionItems.length && (
        <p className="px-3 py-2 text-xs text-muted">
          and {(count - sectionItems.length).toLocaleString()} more
        </p>
      )}
    </section>
  );

  const renderDeveloperAnnouncements = () => !isDesktopMode() ? null : (
    <section aria-labelledby="developer-announcements-title">
      <div className="px-3 pb-1">
        <h3 id="developer-announcements-title" className="text-xs font-bold uppercase tracking-wide text-muted">
          Developer updates
        </h3>
      </div>
      {announcementError ? (
        <p role="alert" className="px-3 py-2 text-sm text-danger">{announcementError}</p>
      ) : announcements.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">No developer updates</p>
      ) : (
        <div className="divide-y divide-border">
          {announcements.map((announcement) => (
            <article key={announcement.id} className="px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-bold text-text">{announcement.title}</h4>
                {announcement.read_at === null && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">New</span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{announcement.body}</p>
              <time className="mt-1 block text-xs text-muted" dateTime={announcement.published_at}>
                {new Date(announcement.published_at).toLocaleString()}
              </time>
            </article>
          ))}
        </div>
      )}
    </section>
  );

  const linkHref = linkTarget === 'stock-inventory' ? '/stock-inventory' : '/products';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={error
          ? 'Stock alerts unavailable; try again'
          : summary
            ? `Alerts, ${combinedCount.toLocaleString()} total`
            : 'Alerts, loading'}
        aria-expanded={open}
        aria-controls="stock-alert-panel"
        title={error ? `Stock alerts unavailable: ${error}` : 'Stock alerts and developer updates'}
        onClick={openPanel}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-control border border-border bg-surface text-muted hover:bg-primary/5 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Bell aria-hidden="true" className="h-4 w-4" />
        {badgeCount && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] font-bold leading-5 text-white">
            {badgeCount}
          </span>
        )}
        {(unseenKeys.length > 0 || unreadAnnouncements.length > 0) && !error && (
          <span
            aria-hidden="true"
            className={`absolute left-0 top-0 h-2 w-2 rounded-full bg-danger ring-2 ring-surface ${
              animationsEnabled ? 'animate-pulse motion-reduce:animate-none' : ''
            }`}
          />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id="stock-alert-panel"
          role="dialog"
          aria-label="Stock alerts"
          className="fixed left-0 right-0 top-[var(--stock-alert-panel-top)] z-50 max-h-[calc(100dvh-var(--stock-alert-panel-top)-1rem)] overflow-y-auto rounded-b-xl border border-border bg-surface shadow-lg sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[min(70vh,36rem)] sm:w-[min(24rem,calc(100vw-2rem))] sm:rounded-xl"
          style={{ '--stock-alert-panel-top': `${panelTop}px` } as CSSProperties}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
            <div>
              <h2 className="font-bold text-text">Alerts</h2>
              <p className="text-xs text-muted">
                {error
                  ? 'Unable to refresh'
                  : summary
                  ? `${totalCount.toLocaleString()} stock · ${unreadAnnouncements.length.toLocaleString()} new update(s) · ${summary.out_count.toLocaleString()} out · ${summary.low_count.toLocaleString()} low`
                  : 'Current inventory'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void refresh();
                void refreshAnnouncements();
              }}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-control border border-border px-2.5 py-1.5 text-xs font-semibold text-text hover:bg-primary/5 disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loading && animationsEnabled ? 'animate-spin motion-reduce:animate-none' : ''}`} />
              Refresh
            </button>
          </div>

          {loading ? (
            <div aria-label="Loading stock alerts" className="space-y-3 p-4">
              <div className="h-3 w-28 rounded bg-border" />
              <div className="h-10 rounded-control bg-border/60" />
              <div className="h-10 rounded-control bg-border/60" />
              <div className="h-3 w-24 rounded bg-border" />
              <div className="h-10 rounded-control bg-border/60" />
            </div>
          ) : error ? (
            <div>
              <div role="alert" className="m-4 rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-text">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="mt-2 rounded-control border border-border px-3 py-1.5 text-xs font-semibold text-text hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Retry
                </button>
              </div>
              <div className="py-3">{renderDeveloperAnnouncements()}</div>
            </div>
          ) : totalCount === 0 && announcements.length === 0 && !isDesktopMode() ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No stock alerts or developer updates</p>
          ) : (
            <div className="space-y-4 py-3">
              {totalCount > 0 && (
                <>
                  {renderSection('Out of stock', 'out', outItems, summary?.out_count ?? 0)}
                  {renderSection('Low stock', 'low', lowItems, summary?.low_count ?? 0)}
                </>
              )}
              {renderDeveloperAnnouncements()}
            </div>
          )}

          {!loading && !error && linkTarget && (
            <div className="border-t border-border px-4 py-3">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <a
                  href={linkHref}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(linkTarget);
                  }}
                  className="text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  View all out of stock
                </a>
                <a
                  href={linkHref}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(linkTarget);
                  }}
                  className="text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  View all low stock
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
