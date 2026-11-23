import { columnName, columns } from './domain';
import type { Cell, Loaded, Sheet } from './domain';

export interface SlideData {
  title: string;
  series: string;
  labels: string[];
  values: number[];
  source: string;
}

export interface ChartSelection {
  fileId: string;
  sheetName: string;
  header: number;
  from: number;
  to: number;
  label?: number;
  value?: number;
  title: string;
}

function numberCell(value: Cell | undefined) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = value?.trim().normalize('NFKC');
  if (!text || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return;
  const parsed = Number(text.replaceAll(',', ''));
  if (Number.isFinite(parsed)) return parsed;
}

export function chartSelection(fileId: string, sheet: Sheet, header = sheet.rows[0]?.number ?? 1): ChartSelection {
  const headerColumns = columns(sheet, header);
  const rows = sheet.rows.filter(row => row.number > header).slice(0, 6);
  const value = headerColumns.find(column => rows.length > 0 && rows.every(row => numberCell(row.cells[column.index]) !== undefined))?.index;
  const label = headerColumns.find(column => column.index !== value)?.index;
  return { fileId, sheetName: sheet.name, header, from: rows[0]?.number ?? header + 1,
    to: rows.at(-1)?.number ?? header + 1, label, value, title: '' };
}

export function chartData(source: Loaded | undefined, selection: ChartSelection | undefined): { data?: SlideData; error?: string; row?: number } {
  if (!selection || source?.parsed?.kind !== 'xlsx') return {};
  const { label, value, from, to, header } = selection;
  const sheet = source.parsed.sheets.find(sheet => sheet.name === selection.sheetName);
  const headerColumns = columns(sheet, header);
  const series = headerColumns.find(column => column.index === value)?.header;
  if (!sheet || !series || !label || !value || label === value || !headerColumns.some(column => column.index === label)) return { error: 'chartColumnsNeeded' };
  if (from <= header || from > to) return { error: 'chartRangeInvalid' };
  const rows = sheet.rows.filter(row => row.number >= from && row.number <= to);
  if (!rows.length || rows.length > 12) return { error: 'chartRangeInvalid' };
  const labels: string[] = [];
  const values: number[] = [];
  for (const row of rows) {
    const name = String(row.cells[label] ?? '').trim();
    const numeric = numberCell(row.cells[value]);
    if (!name || numeric === undefined) return { error: 'chartRowInvalid', row: row.number };
    labels.push(name);
    values.push(numeric);
  }
  const sourceLabel = source.material.relative + ' · ' + sheet.name + '!' + columnName(label) + from + ':' + columnName(value) + to;
  return { data: { title: selection.title.trim() || series, series, labels, values, source: sourceLabel } };
}
