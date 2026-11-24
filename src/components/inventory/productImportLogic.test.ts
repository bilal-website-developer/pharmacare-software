import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkProductImportRows,
  parseProductCsv,
  previewProductCsv,
} from './productImportLogic.ts';

const headers = 'code,barcode,brand_name,generic_name,category,company,unit_name,conversion_factor,price_paisa';

test('parses quoted commas, escaped quotes, and line numbers', () => {
  const rows = parseProductCsv(`${headers}\nP-1,,"Brand, Plus","Generic ""A""",Tablets,Maker,Box,10,1250`);
  assert.equal(rows[0].line, 2);
  assert.equal(rows[0].values.brand_name, 'Brand, Plus');
  assert.equal(rows[0].values.generic_name, 'Generic "A"');
});

test('allows an empty optional strength column', () => {
  const rows = parseProductCsv(`${headers},strength\nP-1,,Brand,Generic,Tablets,Maker,Box,10,500,`);
  const [preview] = previewProductCsv(rows, []);

  assert.deepEqual(preview.errors, []);

  const missingManufacturer = parseProductCsv(`${headers}\nP-2,,Brand,Generic,Tablets,,Box,10,500`);
  assert.match(previewProductCsv(missingManufacturer, [])[0].errors.join(' '), /manufacturer are required/);
});

test('validates optional opening stock as a complete future-dated batch', () => {
  const openingHeaders = `${headers},opening_stock_qty,opening_batch_number,opening_expiry_date,opening_cost_paisa`;
  const valid = parseProductCsv(`${openingHeaders}\nP-1,,Brand,Generic,Tablets,Maker,Box,10,500,5,DEMO-LOT,2027-12-31,250`);
  const incomplete = parseProductCsv(`${openingHeaders}\nP-2,,Other,Generic,Tablets,Maker,Box,10,500,5,,2027-12-31,250`);
  const expired = parseProductCsv(`${openingHeaders}\nP-3,,Third,Generic,Tablets,Maker,Box,10,500,5,OLD-LOT,2026-11-21,250`);
  const impossibleDate = parseProductCsv(`${openingHeaders}\nP-4,,Fourth,Generic,Tablets,Maker,Box,10,500,5,BAD-DATE,2027-02-31,250`);

  assert.deepEqual(previewProductCsv(valid, [], '2026-11-22')[0].errors, []);
  assert.match(previewProductCsv(incomplete, [], '2026-11-22')[0].errors.join(' '), /batch number is required/i);
  assert.match(previewProductCsv(expired, [], '2026-11-22')[0].errors.join(' '), /expiry must be a valid future date/i);
  assert.match(previewProductCsv(impossibleDate, [], '2026-11-22')[0].errors.join(' '), /expiry must be a valid future date/i);
});

test('rejects malformed CSV and missing required headers', () => {
  assert.throws(() => parseProductCsv(`${headers}\nP-1,"unfinished`), /unclosed quoted field/);
  assert.throws(() => parseProductCsv('code,brand_name\nP-1,Brand'), /missing the required "generic_name" column/);
});

test('parses and batches CSV files with more than 2000 products without dropping rows', () => {
  const csvRows = Array.from({ length: 2501 }, (_, index) =>
    `P-${index},,Brand ${index},Generic ${index},Tablets,Maker,Box,10,500`,
  );
  const rows = parseProductCsv(`${headers}\n${csvRows.join('\n')}`);
  const batches = chunkProductImportRows(rows);
  const preview = previewProductCsv(rows, []);

  assert.equal(rows.length, 2501);
  assert.equal(batches.length, 6);
  assert.ok(batches.every((batch) => batch.length <= 500));
  assert.deepEqual(batches.flat(), rows);
  assert.equal(preview.length, rows.length);
  assert.ok(preview.every((product) => product.errors.length === 0));
});

test('preview detects duplicate product codes across batch boundaries', () => {
  const rows = parseProductCsv([
    headers,
    'P-1,,Brand One,Generic One,Tablets,Maker,Box,10,500',
    'P-501,,Brand Two,Generic Two,Tablets,Maker,Box,10,500',
  ].join('\n'));
  rows[1].values.code = rows[0].values.code;

  assert.equal(previewProductCsv(rows, [])[0].errors.length, 0);
  assert.match(previewProductCsv(rows, [])[1].errors.join(' '), /duplicates/);
});

test('preview reports invalid numeric values and duplicate rows by name and manufacturer', () => {
  const rows = parseProductCsv([
    headers,
    'P-1,,Brand,Generic,Tablets,Maker,Box,10,500',
    'P-2,, brand ,Different generic,Tablets, maker ,Box,10,500',
    'P-2,,Brand  ,Generic,Tablets,Maker,Box,0,-1',
  ].join('\n'));
  const preview = previewProductCsv(rows, []);
  assert.equal(preview[0].errors.length, 0);
  assert.match(preview[1].errors.join(' '), /duplicates an existing product/);
  assert.match(preview[2].errors.join(' '), /Conversion factor/);
  assert.match(preview[2].errors.join(' '), /Price/);
});

test('preview identifies products by barcode first or the fallback name and manufacturer tuple', () => {
  const rows = parseProductCsv([
    headers,
    'P-1,,Other,Generic,Tablets,Maker,Box,10,500',
    'P-2,123,Other,Generic,Tablets,Maker,Box,10,500',
    'P-3,,Brand,Generic,Tablets,Maker,Box,10,500',
  ].join('\n'));
  const preview = previewProductCsv(rows, [
    { code: 'P-1', barcode: null, brand_name: 'Old', generic_name: 'Other', company: 'Maker' },
    { code: 'P-0', barcode: '123', brand_name: 'Old', generic_name: 'Other', company: 'Maker' },
    { code: 'P-0', barcode: null, brand_name: 'Brand', generic_name: 'Generic', company: 'Maker' },
  ]);
  assert.ok(!preview[0].errors.some((error) => error.includes('duplicates')));
  assert.ok(preview[1].errors.some((error) => error.includes('duplicates')));
  assert.ok(preview[2].errors.some((error) => error.includes('duplicates')));
});

test('strength differentiates fallback duplicates only when the incoming CSV includes strength', () => {
  const existing = [{
    code: 'P-1',
    barcode: null,
    brand_name: 'Brand',
    generic_name: 'Generic',
    company: 'Maker',
    strength: '500 mg',
  }];
  const withStrength = parseProductCsv(`${headers},strength\nP-2,,Brand,Other,Tablets,Maker,Box,10,500,250 mg`);
  const withoutStrength = parseProductCsv(`${headers}\nP-3,,Brand,Other,Tablets,Maker,Box,10,500`);

  assert.equal(previewProductCsv(withStrength, existing)[0].errors.length, 0);
  assert.match(previewProductCsv(withoutStrength, existing)[0].errors.join(' '), /duplicates/);
});
