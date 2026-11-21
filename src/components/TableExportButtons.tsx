import React, { useState } from 'react';
import { Download } from 'lucide-react';
import {
  downloadTableExport,
  type ExportFormat,
  type ExportValue,
} from '../utils/tableExport';

export function TableExportButtons({
  filename,
  sheetName,
  headers,
  rows,
}: {
  filename: string;
  sheetName: string;
  headers: readonly string[];
  rows: readonly (readonly ExportValue[])[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const exportAs = async (format: ExportFormat) => {
    setBusy(true);
    setError('');
    try {
      await downloadTableExport(filename, sheetName, headers, rows, format);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not export these records.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" disabled={busy || rows.length === 0} onClick={() => void exportAs('csv')} className="inline-flex items-center gap-1 rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-text disabled:opacity-50">
        <Download size={12} /> CSV
      </button>
      <button type="button" disabled={busy || rows.length === 0} onClick={() => void exportAs('xlsx')} className="inline-flex items-center gap-1 rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-text disabled:opacity-50">
        <Download size={12} /> XLSX
      </button>
      {error && <span role="alert" className="basis-full text-[11px] text-danger">{error}</span>}
    </div>
  );
}
