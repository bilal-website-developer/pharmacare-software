import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMasterDataCsvFile,
  mergeMasterUnitImport,
  parseCsvBoolean,
  parseMasterDataCsv,
  type MasterDataCsvValue,
  type MasterUnitValue,
} from './masterDataCsv.ts';

const category: MasterDataCsvValue = {
  id: 'category-1',
  name: 'Cold Chain',
  is_active: true,
  product_count: 2,
  low_count: 0,
  out_count: 0,
  expiring_count: 1,
  stock_value_paisa: 2500,
};
const manufacturer: MasterDataCsvValue = {
  ...category,
  id: 'manufacturer-1',
  name: 'North Labs',
};
const units = [{
  id: 'unit-1',
  medicine_code: 'MED-1',
  name: 'Box',
  conversion_factor: 10,
  is_default_sale_unit: true,
  price_paisa: 1200,
  barcode: 'UNIT-1',
}];

test('CSV export contains only the currently selected master-data section', () => {
  const categories = createMasterDataCsvFile('categories', [category], [manufacturer], units);
  const manufacturers = createMasterDataCsvFile('brands', [category], [manufacturer], units);
  const medicineUnits = createMasterDataCsvFile('units', [category], [manufacturer], units);

  assert.equal(categories.filename, 'pharma-care-categories');
  assert.deepEqual(categories.rows[0][0], 'Cold Chain');
  assert.equal(manufacturers.filename, 'pharma-care-manufacturers');
  assert.deepEqual(manufacturers.rows[0][0], 'North Labs');
  assert.equal(medicineUnits.filename, 'pharma-care-units');
  assert.deepEqual(medicineUnits.headers, [
    'medicine_code', 'unit_id', 'unit_name', 'conversion_factor',
    'is_default_sale_unit', 'price_paisa', 'barcode',
  ]);
  assert.deepEqual(medicineUnits.rows[0], ['MED-1', 'unit-1', 'Box', 10, true, 1200, 'UNIT-1']);
});

test('CSV import parser validates tab-specific headers and quoted values', () => {
  const categories = parseMasterDataCsv('\uFEFFcategory_name,is_active\r\n"Cold, Chain",yes', 'categories');
  const unitRows = parseMasterDataCsv([
    'medicine_code,unit_id,unit_name,conversion_factor,is_default_sale_unit,price_paisa,barcode',
    'MED-1,unit-1,"Box, Large",10,true,1200,UNIT-1',
  ].join('\n'), 'units');

  assert.deepEqual(categories[0], {
    line: 2,
    values: { category_name: 'Cold, Chain', is_active: 'yes' },
  });
  assert.equal(unitRows[0].values.unit_name, 'Box, Large');
  assert.throws(() => parseMasterDataCsv('category_name\nmedicine', 'units'), /medicine_code/);
  assert.throws(() => parseMasterDataCsv('manufacturer_name\nNorth Labs', 'categories'), /category_name/);
  assert.equal(parseCsvBoolean('no'), false);
  assert.equal(parseCsvBoolean('', true), true);
  assert.throws(() => parseCsvBoolean('sometimes'), /true or false/);
});

test('unit CSV import appends and edits units while preserving exactly one default', () => {
  const existing: MasterUnitValue[] = [{
    id: 'unit-1',
    name: 'Box',
    conversion_factor: 10,
    is_default_sale_unit: true,
    price_paisa: 1200,
    barcode: 'UNIT-1',
  }];
  const appended = mergeMasterUnitImport(existing, [{
    name: 'Strip',
    conversionFactor: 5,
    pricePaisa: 650,
    barcode: null,
  }]);
  assert.equal(appended.length, 2);
  assert.equal(appended.find((unit) => unit.name === 'Box')?.is_default_sale_unit, true);

  const changedDefault = mergeMasterUnitImport(appended, [{
    unitId: 'unit-1',
    name: 'Box',
    conversionFactor: 10,
    isDefaultSaleUnit: false,
    pricePaisa: 1200,
    barcode: 'UNIT-1',
  }, {
    name: 'Strip',
    conversionFactor: 5,
    isDefaultSaleUnit: true,
    pricePaisa: 650,
    barcode: null,
  }]);
  assert.equal(changedDefault.filter((unit) => unit.is_default_sale_unit).length, 1);
  assert.equal(changedDefault.find((unit) => unit.name === 'Strip')?.is_default_sale_unit, true);
  assert.throws(() => mergeMasterUnitImport(existing, [
    { name: 'Pack', conversionFactor: 1, isDefaultSaleUnit: true, pricePaisa: 100, barcode: null },
    { name: 'Bottle', conversionFactor: 1, isDefaultSaleUnit: true, pricePaisa: 100, barcode: null },
  ]), /Only one unit/);
  assert.throws(() => mergeMasterUnitImport(existing, [{
    unitId: 'foreign-unit',
    name: 'Pack',
    conversionFactor: 1,
    pricePaisa: 100,
    barcode: null,
  }]), /does not belong/);
});
