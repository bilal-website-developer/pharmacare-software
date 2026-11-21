import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, LoaderCircle, X } from 'lucide-react';
import { localApiRequest } from '../../services/localApi';
import { STOCK_CHANGED_EVENT } from '../../utils/stockAlertsEvents';

interface LocalSaleForReturn {
  id: string;
  invoiceNumber: string;
  items: Array<{
    saleItemId: string;
    productName: string;
    unitName: string;
    quantityInUnit: number;
  }>;
}

interface DirectSaleReturnPanelProps {
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

export const DirectSaleReturnPanel: React.FC<DirectSaleReturnPanelProps> = ({
  triggerClassName,
  onOpenChange,
}) => {
  const [open, setOpen] = useState(false);
  const [sales, setSales] = useState<LocalSaleForReturn[]>([]);
  const [saleId, setSaleId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sale = sales.find((candidate) => candidate.id === saleId);

  useEffect(() => onOpenChange?.(open), [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    setError('');
    void localApiRequest<LocalSaleForReturn[]>('/api/pos/return-sales?limit=1000')
      .then((loadedSales) => {
        if (active) setSales(loadedSales);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load sales for return.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const submitReturn = async (event: React.FormEvent) => {
    event.preventDefault();
    const items = Object.entries(quantities)
      .map(([saleItemId, quantity]) => ({ saleItemId, quantityInUnit: Number(quantity) }))
      .filter((item) => Number.isSafeInteger(item.quantityInUnit) && item.quantityInUnit > 0);
    if (!sale || !reason.trim() || items.length === 0) {
      setError('Choose a sale, enter a reason, and set a return quantity for at least one item.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await localApiRequest<{ returnNumber: string; totalRefundPaisa: number }>(
        '/api/reports/returns',
        'POST',
        {
          saleId: sale.id,
          reason: reason.trim(),
          disposition: 'QUARANTINE',
          items,
        },
      );
      setNotice(`Return ${result.returnNumber} recorded. Refund: Rs ${(result.totalRefundPaisa / 100).toFixed(2)}.`);
      setSaleId('');
      setQuantities({});
      setReason('');
      window.dispatchEvent(new CustomEvent(STOCK_CHANGED_EVENT));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not record the medicine return.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClassName}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        <span>Returns</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-return-title"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-5 shadow-xl"
          >
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 id="direct-return-title" className="text-lg font-black">Record medicine return</h2>
              <button type="button" aria-label="Close returns" onClick={() => setOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </header>
            {notice && <p role="status" className="mb-3 rounded-control bg-success/10 p-3 text-sm">{notice}</p>}
            {error && <p role="alert" className="mb-3 rounded-control bg-danger/10 p-3 text-sm">{error}</p>}
            <form onSubmit={(event) => void submitReturn(event)} className="space-y-4">
              <label className="block text-sm font-semibold">
                Sale
                <select
                  aria-label="Sale"
                  value={saleId}
                  onChange={(event) => {
                    setSaleId(event.target.value);
                    setQuantities({});
                  }}
                  className="mt-1 w-full rounded-control border border-border p-2"
                >
                  <option value="">Select an invoice</option>
                  {sales.map((item) => (
                    <option key={item.id} value={item.id}>{item.invoiceNumber}</option>
                  ))}
                </select>
              </label>
              {sale?.items.map((item) => (
                <label key={item.saleItemId} className="flex items-center justify-between gap-3 text-sm">
                  <span>{item.productName} ({item.unitName}; sold {item.quantityInUnit})</span>
                  <input
                    aria-label={`Return quantity ${item.productName}`}
                    type="number"
                    min="0"
                    max={item.quantityInUnit}
                    step="1"
                    value={quantities[item.saleItemId] || ''}
                    onChange={(event) => setQuantities((current) => ({
                      ...current,
                      [item.saleItemId]: event.target.value,
                    }))}
                    className="w-24 rounded-control border border-border p-2"
                  />
                </label>
              ))}
              <label className="block text-sm font-semibold">
                Reason
                <textarea
                  aria-label="Return reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="mt-1 w-full rounded-control border border-border p-2"
                  rows={2}
                />
              </label>
              <p className="text-xs text-muted">Returned medicine is quarantined and will not be available for sale.</p>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-control bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              >
                {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
                Record return
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
};
