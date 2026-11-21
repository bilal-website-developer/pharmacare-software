import { supabase } from './supabase';
import {
  parseReceiptQrLink,
  parseReceiptQrSettings,
  type ReceiptQrLink,
  type ReceiptQrSettings,
} from './receiptLinkLogic';
import { isDesktopMode, localApiRequest } from '../services/localApi';

export {
  normalizeReceiptBaseUrl,
  parseReceiptQrLink,
  parseReceiptQrSettings,
  parseReceiptScan,
} from './receiptLinkLogic';
export type { ReceiptQrLink, ReceiptQrPlacement, ReceiptQrSettings } from './receiptLinkLogic';

export async function getReceiptQrSettings(): Promise<ReceiptQrSettings> {
  if (isDesktopMode()) {
    const data = await localApiRequest<{ receiptQrSettings?: unknown }>('/api/settings/shop');
    return parseReceiptQrSettings(data.receiptQrSettings);
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_receipt_qr_settings');
  if (error) throw new Error(`Could not load receipt QR settings: ${error.message}`);
  return parseReceiptQrSettings(data);
}

export async function updateReceiptQrSettings(settings: ReceiptQrSettings): Promise<ReceiptQrSettings> {
  if (isDesktopMode()) {
    if (settings.publicReceiptsEnabled) {
      throw new Error('Public receipt links are unavailable in the offline desktop app.');
    }
    const data = await localApiRequest<{ receiptQrSettings?: unknown }>('/api/settings/shop', 'PUT', {
      receiptQrSettings: settings,
    });
    return parseReceiptQrSettings(data.receiptQrSettings);
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('update_receipt_qr_settings', {
    p_settings: {
      publicReceiptsEnabled: settings.publicReceiptsEnabled,
      linkLifetimeDays: settings.linkLifetimeDays,
      showMedicineNames: settings.showMedicineNames,
      qrPlacement: settings.qrPlacement,
      qrBaseUrl: settings.qrBaseUrl,
    },
  });
  if (error) throw new Error(`Could not save receipt QR settings: ${error.message}`);
  return parseReceiptQrSettings(data);
}

export async function getOrCreateReceiptQrLink(saleId: string): Promise<ReceiptQrLink | null> {
  const settings = await getReceiptQrSettings();
  if (!settings.publicReceiptsEnabled) return null;
  if (isDesktopMode()) {
    throw new Error('Public receipt links cannot be created while using the offline desktop app.');
  }
  if (!settings.qrBaseUrl.trim()) {
    throw new Error('Set the public app URL in Receipt QR settings before enabling public receipts.');
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_or_create_receipt_link', { p_sale_id: saleId });
  if (error) throw new Error(`Could not create receipt QR link: ${error.message}`);
  return parseReceiptQrLink(data);
}

export async function regenerateReceiptQrLink(saleId: string): Promise<ReceiptQrLink> {
  if (isDesktopMode()) throw new Error('Public receipt links cannot be regenerated in the offline desktop app.');
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('revoke_receipt_link', { p_sale_id: saleId });
  if (error) throw new Error(`Could not regenerate receipt QR link: ${error.message}`);
  return parseReceiptQrLink(data);
}

export async function regenerateReceiptQrForInvoice(invoiceNumber: string): Promise<ReceiptQrLink> {
  if (isDesktopMode()) throw new Error('Public receipt links cannot be regenerated in the offline desktop app.');
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: saleId, error } = await supabase.rpc('sale_id_for_receipt_invoice', {
    p_invoice_number: invoiceNumber.trim(),
  });
  if (error) throw new Error(`Could not find that sale in this shop: ${error.message}`);
  if (typeof saleId !== 'string') throw new Error('The server returned an invalid sale ID.');
  return regenerateReceiptQrLink(saleId);
}
