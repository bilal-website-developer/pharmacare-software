import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { isPosCatalogResponse, toPosCatalogProducts, type PosCatalogProduct } from './posCatalogLogic';
import { getDemoPosCatalog } from './demoDataManager';
import { isDesktopMode, localApiRequest } from '../services/localApi';

export async function loadPosCatalog(): Promise<PosCatalogProduct[]> {
  if (isDesktopMode()) {
    const raw = await localApiRequest<unknown>('/api/pos/catalog');
    if (!Array.isArray(raw)) throw new Error('The local POS catalog service returned an invalid response.');
    const catalog = raw.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const product = entry as Record<string, unknown>;
      if (!Array.isArray(product.units) || !Array.isArray(product.batches) || product.batches.length === 0) return [];
      return [{
        id: product.id,
        code: product.code,
        barcode: product.barcode || null,
        brandName: product.brandName,
        genericName: product.genericName,
        strength: product.strength || null,
        category: product.category,
        company: product.company,
        drugClass: product.drugClass,
        units: product.units,
        batches: product.batches.map((batch) => {
          const item = batch as Record<string, unknown>;
          return {
            id: item.id,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
            receivedDate: item.receivedDate,
            quantitySmallestUnit: item.quantitySmallestUnit,
            status: item.status,
          };
        }),
      }];
    });
    if (!isPosCatalogResponse(catalog)) {
      throw new Error('The local POS catalog service returned invalid product data.');
    }
    return toPosCatalogProducts(catalog);
  }

  if (!supabase) {
    return getDemoPosCatalog();
  }

  try {
    const { data, error } = await supabase.rpc('pos_catalog');
    if (error) throw error;
    if (!isPosCatalogResponse(data)) {
      throw new Error('The POS catalog service returned an invalid response.');
    }

    return toPosCatalogProducts(data);
  } catch (err) {
    throw new Error(getSupabaseErrorMessage(err, 'Could not load the POS catalog.'));
  }
}
