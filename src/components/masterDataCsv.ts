import { parseCsvRows } from '../utils/csv';
import type { ExportValue } from '../utils/tableExport';

export type MasterDataTab = 'categories' | 'brands' | 'units';

export interface MasterDataCsvValue {
  id: string;
  name: string;
  is_active: boolean;
  product_count: number;
  low_count: number;
  out_count: number;
  expiring_count: number;
  stock_value_paisa: number | null;
}

export interface MasterDataCsvUnit {
  id: string;
  medicine_code: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
}

export interface MasterDataCsvFile {
  filename: string;
  sheetName: string;
  headers: string[];
  rows: ExportValue[][];
}

export interface MasterDataImportRow {
  line: number;
  values: Record<string, string>;
}

export interface MasterUnitValue {
  id?: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
}

export interface MasterUnitImportValue {
  unitId?: string;
  name: string;
  conversionFactor: number;
  isDefaultSaleUnit?: boolean;
  pricePaisa: number;
  barcode: string | null;
}

export const MASTER_DATA_IMPORT_HEADERS: Record<MasterDataTab, string[]> = {
  categories: ['category_name', 'is_active'],
  brands: ['manufacturer_name', 'is_active'],
  units: ['medicine_code', 'unit_id', 'unit_name', 'conversion_factor', 'is_default_sale_unit', 'price_paisa', 'barcode'],
};

export function createMasterDataCsvFile(
  tab: MasterDataTab,
  categories: readonly MasterDataCsvValue[],
  manufacturers: readonly MasterDataCsvValue[],
  units: readonly MasterDataCsvUnit[],
): MasterDataCsvFile {
  if (tab === 'units') {
    return {
      filename: 'pharma-care-units',
      sheetName: 'Units',
      headers: ['medicine_code', 'unit_id', 'unit_name', 'conversion_factor', 'is_default_sale_unit', 'price_paisa', 'barcode'],
      rows: units.map((unit) => [
        unit.medicine_code,
        unit.id,
        unit.name,
        unit.conversion_factor,
        unit.is_default_sale_unit,
        unit.price_paisa,
        unit.barcode,
      ]),
    };
  }

  const isCategories = tab === 'categories';
  const values = isCategories ? categories : manufacturers;
  return {
    filename: `pharma-care-${isCategories ? 'categories' : 'manufacturers'}`,
    sheetName: isCategories ? 'Categories' : 'Manufacturers',
    headers: [
      isCategories ? 'category_name' : 'manufacturer_name',
      'is_active',
      'product_count',
      'stock_value_paisa',
      'low_count',
      'out_count',
      'expiring_count',
    ],
    rows: values.map((value) => [
      value.name,
      value.is_active,
      value.product_count,
      value.stock_value_paisa,
      value.low_count,
      value.out_count,
      value.expiring_count,
    ]),
  };
}

export function parseMasterDataCsv(text: string, tab: MasterDataTab): MasterDataImportRow[] {
  const csvRows = parseCsvRows(text);
  if (csvRows.length < 2) throw new Error('The CSV file must include headers and at least one data row.');

  const headers = csvRows[0].map((header) => header.trim().replace(/^\uFEFF/, '').toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('The CSV file contains duplicate column names.');
  const requiredHeaders = tab === 'units'
    ? ['medicine_code', 'unit_name', 'conversion_factor', 'price_paisa']
    : [tab === 'categories' ? 'category_name' : 'manufacturer_name'];
  const missingHeader = requiredHeaders.find((header) => !headers.includes(header));
  if (missingHeader) throw new Error(`CSV is missing the required "${missingHeader}" column.`);

  return csvRows.slice(1).map((values, index) => ({
    line: index + 2,
    values: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ''])),
  }));
}

export function parseCsvBoolean(value: string, fallback?: boolean): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', 't', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'f', 'no', 'n', '0'].includes(normalized)) return false;
  throw new Error('Use true or false for boolean CSV fields.');
}

function normalizedName(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function mergeMasterUnitImport(
  existing: readonly MasterUnitValue[],
  incoming: readonly MasterUnitImportValue[],
): MasterUnitValue[] {
  if (incoming.length === 0) return [...existing];

  const next = existing.map((unit) => ({ ...unit }));
  const seenIncomingNames = new Set<string>();
  const seenIncomingIds = new Set<string>();
  const existingDefaultIds = existing.filter((unit) => unit.is_default_sale_unit)
    .map((unit) => unit.id).filter((id): id is string => Boolean(id));
  const requestedDefaults = incoming.filter((unit) => unit.isDefaultSaleUnit === true);
  if (requestedDefaults.length > 1) throw new Error('Only one unit per medicine can be the default sale unit.');
  if (existingDefaultIds.length > 1 && requestedDefaults.length === 0) {
    throw new Error('This medicine has multiple default units; mark exactly one CSV row as the default.');
  }

  for (const unit of incoming) {
    const nameKey = normalizedName(unit.name);
    if (!nameKey || seenIncomingNames.has(nameKey)) {
      throw new Error('The CSV contains duplicate or empty unit names for this medicine.');
    }
    seenIncomingNames.add(nameKey);

    if (unit.unitId) {
      if (seenIncomingIds.has(unit.unitId)) throw new Error('The CSV contains a duplicate unit ID.');
      seenIncomingIds.add(unit.unitId);
    }

    const idMatch = unit.unitId ? next.findIndex((value) => value.id === unit.unitId) : -1;
    if (unit.unitId && idMatch < 0) throw new Error(`Unit ID for "${unit.name}" does not belong to this medicine.`);
    const nameMatches = next
      .map((value, index) => normalizedName(value.name) === nameKey ? index : -1)
      .filter((index) => index >= 0);
    if (idMatch < 0 && nameMatches.length > 1) throw new Error(`Existing unit name "${unit.name}" is ambiguous.`);
    const matchIndex = idMatch >= 0 ? idMatch : nameMatches[0] ?? -1;
    const value: MasterUnitValue = {
      ...(matchIndex >= 0 && next[matchIndex].id ? { id: next[matchIndex].id } : {}),
      name: unit.name.trim(),
      conversion_factor: unit.conversionFactor,
      is_default_sale_unit: unit.isDefaultSaleUnit ?? (matchIndex >= 0 && next[matchIndex].is_default_sale_unit),
      price_paisa: unit.pricePaisa,
      barcode: unit.barcode,
    };
    if (matchIndex >= 0) next[matchIndex] = value;
    else next.push(value);
  }

  const duplicateNames = new Set<string>();
  for (const unit of next) {
    const name = normalizedName(unit.name);
    if (!name || duplicateNames.has(name)) throw new Error(`Unit name "${unit.name}" is duplicated for this medicine.`);
    duplicateNames.add(name);
  }

  let defaultUnit: MasterUnitValue | undefined;
  if (requestedDefaults.length === 1) {
    defaultUnit = next.find((unit) => normalizedName(unit.name) === normalizedName(requestedDefaults[0].name));
  } else {
    const existingDefault = existing.find((unit) => unit.is_default_sale_unit);
    const defaultWasDisabled = existingDefault && incoming.some((unit) =>
      unit.isDefaultSaleUnit === false
      && ((unit.unitId && unit.unitId === existingDefault.id)
        || normalizedName(unit.name) === normalizedName(existingDefault.name)));
    if (defaultWasDisabled) {
      throw new Error('Choose a replacement default sale unit before clearing the current default.');
    }
    defaultUnit = existingDefault
      ? next.find((unit) => unit.id === existingDefault.id)
      : next[0];
  }
  if (!defaultUnit) throw new Error('Choose exactly one default sale unit for this medicine.');
  return next.map((unit) => ({ ...unit, is_default_sale_unit: unit === defaultUnit }));
}
