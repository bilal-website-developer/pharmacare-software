import { useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { fetchAllSupabaseRows } from '../utils/fetchAllSupabaseRows';
import { supabase } from '../utils/supabase';
import { isDesktopMode, localApiRequest } from '../services/localApi';
import {
  chunkProductImportRows,
  parseProductCsv,
  previewProductCsv,
  type ProductImportPreviewRow,
} from './inventory/productImportLogic';

interface SettingsProductCsvProps {
  canImportProducts: boolean;
  canExportProducts: boolean;
  canImportOpeningStock: boolean;
}

interface ProductCsvRecord {
  code: string;
  barcode: string;
  brandName: string;
  genericName: string;
  strength: string;
  category: string;
  company: string;
  drugClass: string;
  storageCondition: string;
  rackLocation: string;
  minStockAlert: number;
  stock: number;
  nearestExpiry: string;
  requiresPrescription: boolean;
  isActive: boolean;
  unitName: string;
  conversionFactor: number;
  pricePaisa: number;
  unitBarcode: string;
}

const HEADERS = [
  'code',
  'barcode',
  'brand_name',
  'generic_name',
  'strength',
  'category',
  'company',
  'drug_class',
  'storage_condition',
  'rack_location',
  'min_stock_alert',
  'current_stock_reference_smallest_unit',
  'nearest_expiry',
  'requires_prescription',
  'is_active',
  'unit_name',
  'conversion_factor',
  'price_paisa',
  'unit_barcode',
  'opening_stock_qty',
  'opening_batch_number',
  'opening_expiry_date',
  'opening_cost_paisa',
] as const;

const TEMPLATE_ROW = [
  'DEMO-TEMPLATE-001',
  '',
  'DEMO TEMPLATE PRODUCT',
  'DEMO GENERIC',
  '',
  'Demo Category',
  'Demo Manufacturer',
  'OTC',
  'ROOM_TEMPERATURE',
  '',
  '0',
  '',
  '',
  'false',
  'false',
  'Box',
  '1',
  '0',
  '',
  '0',
  '',
  '',
  '',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`The product export is missing ${field}.`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The product export has an invalid ${field}.`);
  }
  return value;
}

function normalizeLocalProduct(value: unknown): ProductCsvRecord {
  if (!isRecord(value) || !Array.isArray(value.units)) {
    throw new Error('The local product export returned invalid product data.');
  }
  const unit = value.units.find((item) => isRecord(item) && item.isDefaultSaleUnit === true);
  if (!isRecord(unit)) throw new Error('A product has no active default sale unit.');
  return {
    code: requiredString(value.code, 'product code'),
    barcode: typeof value.barcode === 'string' ? value.barcode : '',
    brandName: requiredString(value.brandName, 'product name'),
    genericName: requiredString(value.genericName, 'generic name'),
    strength: typeof value.strength === 'string' ? value.strength : '',
    category: typeof value.category === 'string' ? value.category : '',
    company: typeof value.company === 'string' ? value.company : '',
    drugClass: requiredString(value.drugClass, 'classification'),
    storageCondition: requiredString(value.storageCondition, 'storage condition'),
    rackLocation: typeof value.rackLocation === 'string' ? value.rackLocation : '',
    minStockAlert: requiredNumber(value.minStockAlert, 'minimum stock'),
    stock: requiredNumber(value.currentStockSmallestUnit, 'stock reference'),
    nearestExpiry: typeof value.nearestExpiry === 'string' ? value.nearestExpiry : '',
    requiresPrescription: value.requiresPrescription === true,
    isActive: value.isActive === true,
    unitName: requiredString(unit.name, 'unit name'),
    conversionFactor: requiredNumber(unit.conversionFactor, 'unit conversion factor'),
    pricePaisa: requiredNumber(unit.pricePerUnitPaisa, 'sale price'),
    unitBarcode: typeof unit.barcode === 'string' ? unit.barcode : '',
  };
}

function normalizeSupabaseProduct(value: unknown, units: readonly Record<string, unknown>[]): ProductCsvRecord {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('The product export returned invalid product data.');
  }
  const unit = units.find((item) => item.medicine_id === value.id && item.is_default_sale_unit === true);
  if (!unit) throw new Error('A product has no active default sale unit.');
  return {
    code: requiredString(value.code, 'product code'),
    barcode: typeof value.barcode === 'string' ? value.barcode : '',
    brandName: requiredString(value.brand_name, 'product name'),
    genericName: requiredString(value.generic_name, 'generic name'),
    strength: typeof value.strength === 'string' ? value.strength : '',
    category: requiredString(value.category, 'category'),
    company: requiredString(value.company, 'manufacturer'),
    drugClass: requiredString(value.drug_class, 'classification'),
    storageCondition: requiredString(value.storage_condition, 'storage condition'),
    rackLocation: requiredString(value.rack_location, 'rack location'),
    minStockAlert: requiredNumber(value.min_stock_alert, 'minimum stock'),
    stock: requiredNumber(value.stock, 'stock reference'),
    nearestExpiry: typeof value.nearest_expiry === 'string' ? value.nearest_expiry : '',
    requiresPrescription: value.requires_prescription === true,
    isActive: value.is_active === true,
    unitName: requiredString(unit.name, 'unit name'),
    conversionFactor: requiredNumber(unit.conversion_factor, 'unit conversion factor'),
    pricePaisa: requiredNumber(unit.price_paisa, 'sale price'),
    unitBarcode: typeof unit.barcode === 'string' ? unit.barcode : '',
  };
}

function csvCell(value: unknown): string {
  if (value !== null && value !== undefined
    && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('Product CSV contains a value that cannot be exported.');
  }
  return `"${value == null ? '' : String(value).replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: readonly string[], rows: readonly (readonly unknown[])[]): void {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function recordToCsvRow(product: ProductCsvRecord): (string | number | boolean)[] {
  return [
    product.code,
    product.barcode,
    product.brandName,
    product.genericName,
    product.strength,
    product.category,
    product.company,
    product.drugClass,
    product.storageCondition,
    product.rackLocation,
    product.minStockAlert,
    product.stock,
    product.nearestExpiry,
    product.requiresPrescription,
    product.isActive,
    product.unitName,
    product.conversionFactor,
    product.pricePaisa,
    product.unitBarcode,
    '',
    '',
    '',
    '',
  ];
}

export function SettingsProductCsv({
  canImportProducts,
  canExportProducts,
  canImportOpeningStock,
}: SettingsProductCsvProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ProductImportPreviewRow[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [importedCount, setImportedCount] = useState(0);

  const loadProducts = async (): Promise<ProductCsvRecord[]> => {
    if (isDesktopMode()) {
      const products: ProductCsvRecord[] = [];
      let page = 1;
      let expectedCount = 0;
      do {
        const query = new URLSearchParams({
          page: String(page),
          limit: '500',
          status: 'all',
          sortColumn: 'name',
          sortDirection: 'asc',
        });
        const response = await localApiRequest<unknown>(`/api/inventory/products?${query.toString()}`);
        if (!isRecord(response) || !Array.isArray(response.products) || typeof response.total !== 'number') {
          throw new Error('The local product export returned an invalid response.');
        }
        if (page === 1) expectedCount = response.total;
        if (response.total !== expectedCount) {
          throw new Error('Products changed while the export was being prepared. Retry the export.');
        }
        products.push(...response.products.map(normalizeLocalProduct));
        if (response.products.length === 0 && products.length < expectedCount) {
          throw new Error('The product export ended before all products were returned.');
        }
        page += 1;
        setNotice({
          text: `Loading products for export: ${Math.min(products.length, expectedCount).toLocaleString()} of ${expectedCount.toLocaleString()}…`,
          error: false,
        });
      } while (products.length < expectedCount);
      return products;
    }

    const client = supabase;
    if (!client) throw new Error('Supabase is not configured for web exports.');
    const products: ProductCsvRecord[] = [];
    let page = 1;
    let expectedCount = 0;
    do {
      const { data, error } = await client.rpc('products_list', {
        p_search: null,
        p_category: null,
        p_manufacturer: null,
        p_class: null,
        p_status: 'all',
        p_low_only: false,
        p_sort_col: 'name',
        p_sort_dir: 'asc',
        p_page: page,
        p_page_size: 200,
      });
      if (error) throw error;
      if (!isRecord(data) || !Array.isArray(data.rows) || typeof data.total_count !== 'number') {
        throw new Error('The web product export returned an invalid response.');
      }
      if (page === 1) expectedCount = data.total_count;
      if (data.total_count !== expectedCount) {
        throw new Error('Products changed while the export was being prepared. Retry the export.');
      }
      if (data.rows.length === 0 && products.length < expectedCount) {
        throw new Error('The product export ended before all products were returned.');
      }
      if (data.rows.length > 0) {
        const ids = data.rows.flatMap((row) => isRecord(row) && typeof row.id === 'string' ? [row.id] : []);
        if (ids.length !== data.rows.length) throw new Error('The web product export returned invalid product IDs.');
        const units = await fetchAllSupabaseRows((from, to) => client
          .from('medicine_units')
          .select('medicine_id,name,conversion_factor,is_default_sale_unit,price_paisa,barcode')
          .in('medicine_id', ids)
          .order('is_default_sale_unit', { ascending: false })
          .order('id')
          .range(from, to));
        products.push(...data.rows.map((row) => normalizeSupabaseProduct(row, units)));
      }
      page += 1;
      setNotice({
        text: `Loading products for export: ${Math.min(products.length, expectedCount).toLocaleString()} of ${expectedCount.toLocaleString()}…`,
        error: false,
      });
    } while (products.length < expectedCount);
    return products;
  };

  const exportProducts = async (format: 'csv' | 'xlsx') => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ text: 'Loading the complete product catalog for export…', error: false });
      const products = await loadProducts();
      if (products.length === 0) {
        setNotice({ text: 'There are no products to export.', error: false });
        return;
      }
      const rows = products.map(recordToCsvRow);
      const date = new Date().toISOString().slice(0, 10);
      if (format === 'csv') {
        downloadCsv(`pharma-care-products-${date}.csv`, HEADERS, rows);
      } else {
        const XLSX = await import('@e965/xlsx');
        const worksheet = XLSX.utils.aoa_to_sheet([[...HEADERS], ...rows]);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
        XLSX.writeFile(workbook, `pharma-care-products-${date}.xlsx`);
      }
      setNotice({ text: `Exported all ${products.length.toLocaleString()} products to ${format.toUpperCase()}.`, error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not export products.', error: true });
    } finally {
      setBusy(false);
    }
  };

  const prepareImport = async (file: File) => {
    setBusy(true);
    setPreview(null);
    setImportedCount(0);
    setNotice(null);
    try {
      setNotice({ text: 'Reading the CSV and checking its rows…', error: false });
      const rows = previewProductCsv(parseProductCsv(await file.text()), []);
      const apiRows = rows.map(({ line, values }) => ({ ...values, line }));
      const databaseResults: unknown[] = [];
      const batches = chunkProductImportRows(apiRows);
      for (const [index, batch] of batches.entries()) {
        let data: unknown;
        if (isDesktopMode()) {
          data = await localApiRequest<unknown>('/api/inventory/products/import-preview', 'POST', { rows: batch });
        } else {
          if (!supabase) throw new Error('Supabase is not configured for web imports.');
          const result = await supabase.rpc('products_import_preview', { rows: batch });
          if (result.error) throw result.error;
          data = result.data;
        }
        if (!Array.isArray(data) || data.some((row) => !isRecord(row)
          || typeof row.line !== 'number' || typeof row.duplicate_in_database !== 'boolean')) {
          throw new Error('The import-preview service returned invalid data.');
        }
        databaseResults.push(...data);
        setNotice({
          text: `Checking duplicates: ${Math.min((index + 1) * 500, apiRows.length).toLocaleString()} of ${apiRows.length.toLocaleString()}…`,
          error: false,
        });
      }
      const duplicates = new Set(databaseResults.flatMap((row) =>
        isRecord(row) && row.duplicate_in_database && typeof row.line === 'number' ? [row.line] : []));
      const reviewed = rows.map((row) => ({
        ...row,
        errors: duplicates.has(row.line)
          ? [...row.errors, 'This product duplicates a database record.']
          : row.errors,
      }));
      setPreview(reviewed);
      const invalid = reviewed.filter((row) => row.errors.length > 0).length;
      setNotice({
        text: `Ready to review ${reviewed.length.toLocaleString()} rows: ${(reviewed.length - invalid).toLocaleString()} valid, ${invalid.toLocaleString()} need correction or are duplicates.`,
        error: invalid > 0,
      });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not prepare the product import.', error: true });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const importProducts = async () => {
    if (!preview || busy) return;
    const validRows = preview.filter((row) => row.errors.length === 0)
      .map(({ line, values }) => ({ ...values, line }));
    if (validRows.length === 0) {
      setNotice({ text: 'There are no valid rows to import. Correct the CSV and try again.', error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    let completed = 0;
    try {
      for (const batch of chunkProductImportRows(validRows)) {
        let data: unknown;
        if (isDesktopMode()) {
          data = await localApiRequest<unknown>('/api/inventory/products/import', 'POST', { rows: batch });
        } else {
          if (!supabase) throw new Error('Supabase is not configured for web imports.');
          const result = await supabase.rpc('products_bulk_import_with_opening_stock', { rows: batch });
          if (result.error) throw result.error;
          data = result.data;
        }
        if (!isRecord(data)) throw new Error('The product import returned an invalid response.');
        const count = data.importedCount ?? data.imported_count;
        if (typeof count !== 'number' || count !== batch.length) {
          throw new Error('The product import did not confirm every row in the batch.');
        }
        completed += count;
        setNotice({
          text: `Imported ${completed.toLocaleString()} of ${validRows.length.toLocaleString()} products…`,
          error: false,
        });
      }
      setImportedCount(completed);
      setPreview(null);
      setNotice({ text: `Imported ${completed.toLocaleString()} products successfully.`, error: false });
    } catch (error) {
      setImportedCount(completed);
      setNotice({
        text: completed > 0
          ? `Imported ${completed.toLocaleString()} products before the next batch failed. Re-select the file to check for duplicates before retrying. ${error instanceof Error ? error.message : ''}`
          : error instanceof Error ? error.message : 'Could not import products.',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const validCount = preview?.filter((row) => row.errors.length === 0).length ?? 0;
  const invalidRows = preview?.filter((row) => row.errors.length > 0) ?? [];

  if (!canImportProducts && !canExportProducts) return null;

  return (
    <section className="space-y-4 rounded-card border border-border bg-white p-5 shadow-xs sm:p-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-black text-text">
          <Download size={16} className="text-primary" /> Product CSV import &amp; export
        </h2>
        <p className="mt-1 text-xs text-muted">
          Export includes all products, independent of the Products page filters. There is no total-row limit; imports and exports are processed in bounded batches.
        </p>
        <p className="mt-1 text-xs text-muted">
          Prices and opening costs are whole paisa values. Opening stock is in sale units and requires an accurate batch number, future expiry date, and cost per sale unit. Existing aggregate stock is reference-only and is never converted into an invented batch.
        </p>
        {!canImportOpeningStock && canImportProducts && (
          <p className="mt-1 text-xs text-warning">
            Your role can import products but cannot record opening stock costs. Ask an Admin or Manager to import rows with opening stock.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canImportProducts && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose product CSV in Settings"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void prepareImport(file);
              }}
            />
            <button type="button" className="rounded-control bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => fileInput.current?.click()}>
              <FileUp className="mr-1 inline" size={14} /> Import CSV
            </button>
            <button
              type="button"
              className="rounded-control border border-border px-3 py-2 text-xs font-semibold text-text disabled:opacity-50"
              disabled={busy}
              onClick={() => downloadCsv('pharma-care-products-template.csv', HEADERS, [TEMPLATE_ROW])}
            >
              <Download className="mr-1 inline" size={14} /> Download template
            </button>
          </>
        )}
        {canExportProducts && (
          <>
            <button type="button" className="rounded-control border border-border px-3 py-2 text-xs font-semibold text-text disabled:opacity-50" disabled={busy} onClick={() => void exportProducts('csv')}>
              <Download className="mr-1 inline" size={14} /> {busy ? 'Working…' : 'Export all CSV'}
            </button>
            <button type="button" className="rounded-control border border-border px-3 py-2 text-xs font-semibold text-text disabled:opacity-50" disabled={busy} onClick={() => void exportProducts('xlsx')}>
              <Download className="mr-1 inline" size={14} /> {busy ? 'Working…' : 'Export all XLSX'}
            </button>
          </>
        )}
      </div>

      {preview && (
        <div className="space-y-2 rounded-control border border-border bg-surface p-3 text-xs">
          <p className="font-semibold text-text">
            Preview: {validCount.toLocaleString()} valid, {invalidRows.length.toLocaleString()} skipped.
          </p>
          {invalidRows.slice(0, 3).map((row) => (
            <p key={row.line} className="text-danger">Line {row.line}: {row.errors.join(' ')}</p>
          ))}
          {invalidRows.length > 3 && <p className="text-muted">{(invalidRows.length - 3).toLocaleString()} more rows need correction.</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className="rounded-control bg-primary px-3 py-2 font-bold text-white disabled:opacity-50" disabled={busy || validCount === 0} onClick={() => void importProducts()}>
              Import {validCount.toLocaleString()} valid rows
            </button>
            <button type="button" className="rounded-control border border-border px-3 py-2 font-semibold text-text" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className={`text-xs ${notice.error ? 'text-danger' : 'text-success'}`}>
          {notice.text}{importedCount > 0 && notice.error ? ` Confirmed imported rows: ${importedCount.toLocaleString()}.` : ''}
        </p>
      )}
    </section>
  );
}
