import { parseCsvRows } from '../../utils/csv';

export interface ParsedProductCsvRow {
  line: number;
  values: Record<string, string>;
}

export interface ProductDuplicateIdentity {
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  company: string;
  strength?: string | null;
  strength_present?: boolean;
}

export interface ProductImportPreviewRow extends ParsedProductCsvRow {
  errors: string[];
}

export const PRODUCT_IMPORT_BATCH_SIZE = 500;

const REQUIRED_HEADERS = [
  'code',
  'brand_name',
  'generic_name',
  'category',
  'company',
  'unit_name',
  'conversion_factor',
  'price_paisa',
] as const;

export function parseProductCsv(text: string): ParsedProductCsvRow[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('The CSV file has a header row and at least one product row.');

  const headers = rows[0].map((value) => value.trim().replace(/^\uFEFF/, ''));
  if (new Set(headers).size !== headers.length) throw new Error('The CSV file contains duplicate column names.');
  const missingHeader = REQUIRED_HEADERS.find((header) => !headers.includes(header));
  if (missingHeader) throw new Error(`CSV is missing the required "${missingHeader}" column.`);

  return rows.slice(1).map((values, index) => ({
    line: index + 2,
    values: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ''])),
  }));
}

export function chunkProductImportRows<T>(
  rows: readonly T[],
  batchSize = PRODUCT_IMPORT_BATCH_SIZE,
): T[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('Import batch size must be a positive whole number.');
  }
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}

function normalized(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

function fallbackIdentityKey(product: ProductDuplicateIdentity, includeStrength: boolean) {
  const identity = [normalized(product.brand_name), normalized(product.company)];
  if (includeStrength) identity.push(normalized(product.strength));
  return JSON.stringify(identity);
}

export function previewProductCsv(
  rows: readonly ParsedProductCsvRow[],
  existingProducts: readonly ProductDuplicateIdentity[],
  today = new Date().toISOString().slice(0, 10),
): ProductImportPreviewRow[] {
  const seenBarcodes = new Set<string>();
  const seenFallbackIdentities = new Set<string>();
  const seenStrengthIdentities = new Set<string>();
  for (const product of existingProducts) {
    if (product.barcode) seenBarcodes.add(normalized(product.barcode));
    seenFallbackIdentities.add(fallbackIdentityKey(product, false));
    seenStrengthIdentities.add(fallbackIdentityKey(product, true));
  }
  const seenCodes = new Set<string>();
  return rows.map(({ line, values }) => {
    const errors: string[] = [];
    const product = {
      code: values.code ?? '',
      barcode: values.barcode?.trim() || null,
      brand_name: values.brand_name ?? '',
      generic_name: values.generic_name ?? '',
      company: values.company ?? '',
      strength: values.strength ?? null,
      strength_present: Object.prototype.hasOwnProperty.call(values, 'strength'),
    };

    if (![product.code, product.brand_name, product.generic_name, product.company].every((value) => value.trim())) {
      errors.push('Code, product name, generic name, and manufacturer are required.');
    }
    if (!values.category?.trim()) errors.push('Category is required.');
    if (!values.unit_name?.trim()) errors.push('Unit is required.');
    const conversionFactor = Number(values.conversion_factor);
    const pricePaisa = Number(values.price_paisa);
    const minimumStock = Number(values.min_stock_alert || 0);
    if (!Number.isSafeInteger(conversionFactor) || conversionFactor < 1 || conversionFactor > 2_147_483_647) {
      errors.push('Conversion factor must be a positive whole number.');
    }
    if (!Number.isSafeInteger(pricePaisa) || pricePaisa < 0 || pricePaisa > 2_147_483_647) {
      errors.push('Price must be a non-negative whole number of paisa.');
    }
    if (!Number.isSafeInteger(minimumStock) || minimumStock < 0 || minimumStock > 2_147_483_647) {
      errors.push('Minimum stock must be a non-negative whole number.');
    }
    const openingStockQuantity = Number(values.opening_stock_qty || 0);
    const openingCostPaisa = Number(values.opening_cost_paisa);
    const openingBatchNumber = values.opening_batch_number?.trim() ?? '';
    const openingExpiryDate = values.opening_expiry_date?.trim() ?? '';
    const hasOpeningBatchDetails = Boolean(openingBatchNumber || openingExpiryDate || values.opening_cost_paisa?.trim());
    const openingExpiryTimestamp = Date.parse(`${openingExpiryDate}T00:00:00Z`);
    const validOpeningExpiry = /^\d{4}-\d{2}-\d{2}$/.test(openingExpiryDate)
      && Number.isFinite(openingExpiryTimestamp)
      && new Date(openingExpiryTimestamp).toISOString().slice(0, 10) === openingExpiryDate;
    if (!Number.isSafeInteger(openingStockQuantity) || openingStockQuantity < 0
      || openingStockQuantity > 2_147_483_647) {
      errors.push('Opening stock quantity must be a non-negative whole number.');
    } else if (openingStockQuantity > 0) {
      if (!openingBatchNumber) errors.push('Opening batch number is required when opening stock is greater than zero.');
      if (!validOpeningExpiry || openingExpiryDate <= today) {
        errors.push('Opening stock expiry must be a valid future date in YYYY-MM-DD format.');
      }
      if (!Number.isSafeInteger(openingCostPaisa) || openingCostPaisa < 0
        || openingCostPaisa > 2_147_483_647) {
        errors.push('Opening stock cost must be a non-negative whole number of paisa per sale unit.');
      }
      const baseQuantity = openingStockQuantity * conversionFactor;
      if (!Number.isSafeInteger(baseQuantity) || baseQuantity > 2_147_483_647) {
        errors.push('Opening stock quantity exceeds the supported stock limit.');
      }
    } else if (hasOpeningBatchDetails) {
      errors.push('Opening batch details require a positive opening stock quantity.');
    }
    if (values.drug_class && !['OTC', 'RX', 'CONTROLLED', 'NARCOTIC'].includes(values.drug_class)) {
      errors.push('Medicine classification is unsupported.');
    }
    if (values.storage_condition && !['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED'].includes(values.storage_condition)) {
      errors.push('Storage condition is unsupported.');
    }
    for (const booleanField of ['requires_prescription', 'is_active']) {
      const value = values[booleanField]?.trim().toLowerCase();
      if (value && !['true', 'false', 't', 'f', 'yes', 'no', 'y', 'n', '1', '0'].includes(value)) {
        errors.push(`${booleanField} must be a valid boolean value.`);
      }
    }
    const code = normalized(product.code);
    const identityAlreadySeen = product.barcode
      ? seenBarcodes.has(normalized(product.barcode))
      : (product.strength_present
        ? seenStrengthIdentities.has(fallbackIdentityKey(product, true))
        : seenFallbackIdentities.has(fallbackIdentityKey(product, false)));
    if (seenCodes.has(code) || identityAlreadySeen) {
      errors.push('This product duplicates an existing product or another row in this file.');
    } else {
      if (product.barcode) seenBarcodes.add(normalized(product.barcode));
      seenFallbackIdentities.add(fallbackIdentityKey(product, false));
      seenStrengthIdentities.add(fallbackIdentityKey(product, true));
    }
    if (code) seenCodes.add(code);

    return { line, values, errors };
  });
}
