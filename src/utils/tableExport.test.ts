import assert from 'node:assert/strict';
import test from 'node:test';
import { createCsvContent } from './tableExport';

test('CSV export quotes delimiters, quotes, and embedded newlines', () => {
  const csv = createCsvContent(['Name', 'Notes'], [
    ['Tablet, 500mg', 'Contains "quoted" text\non two lines'],
  ]);
  assert.equal(
    csv,
    '\uFEFF"Name","Notes"\r\n"Tablet, 500mg","Contains ""quoted"" text\non two lines"',
  );
});
