import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Check, Download, Edit2, FileUp, Layers, Merge, Plus, RefreshCw, Search,
  Tag, Trash2, X,
} from 'lucide-react';
import { usePermissions } from '../permissions';
import { fetchAllSupabaseRows } from '../utils/fetchAllSupabaseRows';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { isDesktopMode, localApiRequest } from '../services/localApi';
import { downloadTableExport } from '../utils/tableExport';
import { dispatchStockChanged } from '../utils/stockAlertsEvents';
import { findSimilarNames, type SimilarNamePair } from './masterDataSimilarity';
import {
  createMasterDataCsvFile,
  MASTER_DATA_IMPORT_HEADERS,
  mergeMasterUnitImport,
  parseCsvBoolean,
  parseMasterDataCsv,
  type MasterDataImportRow,
  type MasterDataTab,
  type MasterUnitImportValue,
  type MasterUnitValue,
} from './masterDataCsv';

type MasterKind = 'category' | 'brand';
type SortMode = 'name' | 'products' | 'stock';

interface MasterValue {
  id: string;
  name: string;
  is_active: boolean;
  product_count: number;
  low_count: number;
  out_count: number;
  expiring_count: number;
  stock_value_paisa: number | null;
}

interface UnitRow {
  id: string;
  medicine_id: string;
  medicine_code: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
  medicine_name: string;
}

interface MasterOverview {
  categories: MasterValue[];
  manufacturers: MasterValue[];
  summary: {
    category_count: number;
    active_category_count: number;
    manufacturer_count: number;
    active_manufacturer_count: number;
    product_count: number;
    unit_count: number;
  };
}

interface LocalUnitImportProduct {
  id: string;
  code: string;
  barcode: string;
  brandName: string;
  genericName: string;
  strength: string | null;
  categoryId: string | null;
  brandId: string | null;
  drugClass: string;
  storageCondition: string;
  rackLocation: string;
  minStockAlert: number;
  requiresPrescription: boolean;
}

interface WebUnitImportProduct {
  id: string;
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  strength: string | null;
  category: string;
  company: string;
  drug_class: string;
  storage_condition: string;
  rack_location: string;
  min_stock_alert: number;
  requires_prescription: boolean;
  is_active: boolean;
}

const FIELD = 'w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const PANEL = 'rounded-[14px] border border-border bg-surface shadow-[0_1px_8px_rgba(11,59,42,0.08)]';
const BUTTON = 'inline-flex items-center justify-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50';
const SECONDARY = 'inline-flex items-center justify-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface/80 disabled:opacity-50';
const DOT_COLORS = ['bg-primary', 'bg-accent', 'bg-warning', 'bg-danger', 'bg-sky-500', 'bg-violet-500'];

function colorForId(id: string) {
  const hash = Array.from(id).reduce((total, character) => total + character.charCodeAt(0), 0);
  return DOT_COLORS[hash % DOT_COLORS.length];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMasterValue(value: unknown): value is MasterValue {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.is_active === 'boolean'
    && typeof value.product_count === 'number'
    && typeof value.low_count === 'number'
    && typeof value.out_count === 'number'
    && typeof value.expiring_count === 'number'
    && (value.stock_value_paisa === null || typeof value.stock_value_paisa === 'number');
}

function isOverview(value: unknown): value is MasterOverview {
  const summary = isRecord(value) ? value.summary : null;
  return isRecord(value)
    && Array.isArray(value.categories) && value.categories.every(isMasterValue)
    && Array.isArray(value.manufacturers) && value.manufacturers.every(isMasterValue)
    && isRecord(summary)
    && ['category_count', 'active_category_count', 'manufacturer_count', 'active_manufacturer_count', 'product_count', 'unit_count']
      .every((key) => typeof summary[key] === 'number');
}

function isLocalUnitImportProduct(value: unknown): value is LocalUnitImportProduct {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.code === 'string'
    && typeof value.barcode === 'string'
    && typeof value.brandName === 'string'
    && typeof value.genericName === 'string'
    && (typeof value.strength === 'string' || value.strength === null)
    && (typeof value.categoryId === 'string' || value.categoryId === null)
    && (typeof value.brandId === 'string' || value.brandId === null)
    && typeof value.drugClass === 'string'
    && typeof value.storageCondition === 'string'
    && typeof value.rackLocation === 'string'
    && typeof value.minStockAlert === 'number'
    && typeof value.requiresPrescription === 'boolean';
}

function isWebUnitImportProduct(value: unknown): value is WebUnitImportProduct {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.code === 'string'
    && (typeof value.barcode === 'string' || value.barcode === null)
    && typeof value.brand_name === 'string'
    && typeof value.generic_name === 'string'
    && (typeof value.strength === 'string' || value.strength === null)
    && typeof value.category === 'string'
    && typeof value.company === 'string'
    && typeof value.drug_class === 'string'
    && typeof value.storage_condition === 'string'
    && typeof value.rack_location === 'string'
    && typeof value.min_stock_alert === 'number'
    && typeof value.requires_prescription === 'boolean'
    && typeof value.is_active === 'boolean';
}

function errorText(error: unknown) {
  return getSupabaseErrorMessage(error, 'Could not complete the request.');
}

function formatMoney(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sortItems(items: readonly MasterValue[], sort: SortMode) {
  return [...items].sort((left, right) => {
    if (sort === 'products') return right.product_count - left.product_count || left.name.localeCompare(right.name);
    if (sort === 'stock') return (right.stock_value_paisa ?? -1) - (left.stock_value_paisa ?? -1) || left.name.localeCompare(right.name);
    return left.name.localeCompare(right.name);
  });
}

function StatChip({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warning' | 'danger' | 'muted' }) {
  const styles = {
    ok: 'border-primary/25 bg-primary/10 text-primary',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    danger: 'border-danger/25 bg-danger/10 text-danger',
    muted: 'border-border bg-surface text-muted',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[tone]}`}>{children}</span>;
}

export function MasterDataView({ onViewProducts }: {
  onViewProducts: (filter: { field: 'category' | 'company'; value: string }) => void;
}) {
  const { can } = usePermissions();
  const canManage = can('categories');
  const canManageUnits = can('products');
  const canViewProducts = can('products');
  const [tab, setTab] = useState<MasterDataTab>('categories');
  const [overview, setOverview] = useState<MasterOverview | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('name');
  const [loading, setLoading] = useState(true);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [error, setError] = useState('');
  const [unitsError, setUnitsError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ kind: MasterKind; item: MasterValue | null } | null>(null);
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [merge, setMerge] = useState<{ kind: MasterKind; source: MasterValue; targetId: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: MasterKind; item: MasterValue } | null>(null);
  const [saving, setSaving] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadOverview = useCallback(async () => {
    const client = supabase;
    if (!isDesktopMode() && !client) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = isDesktopMode()
        ? await localApiRequest<unknown>('/api/master-data/overview')
        : await (async () => {
          if (!client) throw new Error('Supabase is not configured.');
          const { data: response, error: rpcError } = await client.rpc('master_data_overview');
          if (rpcError) throw rpcError;
          return response;
        })();
      if (!isOverview(data)) throw new Error('The master-data overview returned an invalid response.');
      setOverview(data);
    } catch (caught) {
      setError(errorText(caught));
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUnits = useCallback(async () => {
    const client = supabase;
    if (!isDesktopMode() && !client) {
      setUnitsError('Supabase is not configured.');
      return;
    }
    setUnitsLoading(true);
    setUnitsError('');
    try {
      if (isDesktopMode()) {
        const unitRows = await localApiRequest<unknown>('/api/master-data/units');
        if (!Array.isArray(unitRows) || !unitRows.every((unit) =>
          isRecord(unit)
          && typeof unit.id === 'string'
          && typeof unit.medicine_id === 'string'
          && typeof unit.medicine_code === 'string'
          && typeof unit.name === 'string'
          && typeof unit.conversion_factor === 'number'
          && typeof unit.is_default_sale_unit === 'boolean'
          && typeof unit.price_paisa === 'number'
          && (typeof unit.barcode === 'string' || unit.barcode === null)
          && typeof unit.medicine_name === 'string'
        )) {
          throw new Error('The local medicine-unit service returned an invalid response.');
        }
        setUnits(unitRows as UnitRow[]);
        return;
      }
      if (!client) throw new Error('Supabase is not configured.');
      const [unitRows, medicineRows] = await Promise.all([
        fetchAllSupabaseRows((from, to) => client.from('medicine_units')
          .select('id,medicine_id,name,conversion_factor,is_default_sale_unit,price_paisa,barcode')
          .order('name').order('id').range(from, to)),
        fetchAllSupabaseRows((from, to) => client.from('medicines')
          .select('id,brand_name,generic_name,code').order('id').range(from, to)),
      ]);
      const medicineDetails = new Map(medicineRows.map((medicine) => [
        medicine.id,
        {
          name: `${medicine.brand_name} · ${medicine.generic_name} (${medicine.code})`,
          code: medicine.code,
        },
      ]));
      setUnits(unitRows.map((unit) => ({
        ...unit,
        medicine_name: medicineDetails.get(unit.medicine_id)?.name ?? 'Unknown medicine',
        medicine_code: medicineDetails.get(unit.medicine_id)?.code ?? '',
      })));
    } catch (caught) {
      setUnitsError(errorText(caught));
      setUnits([]);
    } finally {
      setUnitsLoading(false);
    }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { if (tab === 'units') void loadUnits(); }, [loadUnits, tab]);
  useEffect(() => {
    if (!editing && !merge && !pendingDelete) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      setEditing(null);
      setMerge(null);
      setPendingDelete(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [editing, merge, pendingDelete, saving]);

  const openEditor = (kind: MasterKind, item: MasterValue | null) => {
    setEditing({ kind, item });
    setName(item?.name ?? '');
    setActive(item?.is_active ?? true);
    setNotice('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setNotice('Name is required.');
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      if (isDesktopMode()) {
        await localApiRequest('/api/master-data/values', 'POST', {
          kind: editing.kind,
          id: editing.item?.id,
          name: cleanName,
          isActive: active,
        });
      } else {
        if (!supabase) throw new Error('Supabase is not configured.');
        const { error: rpcError } = await supabase.rpc(
          editing.kind === 'category' ? 'save_category' : 'save_brand',
          editing.kind === 'category'
            ? { p_category_id: editing.item?.id ?? null, p_name: cleanName, p_is_active: active }
            : { p_brand_id: editing.item?.id ?? null, p_name: cleanName, p_is_active: active },
        );
        if (rpcError) throw rpcError;
      }
      setEditing(null);
      setNotice(`${editing.kind === 'category' ? 'Category' : 'Manufacturer'} saved.`);
      await loadOverview();
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { kind, item } = pendingDelete;
      if (isDesktopMode()) {
        await localApiRequest(
          `/api/master-data/values/${kind}/${encodeURIComponent(item.id)}`,
          'DELETE',
        );
      } else {
        if (!supabase) throw new Error('Supabase is not configured.');
        const { error: rpcError } = await supabase.rpc(
          kind === 'category' ? 'delete_category' : 'delete_brand',
          kind === 'category' ? { p_category_id: item.id } : { p_brand_id: item.id },
        );
        if (rpcError) throw rpcError;
      }
      setPendingDelete(null);
      setNotice(`${kind === 'category' ? 'Category' : 'Manufacturer'} deleted.`);
      await loadOverview();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const mergeValues = tab === 'categories' ? overview?.categories ?? [] : overview?.manufacturers ?? [];
  const kind: MasterKind = tab === 'categories' ? 'category' : 'brand';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(() => sortItems(
    mergeValues.filter((item) => item.name.toLocaleLowerCase().includes(normalizedQuery)),
    sort,
  ), [mergeValues, normalizedQuery, sort]);
  const similarPairs = useMemo(
    () => findSimilarNames(mergeValues.filter((item) => !normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery))),
    [mergeValues, normalizedQuery],
  );

  const exportCsv = async () => {
    setCsvBusy(true);
    setNotice('');
    try {
      const file = createMasterDataCsvFile(
        tab,
        tab === 'categories' ? visibleItems : [],
        tab === 'brands' ? visibleItems : [],
        units,
      );
      await downloadTableExport(file.filename, file.sheetName, file.headers, file.rows, 'csv');
      setNotice(`Exported ${file.rows.length} ${tab === 'brands' ? 'manufacturer' : tab === 'units' ? 'unit' : 'category'} record${file.rows.length === 1 ? '' : 's'}.`);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setCsvBusy(false);
    }
  };

  const downloadCsvTemplate = async () => {
    setCsvBusy(true);
    setNotice('');
    try {
      const sheetName = tab === 'brands' ? 'Manufacturers' : tab === 'units' ? 'Units' : 'Categories';
      const fileKind = tab === 'brands' ? 'manufacturers' : tab;
      await downloadTableExport(
        `pharma-care-${fileKind}-template`,
        sheetName,
        MASTER_DATA_IMPORT_HEADERS[tab],
        [],
        'csv',
      );
      setNotice(`Downloaded the ${sheetName.toLowerCase()} CSV template.`);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setCsvBusy(false);
    }
  };

  const saveMasterCsvRecord = async (targetKind: MasterKind, value: string, isActive: boolean) => {
    if (isDesktopMode()) {
      await localApiRequest('/api/master-data/values', 'POST', {
        kind: targetKind,
        name: value,
        isActive,
      });
      return;
    }
    if (!supabase) throw new Error('Supabase is not configured.');
    const { error: rpcError } = await supabase.rpc(
      targetKind === 'category' ? 'save_category' : 'save_brand',
      targetKind === 'category'
        ? { p_category_id: null, p_name: value, p_is_active: isActive }
        : { p_brand_id: null, p_name: value, p_is_active: isActive },
    );
    if (rpcError) throw rpcError;
  };

  const findLocalProductForUnitImport = async (code: string): Promise<LocalUnitImportProduct> => {
    const limit = 500;
    let expectedTotal = 0;
    for (let page = 1; (page - 1) * limit < expectedTotal || page === 1; page += 1) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        search: code,
        status: 'all',
      });
      const response = await localApiRequest<unknown>(`/api/inventory/products?${params.toString()}`);
      if (!isRecord(response) || !Array.isArray(response.products) || typeof response.total !== 'number') {
        throw new Error('The local product service returned invalid medicine data.');
      }
      expectedTotal = response.total;
      const match = response.products.find((product) => isRecord(product) && product.code === code);
      if (match) {
        if (!isLocalUnitImportProduct(match)) throw new Error('The local product service returned incomplete medicine data.');
        return match;
      }
      if (response.products.length === 0) break;
    }
    throw new Error(`No medicine matches product code "${code}".`);
  };

  const findWebProductForUnitImport = async (code: string): Promise<WebUnitImportProduct> => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const pageSize = 200;
    let expectedTotal = 0;
    for (let page = 1; (page - 1) * pageSize < expectedTotal || page === 1; page += 1) {
      const { data, error: rpcError } = await supabase.rpc('products_list', {
        p_search: code,
        p_category: null,
        p_manufacturer: null,
        p_class: null,
        p_status: 'all',
        p_low_only: false,
        p_sort_col: 'name',
        p_sort_dir: 'asc',
        p_page: page,
        p_page_size: pageSize,
      });
      if (rpcError) throw rpcError;
      if (!isRecord(data) || !Array.isArray(data.rows) || typeof data.total_count !== 'number') {
        throw new Error('The product service returned invalid medicine data.');
      }
      expectedTotal = data.total_count;
      const match = data.rows.find((product) => isRecord(product) && product.code === code);
      if (match) {
        if (!isWebUnitImportProduct(match)) throw new Error('The product service returned incomplete medicine data.');
        return match;
      }
      if (data.rows.length === 0) break;
    }
    throw new Error(`No medicine matches product code "${code}".`);
  };

  const importMasterNameCsv = async (fileRows: readonly MasterDataImportRow[], selectedTab: MasterDataTab) => {
    const targetKind: MasterKind = selectedTab === 'categories' ? 'category' : 'brand';
    const sourceValues = selectedTab === 'categories' ? overview?.categories ?? [] : overview?.manufacturers ?? [];
    const seenNames = new Set(sourceValues.map((item) => item.name.trim().toLocaleLowerCase()));
    let importedCount = 0;
    let skippedCount = 0;
    const issues: string[] = [];
    const nameColumn = selectedTab === 'categories' ? 'category_name' : 'manufacturer_name';

    for (const row of fileRows) {
      const value = row.values[nameColumn]?.trim() ?? '';
      if (!value || value.length > 120) {
        skippedCount += 1;
        issues.push(`Line ${row.line}: name must contain 1 to 120 characters.`);
        continue;
      }
      let isActive: boolean;
      try {
        isActive = parseCsvBoolean(row.values.is_active ?? '', true) ?? true;
      } catch (caught) {
        skippedCount += 1;
        issues.push(`Line ${row.line}: ${errorText(caught)}`);
        continue;
      }
      const nameKey = value.toLocaleLowerCase();
      if (seenNames.has(nameKey)) {
        skippedCount += 1;
        continue;
      }
      seenNames.add(nameKey);
      try {
        await saveMasterCsvRecord(targetKind, value, isActive);
        importedCount += 1;
      } catch (caught) {
        skippedCount += 1;
        issues.push(`Line ${row.line}: ${errorText(caught)}`);
      }
    }

    await loadOverview();
    const label = selectedTab === 'categories' ? 'category' : 'manufacturer';
    const issueSummary = issues.length ? ` ${issues.slice(0, 3).join(' ')}` : '';
    setNotice(`Imported ${importedCount} ${label} record${importedCount === 1 ? '' : 's'}; skipped ${skippedCount}.${issueSummary}`);
  };

  const importUnitCsv = async (fileRows: readonly MasterDataImportRow[]) => {
    const groups = new Map<string, { rows: MasterUnitImportValue[]; lines: number[] }>();
    let skippedCount = 0;
    const issues: string[] = [];

    for (const row of fileRows) {
      const code = row.values.medicine_code?.trim() ?? '';
      const name = row.values.unit_name?.trim() ?? '';
      const conversionFactor = Number(row.values.conversion_factor);
      const pricePaisa = Number(row.values.price_paisa);
      try {
        if (!code) throw new Error('Medicine product code is required.');
        if (!name || name.length > 120) throw new Error('Unit name must contain 1 to 120 characters.');
        if (!Number.isSafeInteger(conversionFactor) || conversionFactor < 1 || conversionFactor > 2_147_483_647) {
          throw new Error('Conversion factor must be a positive whole number.');
        }
        if (!row.values.price_paisa?.trim()
          || !Number.isSafeInteger(pricePaisa) || pricePaisa < 0 || pricePaisa > 2_147_483_647) {
          throw new Error('Sale price must be a non-negative whole number of paisa.');
        }
        const isDefaultSaleUnit = parseCsvBoolean(row.values.is_default_sale_unit ?? '');
        const unit: MasterUnitImportValue = {
          ...(row.values.unit_id?.trim() ? { unitId: row.values.unit_id.trim() } : {}),
          name,
          conversionFactor,
          ...(isDefaultSaleUnit !== undefined ? { isDefaultSaleUnit } : {}),
          pricePaisa,
          barcode: row.values.barcode?.trim() || null,
        };
        const group = groups.get(code) ?? { rows: [], lines: [] };
        group.rows.push(unit);
        group.lines.push(row.line);
        groups.set(code, group);
      } catch (caught) {
        skippedCount += 1;
        issues.push(`Line ${row.line}: ${errorText(caught)}`);
      }
    }

    let importedCount = 0;
    for (const [code, group] of groups) {
      try {
        const product = isDesktopMode()
          ? { mode: 'local' as const, value: await findLocalProductForUnitImport(code) }
          : { mode: 'web' as const, value: await findWebProductForUnitImport(code) };
        const existingUnits = units
          .filter((unit) => unit.medicine_id === product.value.id)
          .map((unit) => ({
            id: unit.id,
            name: unit.name,
            conversion_factor: unit.conversion_factor,
            is_default_sale_unit: unit.is_default_sale_unit,
            price_paisa: unit.price_paisa,
            barcode: unit.barcode,
          }));
        const mergedUnits = mergeMasterUnitImport(existingUnits, group.rows);

        if (product.mode === 'local') {
          const localProduct = product.value;
          await localApiRequest('/api/inventory/products', 'POST', {
            id: localProduct.id,
            code: localProduct.code,
            barcode: localProduct.barcode,
            brandName: localProduct.brandName,
            genericName: localProduct.genericName,
            strength: localProduct.strength,
            categoryId: localProduct.categoryId,
            brandId: localProduct.brandId,
            drugClass: localProduct.drugClass,
            storageCondition: localProduct.storageCondition,
            rackLocation: localProduct.rackLocation,
            minStockAlert: localProduct.minStockAlert,
            requiresPrescription: localProduct.requiresPrescription,
            units: mergedUnits.map((unit) => ({
              ...(unit.id ? { id: unit.id } : {}),
              name: unit.name,
              conversionFactor: unit.conversion_factor,
              isDefaultSaleUnit: unit.is_default_sale_unit,
              pricePerUnitPaisa: unit.price_paisa,
              barcode: unit.barcode,
            })),
          });
        } else {
          const webProduct = product.value;
          if (!supabase) throw new Error('Supabase is not configured.');
          const { error: saveError } = await supabase.rpc('save_medicine', {
            p_medicine_id: webProduct.id,
            p_values: {
              code: webProduct.code,
              barcode: webProduct.barcode,
              brand_name: webProduct.brand_name,
              generic_name: webProduct.generic_name,
              strength: webProduct.strength,
              category: webProduct.category,
              company: webProduct.company,
              drug_class: webProduct.drug_class,
              storage_condition: webProduct.storage_condition,
              rack_location: webProduct.rack_location,
              min_stock_alert: webProduct.min_stock_alert,
              requires_prescription: webProduct.requires_prescription,
              is_active: webProduct.is_active,
            },
            p_units: mergedUnits.map((unit) => ({
              ...(unit.id ? { id: unit.id } : {}),
              name: unit.name,
              conversion_factor: unit.conversion_factor,
              is_default_sale_unit: unit.is_default_sale_unit,
              price_paisa: unit.price_paisa,
              barcode: unit.barcode,
            })),
          });
          if (saveError) throw saveError;
        }
        importedCount += group.rows.length;
      } catch (caught) {
        skippedCount += group.rows.length;
        issues.push(`Medicine ${code} (lines ${group.lines.join(', ')}): ${errorText(caught)}`);
      }
    }

    if (importedCount > 0) {
      dispatchStockChanged();
      await Promise.all([loadUnits(), loadOverview()]);
    }
    const issueSummary = issues.length ? ` ${issues.slice(0, 3).join(' ')}` : '';
    setNotice(`Imported ${importedCount} unit record${importedCount === 1 ? '' : 's'}; skipped ${skippedCount}.${issueSummary}`);
  };

  const importCsvFile = async (file: File, selectedTab: MasterDataTab) => {
    setCsvBusy(true);
    setNotice('');
    setError('');
    try {
      const rows = parseMasterDataCsv(await file.text(), selectedTab);
      if (selectedTab === 'units') {
        if (!canManageUnits) throw new Error('Products permission is required to import medicine units.');
        await importUnitCsv(rows);
      } else {
        await importMasterNameCsv(rows, selectedTab);
      }
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setCsvBusy(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const beginMerge = (mergeKind: MasterKind, source: MasterValue, target?: MasterValue) => {
    const targets = mergeKind === 'category' ? overview?.categories ?? [] : overview?.manufacturers ?? [];
    const defaultTarget = target ?? targets.find((item) => item.id !== source.id);
    if (!defaultTarget) {
      setNotice('Add another value before merging.');
      return;
    }
    setMerge({ kind: mergeKind, source, targetId: defaultTarget.id });
    setNotice('');
  };

  const performMerge = async () => {
    if (!merge) return;
    const target = (merge.kind === 'category' ? overview?.categories : overview?.manufacturers)
      ?.find((item) => item.id === merge.targetId);
    if (!target) {
      setError('Choose a valid name to keep.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      let updatedCount: number;
      if (isDesktopMode()) {
        const response = await localApiRequest<unknown>('/api/master-data/merge', 'POST', {
          kind: merge.kind,
          sourceId: merge.source.id,
          targetId: target.id,
        });
        if (!isRecord(response) || typeof response.updatedCount !== 'number') {
          throw new Error('The local master-data service returned an invalid merge response.');
        }
        updatedCount = response.updatedCount;
      } else {
        if (!supabase) throw new Error('Supabase is not configured.');
        const { data, error: rpcError } = await supabase.rpc(
          merge.kind === 'category' ? 'merge_categories' : 'merge_brands',
          merge.kind === 'category'
            ? { p_source_category_id: merge.source.id, p_target_category_id: target.id }
            : { p_source_brand_id: merge.source.id, p_target_brand_id: target.id },
        );
        if (rpcError) throw rpcError;
        if (typeof data !== 'number') throw new Error('The merge service returned an invalid response.');
        updatedCount = data;
      }
      setMerge(null);
      setNotice(`Merged “${merge.source.name}” into “${target.name}”; ${updatedCount} product${updatedCount === 1 ? '' : 's'} updated.`);
      await loadOverview();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const openPairForReview = (pair: SimilarNamePair<MasterValue>) => beginMerge(kind, pair.first, pair.second);
  const isUnitsTab = tab === 'units';
  const unitCount = overview?.summary.unit_count ?? 0;
  const canImportCurrentTab = isUnitsTab ? canManageUnits : canManage;
  const exportCount = isUnitsTab ? units.length : visibleItems.length;
  const changeTab = (nextTab: MasterDataTab) => {
    setTab(nextTab);
    setNotice('');
  };

  return <div className="space-y-3.5">
    <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-[26px] font-black leading-tight text-text">Categories &amp; master data</h1>
        <p className="mt-0.5 text-[13px] text-muted">Live category, manufacturer and medicine-unit records</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={importInputRef}
          type="file"
          accept=".csv,text/csv"
          aria-label={`Choose ${tab === 'brands' ? 'manufacturer' : tab === 'units' ? 'unit' : 'category'} CSV`}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importCsvFile(file, tab);
          }}
        />
        {canImportCurrentTab && <button
          type="button"
          className={SECONDARY}
          disabled={csvBusy || loading || (isUnitsTab && unitsLoading)}
          onClick={() => importInputRef.current?.click()}
        >
          <FileUp size={15} /> Import CSV
        </button>}
        <button type="button" className={SECONDARY} disabled={csvBusy} onClick={() => void downloadCsvTemplate()}>
          <Download size={15} /> CSV template
        </button>
        <button
          type="button"
          className={SECONDARY}
          disabled={csvBusy || exportCount === 0 || (isUnitsTab ? unitsLoading : loading)}
          onClick={() => void exportCsv()}
        >
          <Download size={15} /> Export CSV
        </button>
        {canManage && !isUnitsTab && <button type="button" className={BUTTON} onClick={() => openEditor(kind, null)}><Plus size={16} /> Add {kind === 'category' ? 'category' : 'manufacturer'}</button>}
      </div>
    </section>

    {!isUnitsTab && <section aria-label="Master data navigation, search and sort" className={`${PANEL} flex flex-wrap items-center gap-2 p-3`}>
      <nav aria-label="Master data sections" className="flex flex-wrap items-center gap-1">
        {([
          ['categories', `Categories${overview ? ` (${overview.summary.category_count})` : ''}`],
          ['brands', `Manufacturers${overview ? ` (${overview.summary.manufacturer_count})` : ''}`],
          ['units', `Units (${unitCount})`],
        ] as const).map(([value, label]) => (
          <button type="button" key={value} aria-pressed={tab === value} className={`rounded-full border px-3.5 py-2 text-[13px] font-bold transition-colors ${tab === value ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text hover:bg-primary/5'}`} onClick={() => changeTab(value)}>
            {label}
          </button>
        ))}
      </nav>
      <label className="relative ml-1 min-w-52 flex-1 sm:max-w-[340px]">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden="true" />
        <input className={`${FIELD} pl-9`} aria-label={`Search ${kind === 'category' ? 'categories' : 'manufacturers'}`} placeholder={`Search ${kind === 'category' ? 'categories' : 'manufacturers'}`} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-sm font-semibold text-text">
        <span className="sr-only">Sort</span>
        <select aria-label="Sort master data" className={`${FIELD} w-auto min-w-36`} value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
          <option value="name">Sort: A-Z</option><option value="products">Most products</option><option value="stock">Highest stock value</option>
        </select>
      </label>
      <button type="button" aria-label="Refresh master data" className={`${SECONDARY} ml-auto`} onClick={() => void loadOverview()} disabled={loading}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh</button>
    </section>}

    {isUnitsTab && <nav aria-label="Master data sections" className={`${PANEL} flex flex-wrap gap-2 p-2`}>
      <button type="button" aria-pressed={false} className={SECONDARY} onClick={() => changeTab('categories')}>Categories</button>
      <button type="button" aria-pressed={false} className={SECONDARY} onClick={() => changeTab('brands')}>Manufacturers</button>
      <button type="button" aria-pressed className={BUTTON}>Units ({unitCount})</button>
    </nav>}
    {isUnitsTab && <p className="text-xs text-muted">Units CSV rows link to existing medicines by product code. Leave unit_id blank to add a unit, or keep the exported ID to update one.</p>}

    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"><span>{error}</span><button type="button" className={SECONDARY} onClick={() => void loadOverview()} disabled={loading}>Retry</button></div>}
    {notice && <div role="status" className="rounded-control border border-border bg-surface px-4 py-3 text-sm text-text">{notice}</div>}
    {!isUnitsTab && !canManage && <p className="rounded-control border border-border bg-surface px-4 py-3 text-sm text-muted">You have read-only access to categories and manufacturers.</p>}
    {isUnitsTab && !canManageUnits && <p className="rounded-control border border-border bg-surface px-4 py-3 text-sm text-muted">Products permission is required to import medicine units.</p>}

    {!isUnitsTab && (
      <>
        {similarPairs.length > 0 && (
          <section aria-label="Similar names" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-warning/40 bg-warning/10 px-4 py-3 text-[13px]">
            <div className="flex items-center gap-2"><AlertCircle className="shrink-0 text-warning" size={17} /><h2 className="font-bold text-text">{similarPairs.length} similar name{similarPairs.length === 1 ? '' : 's'} found:</h2></div>
            <ul className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2">
              {similarPairs.map((pair) => <li key={`${pair.first.id}:${pair.second.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-text"><strong>{pair.first.name}</strong><span className="px-1 text-muted">↔</span><strong>{pair.second.name}</strong></span>
                {canManage && <button type="button" className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/5" onClick={() => openPairForReview(pair)}><Merge size={13} /> Review &amp; merge</button>}
              </li>)}
            </ul>
          </section>
        )}

        {loading ? <MasterGridSkeleton />
          : error ? null
            : visibleItems.length === 0 ? <section className={`${PANEL} flex min-h-52 flex-col items-center justify-center gap-2 p-8 text-center`}>
              <Layers className="text-muted" size={28} />
              <h2 className="font-bold text-text">{query ? 'No matching names' : `No ${kind === 'category' ? 'categories' : 'manufacturers'} yet`}</h2>
              <p className="max-w-md text-sm text-muted">{query ? 'Try a different search term.' : 'Add a real record to populate this view.'}</p>
              {!query && canManage && <button type="button" className={BUTTON} onClick={() => openEditor(kind, null)}><Plus size={16} /> Add {kind}</button>}
            </section>
            : <div className="overflow-x-auto rounded-card border border-border bg-white shadow-xs">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead className="border-b border-border bg-surface text-[10px] font-bold uppercase tracking-wider text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Products</th>
                      <th className="px-4 py-2.5">Stock Value</th>
                      <th className="px-4 py-2.5">Stock Health</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visibleItems.map((item) => {
                      const colorClass = colorForId(item.id);
                      return (
                        <tr key={item.id} className="transition-colors hover:bg-surface/50">
                          <td className="px-4 py-2.5 font-bold text-text">
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${colorClass}`} />
                              <span>{item.name}</span>
                              {!item.is_active && (
                                <span className="rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.2 text-[9px] font-semibold">
                                  Inactive
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 font-semibold text-text">
                            {item.product_count} {item.product_count === 1 ? 'product' : 'products'}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-medium text-text">
                            {item.stock_value_paisa === null ? '—' : formatMoney(item.stock_value_paisa)}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {item.out_count > 0 && (
                                <span className="rounded-full bg-rose-50 border border-rose-200 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                                  Out: {item.out_count}
                                </span>
                              )}
                              {item.low_count > 0 && (
                                <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                                  Low: {item.low_count}
                                </span>
                              )}
                              {item.expiring_count > 0 && (
                                <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                                  Exp 90d: {item.expiring_count}
                                </span>
                              )}
                              {item.out_count === 0 && item.low_count === 0 && item.expiring_count === 0 && (
                                <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                  Healthy
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              {canViewProducts && (
                                <button
                                  type="button"
                                  onClick={() => onViewProducts({ field: kind === 'category' ? 'category' : 'company', value: item.name })}
                                  className="rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-primary hover:bg-surface"
                                >
                                  View
                                </button>
                              )}
                              {canManage && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditor(kind, item)}
                                    className="rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-text hover:bg-surface"
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => beginMerge(kind, item)}
                                    className="rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-text hover:bg-surface"
                                  >
                                    Merge
                                  </button>
                                  <button
                                    type="button"
                                    disabled={item.product_count > 0}
                                    onClick={() => setPendingDelete({ kind, item })}
                                    className="rounded-control border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40"
                                    title={item.product_count > 0 ? 'Cannot delete with assigned products' : 'Delete'}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>}
      </>
    )}

    {isUnitsTab && (
      <section className="overflow-hidden">
        {unitsLoading ? <MasterGridSkeleton />
          : unitsError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-danger"><span>{unitsError}</span><button type="button" className={SECONDARY} onClick={() => void loadUnits()} disabled={unitsLoading}>Retry units</button></div>
            : units.length === 0 ? <div className="p-8 text-center rounded-card border border-border bg-white"><h2 className="font-bold text-text">No medicine units stored</h2><p className="mt-1 text-sm text-muted">Units will appear here when products have real unit records.</p></div>
              : <div className="overflow-x-auto rounded-card border border-border bg-white shadow-xs">
                  <table className="w-full min-w-[700px] text-left text-xs">
                    <thead className="border-b border-border bg-surface text-[10px] font-bold uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-4 py-2.5">Unit Name</th>
                        <th className="px-4 py-2.5">Medicine</th>
                        <th className="px-4 py-2.5">Base Factor</th>
                        <th className="px-4 py-2.5">Sale Price</th>
                        <th className="px-4 py-2.5">Barcode</th>
                        <th className="px-4 py-2.5 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {units.map((unit) => (
                        <tr key={unit.id} className="transition-colors hover:bg-surface/50">
                          <td className="px-4 py-2.5 font-bold text-text">{unit.name}</td>
                          <td className="px-4 py-2.5 text-muted">{unit.medicine_name}</td>
                          <td className="px-4 py-2.5 font-mono text-text">{unit.conversion_factor}</td>
                          <td className="px-4 py-2.5 font-mono font-bold text-text">{formatMoney(unit.price_paisa)}</td>
                          <td className="px-4 py-2.5 font-mono text-muted">{unit.barcode || '—'}</td>
                          <td className="px-4 py-2.5 text-right">
                            {unit.is_default_sale_unit ? (
                              <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                                Default Sale Unit
                              </span>
                            ) : (
                              <span className="text-muted text-[11px]">Secondary</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
      </section>
    )}

    {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby="master-edit-title" onSubmit={(event) => void save(event)} className={`${PANEL} w-full max-w-md space-y-4 p-5 shadow-xl`}>
        <div className="flex items-start justify-between"><div><h2 id="master-edit-title" className="text-lg font-black text-text">{editing.item ? 'Rename' : 'Add'} {editing.kind === 'category' ? 'category' : 'manufacturer'}</h2><p className="text-sm text-muted">Names are unique regardless of letter case.</p></div><button type="button" aria-label="Close editor" className={SECONDARY} onClick={() => setEditing(null)}><X size={16} /></button></div>
        <label className="block text-sm text-text">Name *<input className={`${FIELD} mt-1`} required maxLength={120} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Active for new products</label>
        {editing.item && editing.item.product_count > 0 && <p className="rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-text">This value is used by {editing.item.product_count} products. Renaming requires Products permission because it updates those product records.</p>}
        {notice && <p role="alert" className="rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{notice}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setEditing(null)}>Cancel</button><button type="submit" className={BUTTON} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
      </form>
    </div>}

    {merge && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="merge-title" className={`${PANEL} w-full max-w-lg space-y-4 p-5 shadow-xl`}>
        <div className="flex items-start justify-between gap-3"><div><h2 id="merge-title" className="text-lg font-black text-text">Merge {merge.kind === 'category' ? 'categories' : 'manufacturers'}</h2><p className="text-sm text-muted">Choose the name that will remain. Products assigned to the other name will be updated.</p></div><button type="button" className={SECONDARY} aria-label="Close merge dialog" onClick={() => setMerge(null)}><X size={16} /></button></div>
        <p className="rounded-control border border-warning/40 bg-warning/10 p-3 text-sm text-text"><strong>{merge.source.product_count}</strong> product{merge.source.product_count === 1 ? '' : 's'} will move from <strong>{merge.source.name}</strong> to the selected name.</p>
        <label className="block text-sm font-semibold text-text">Name to keep
          <select className={`${FIELD} mt-1`} autoFocus value={merge.targetId} onChange={(event) => setMerge({ ...merge, targetId: event.target.value })}>
            {(merge.kind === 'category' ? overview?.categories : overview?.manufacturers)?.filter((item) => item.id !== merge.source.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setMerge(null)}>Cancel</button><button type="button" className={BUTTON} disabled={saving || !merge.targetId} onClick={() => void performMerge()}><Merge size={15} />{saving ? 'Merging…' : 'Confirm merge'}</button></div>
      </section>
    </div>}

    {pendingDelete && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" className={`${PANEL} w-full max-w-md space-y-4 p-5 shadow-xl`}>
        <div><h2 id="delete-title" className="text-lg font-black text-text">Delete {pendingDelete.kind === 'category' ? 'category' : 'manufacturer'}?</h2><p id="delete-description" className="mt-2 text-sm text-muted">Delete “{pendingDelete.item.name}”? This action cannot be undone.</p></div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={SECONDARY} autoFocus onClick={() => setPendingDelete(null)}>Cancel</button><button type="button" className="inline-flex items-center gap-2 rounded-control border border-danger/30 px-3 py-2 text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-50" disabled={saving} onClick={() => void remove()}><Trash2 size={15} />{saving ? 'Deleting…' : 'Delete'}</button></div>
      </section>
    </div>}
  </div>;
}

function MasterGridSkeleton() {
  return <div aria-label="Loading master data" role="status" className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
    {Array.from({ length: 6 }, (_, index) => <div key={index} className={`${PANEL} h-56 animate-pulse bg-surface p-4`}><div className="h-4 w-2/3 rounded bg-border" /><div className="mt-5 h-3 w-1/2 rounded bg-border" /><div className="mt-7 h-8 w-full rounded bg-border" /><span className="sr-only">Loading master data</span></div>)}
  </div>;
}

function MasterDataCard({
  item,
  colorClass,
  canManage,
  canViewProducts,
  kind,
  onViewProducts,
  onRename,
  onMerge,
  onDelete,
}: {
  item: MasterValue;
  colorClass: string;
  canManage: boolean;
  canViewProducts: boolean;
  kind: MasterKind;
  onViewProducts: () => void;
  onRename: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const hasWarnings = item.low_count > 0 || item.expiring_count > 0 || item.out_count > 0;
  return <article className={`${PANEL} flex min-h-0 flex-col gap-3 p-4 transition-shadow hover:shadow-md`}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-3.5 w-3.5 shrink-0 rounded-full ${colorClass}`} aria-hidden="true" />
        <div className="min-w-0"><h2 className="truncate text-base font-bold text-text" title={item.name}>{item.name}</h2><span className="sr-only">{item.is_active ? 'Active' : 'Inactive'}</span></div>
      </div>
      {item.product_count === 0 && <StatChip tone="muted">Unused</StatChip>}
    </div>
    <p className="my-1 text-[26px] font-black leading-none text-text">{item.product_count.toLocaleString()}<span className="ml-1 text-xs font-semibold text-muted">products</span></p>
    {item.stock_value_paisa !== null && <p className="text-xs text-muted">Stock value <strong className="font-bold text-text">{formatMoney(item.stock_value_paisa)}</strong></p>}
    <div className="flex min-h-7 flex-wrap gap-2" aria-label={`${item.name} stock indicators`}>
      {item.low_count > 0 && <StatChip tone="warning">Low {item.low_count}</StatChip>}
      {item.expiring_count > 0 && <StatChip tone="warning">Expiring {item.expiring_count}</StatChip>}
      {item.out_count > 0 && <StatChip tone="danger">Out {item.out_count}</StatChip>}
      {!hasWarnings && <StatChip tone="ok"><Check size={13} /> OK</StatChip>}
    </div>
    <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs font-bold">
      {canViewProducts && <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={onViewProducts}><Tag size={13} /> View products</button>}
      {canManage && <>
        <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={onRename}><Edit2 size={13} /> Rename</button>
        <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={onMerge}><Merge size={13} /> Merge</button>
        {item.product_count === 0
          ? <button type="button" className="inline-flex items-center gap-1 text-danger hover:underline" onClick={onDelete}><Trash2 size={13} /> Delete</button>
          : <span className="inline-flex items-center" title={`Cannot delete while ${item.product_count} product(s) use this ${kind === 'category' ? 'category' : 'manufacturer'}.`}>
            <button type="button" className="inline-flex cursor-not-allowed items-center gap-1 text-muted opacity-70" disabled aria-describedby={`${kind}-delete-${item.id}`}><Trash2 size={13} /> Delete</button>
            <span id={`${kind}-delete-${item.id}`} className="sr-only">Delete is unavailable because {item.product_count} products use this value.</span>
          </span>}
      </>}
    </div>
    {canManage && item.product_count > 0 && <p className="text-xs text-muted">Delete unavailable while {item.product_count} products use this {kind === 'category' ? 'category' : 'manufacturer'}.</p>}
  </article>;
}
