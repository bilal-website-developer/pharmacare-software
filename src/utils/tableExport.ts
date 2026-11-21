export type ExportFormat = 'csv' | 'xlsx';
export type ExportValue = string | number | boolean | null | undefined;

export function createCsvContent(
  headers: readonly string[],
  rows: readonly (readonly ExportValue[])[],
): string {
  const cell = (value: ExportValue): string => {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}`;
}

export async function downloadTableExport(
  filename: string,
  sheetName: string,
  headers: readonly string[],
  rows: readonly (readonly ExportValue[])[],
  format: ExportFormat,
): Promise<void> {
  if (format === 'csv') {
    const blob = new Blob([createCsvContent(headers, rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  const XLSX = await import('@e965/xlsx');
  const worksheetData: ExportValue[][] = [
    [...headers],
    ...rows.map((row) => [...row]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}
