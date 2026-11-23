import { businessDate } from './domain';
import type { Cell, Loaded, Sheet } from './domain';

export const tableAnalysisKey = 'table-analysis';
export const aggregateMethods = ['sum', 'count', 'average', 'min', 'max'] as const;
export type AggregateMethod = typeof aggregateMethods[number];
export type Metric = { method: AggregateMethod; column?: string };
export interface TableAnalysisSpec {
  sheets: string[];
  headers: Record<string, number>;
  dimensions: string[];
  metrics: Metric[];
  dateColumn?: string;
  from: string;
  to: string;
  filterColumn?: string;
  filterText: string;
}

export interface WorkbookSheet {
  id: string;
  fileId: string;
  file: string;
  path: string;
  version?: string;
  sheet: Sheet;
  header: number;
}

export type SummaryGroup = { key: string; labels: string[]; rows: number; values: (number | null)[] };
export type SummaryRow = { group: string; source: number; row: number; cells: (Cell | null)[]; issue?: 'date' };
export interface TableAnalysisResult {
  groups: SummaryGroup[];
  totals: (number | null)[];
  rows: SummaryRow[];
  columns: string[];
  included: number;
  filtered: number;
  invalidDates: number;
  missing: number[];
}

const text = (value: unknown): value is string => typeof value === 'string';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const optionalText = (value: unknown) => value === undefined || text(value);
export const normalizeHeader = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export function emptyAnalysis(): TableAnalysisSpec {
  return { sheets: [], headers: {}, dimensions: [], metrics: [{ method: 'count' }], from: '', to: '', filterText: '' };
}

export function validTableAnalysis(value: unknown): value is TableAnalysisSpec {
  return object(value) && strings(value.sheets) && object(value.headers)
    && Object.values(value.headers).every(row => typeof row === 'number' && Number.isInteger(row) && row > 0 && row <= 1048576)
    && strings(value.dimensions) && value.dimensions.length <= 2
    && Array.isArray(value.metrics) && value.metrics.length >= 1 && value.metrics.length <= 3
    && value.metrics.every(metric => object(metric) && aggregateMethods.some(method => method === metric.method) && optionalText(metric.column))
    && optionalText(value.dateColumn) && optionalText(value.filterColumn) && text(value.from) && text(value.to) && text(value.filterText);
}

function probableHeader(sheet: Sheet) {
  const first = sheet.rows.find(row => Object.values(row.cells).filter(value => typeof value === 'string' && value.trim()).length >= 2);
  return first?.number ?? sheet.rows[0]?.number ?? 1;
}

export function workbookSheets(files: Loaded[]): WorkbookSheet[] {
  return files.flatMap(({ material, parsed, version }) => parsed?.kind === 'xlsx'
    ? parsed.sheets.filter(sheet => sheet.rows.length).map(sheet => ({
      id: JSON.stringify([material.id, sheet.name]), fileId: material.id, file: material.relative, path: material.path, version,
      sheet, header: probableHeader(sheet),
    })) : []);
}

function sheetColumns(table: WorkbookSheet, configuredHeader?: number) {
  const row = table.sheet.rows.find(row => row.number === (configuredHeader ?? table.header));
  const columns = new Map<string, { index: number; label: string }>();
  const duplicate = new Set<string>();
  for (const [index, cell] of Object.entries(row?.cells ?? {})) {
    const label = String(cell).trim();
    const name = normalizeHeader(label);
    if (!name || duplicate.has(name)) continue;
    if (columns.has(name)) {
      columns.delete(name);
      duplicate.add(name);
    } else columns.set(name, { index: Number(index), label });
  }
  return columns;
}

export function commonColumns(tables: WorkbookSheet[], headers: TableAnalysisSpec['headers']) {
  const [first, ...rest] = tables.map(table => sheetColumns(table, headers[table.id]));
  return first ? [...first].flatMap(([value, { label }]) => rest.every(map => map.has(value)) ? [{ value, label }] : []) : [];
}

export function validAnalysisFields(spec: TableAnalysisSpec, columns: { value: string }[]) {
  const names = new Set(columns.map(column => column.value));
  return spec.dimensions.every(column => names.has(column)) && spec.metrics.every(metric => metric.method === 'count' || Boolean(metric.column && names.has(metric.column)))
    && (!spec.dateColumn || names.has(spec.dateColumn) && Boolean(businessDate(spec.from, 'ymd') && businessDate(spec.to, 'ymd') && spec.from <= spec.to))
    && (!spec.filterColumn || names.has(spec.filterColumn) && Boolean(spec.filterText.trim()));
}

function amount(cell: Cell | null) {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  let raw = cell?.normalize('NFKC').trim() ?? '';
  if (/^\(.+\)$/.test(raw)) raw = '-' + raw.slice(1, -1);
  const percent = raw.endsWith('%');
  if (percent) raw = raw.slice(0, -1).trim();
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return;
  const value = Number(raw.replaceAll(',', '')) / (percent ? 100 : 1);
  return Number.isFinite(value) ? value : undefined;
}

type Accumulator = { count: number; sum: number; correction: number; min: number; max: number };
const blank = (): Accumulator => ({ count: 0, sum: 0, correction: 0, min: Infinity, max: -Infinity });

function accumulate(entry: Accumulator, value: number) {
  entry.count++;
  const next = entry.sum + value;
  entry.correction += Math.abs(entry.sum) >= Math.abs(value) ? (entry.sum - next) + value : (value - next) + entry.sum;
  entry.sum = next;
  entry.min = Math.min(entry.min, value);
  entry.max = Math.max(entry.max, value);
}

function calculated(entry: Accumulator, method: AggregateMethod) {
  if (method === 'count') return entry.count;
  if (!entry.count) return null;
  if (method === 'min') return entry.min;
  if (method === 'max') return entry.max;
  const sum = entry.sum + entry.correction;
  if (!Number.isFinite(sum)) throw Error('analysis_numeric_limit');
  return method === 'average' ? sum / entry.count : sum;
}

export function analyzeTables(spec: TableAnalysisSpec, tables: WorkbookSheet[]): TableAnalysisResult {
  const common = commonColumns(tables, spec.headers);
  if (!tables.length || !validAnalysisFields(spec, common)) throw Error('analysis_columns_changed');
  const columns = [...new Set([...spec.dimensions, ...spec.metrics.flatMap(metric => metric.method !== 'count' && metric.column ? [metric.column] : []),
    ...(spec.dateColumn ? [spec.dateColumn] : []), ...(spec.filterColumn ? [spec.filterColumn] : [])])];
  const index = new Map(columns.map((column, position) => [column, position]));
  const rows: SummaryRow[] = [];
  const groups = new Map<string, { key: string; labels: string[]; rows: number; accumulators: Accumulator[] }>();
  const totals = spec.metrics.map(blank);
  const missing = spec.metrics.map(() => 0);
  let included = 0;
  let filtered = 0;
  let invalidDates = 0;
  const filter = normalizeHeader(spec.filterText);

  for (const [source, table] of tables.entries()) {
    const header = spec.headers[table.id] ?? table.header;
    const map = sheetColumns(table, header);
    const positions = columns.map(column => map.get(column)!.index);
    for (const record of table.sheet.rows) {
      if (record.number <= header) continue;
      const cells = positions.map(column => record.cells[column] ?? null);
      const field = (column: string) => cells[index.get(column)!] ?? undefined;
      if (spec.dateColumn) {
        const date = businessDate(field(spec.dateColumn), 'ymd');
        if (!date) {
          invalidDates++;
          rows.push({ group: '', source, row: record.number, cells, issue: 'date' });
          continue;
        }
        if (date < spec.from || date > spec.to) { filtered++; continue; }
      }
      if (spec.filterColumn && normalizeHeader(String(field(spec.filterColumn) ?? '')) !== filter) { filtered++; continue; }
      const labels = spec.dimensions.map(column => String(field(column) ?? '').normalize('NFKC').trim());
      const key = JSON.stringify(labels);
      let group = groups.get(key);
      if (!group) {
        group = { key, labels, rows: 0, accumulators: spec.metrics.map(blank) };
        groups.set(key, group);
      }
      included++;
      group.rows++;
      rows.push({ group: key, source, row: record.number, cells });
      spec.metrics.forEach((metric, position) => {
        const value = metric.method === 'count' ? 1 : amount(field(metric.column!) ?? null);
        if (value === undefined) { missing[position] = (missing[position] ?? 0) + 1; return; }
        accumulate(group.accumulators[position]!, value);
        accumulate(totals[position]!, value);
      });
    }
  }
  const out = [...groups.values()].map(({ key, labels, rows, accumulators }) => ({
    key, labels, rows, values: spec.metrics.map(({ method }, index) => calculated(accumulators[index]!, method)),
  }));
  out.sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity) || a.labels.join(' ').localeCompare(b.labels.join(' ')));
  return { groups: out, totals: spec.metrics.map(({ method }, index) => calculated(totals[index]!, method)), rows, columns, included, filtered, invalidDates, missing };
}
