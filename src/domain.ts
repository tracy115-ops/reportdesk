import type { SlideVisual } from './slide-visual';
import type { SlideFinding } from './pptx-audit';

export type Locale = 'zh-CN' | 'en-US';
export type Cadence = 'weekly' | 'monthly';
export type NoteKind = 'progress' | 'risks' | 'next';
export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'html' | 'png' | 'mp3' | 'mp4';
export type MaterialKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv' | 'txt' | 'md';
export const isMedia = (kind: string): kind is 'png' | 'mp3' | 'mp4' => kind === 'png' || kind === 'mp3' || kind === 'mp4';
export const materialKinds: MaterialKind[] = ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'txt', 'md'];
export const supportedFiles = materialKinds.map(kind => `.${kind}`).join(',');
export type Cell = string | number;

export interface Source {
  id: string;
  path: string;
  name: string;
  directory: boolean;
  originalName?: string;
  sample?: boolean;
}

export interface Material {
  id: string;
  sourceId: string;
  relative: string;
  path: string;
  kind: MaterialKind;
  size: number;
  modified?: string | null;
}

export interface Sheet {
  name: string;
  rows: { number: number; cells: Record<number, Cell> }[];
}

export interface Note {
  paragraph: number;
  text: string;
  kind: NoteKind;
}

export interface ParagraphText { paragraph: number; text: string; heading?: boolean }
export interface PresentationPage { index: number; text: string; title?: string; notes?: string; visual?: SlideVisual }

export type Parsed = { kind: 'xlsx'; sheets: Sheet[] } | { kind: 'docx'; notes: Note[]; paragraphs: ParagraphText[] }
  | { kind: 'pptx'; pages: PresentationPage[]; pageCount: number; findings: SlideFinding[] }
  | { kind: 'pdf'; pages: { index: number; text: string }[]; pageCount: number };
export type Loaded = { material: Material; version?: string; sourceAliases?: string[] } & ({ parsed: Parsed; error?: never } | { parsed?: never; error: string });

export function fromSource(file: Loaded, sourceId: string) {
  return file.material.sourceId === sourceId || Boolean(file.sourceAliases?.includes(sourceId));
}

export interface Settings {
  team: string;
  cadence: Cadence;
  from: string;
  to: string;
  locale: Locale;
}

export interface Mapping {
  sheet: string;
  headerRow: number;
  date: number;
  status: number;
  id?: number;
  title?: number;
  owner?: number;
  namespace: string;
  done: string;
  open: string;
  dateOrder: 'ymd' | 'mdy' | 'dmy';
  signature: string;
}

export type MappingCheck =
  | { state: 'ready' | 'folderMapping' | 'autoMapping'; mapping: Mapping }
  | { state: 'mapping_changed' | 'mapping_needed' | 'folderMappingChanged' | 'folderMappingAmbiguous'; mapping?: undefined };

export type TaskStatus = 'done' | 'open' | 'unknown' | 'conflict';

export interface Location {
  file: string;
  path: string;
  at: string;
  version?: string;
  excerpt: string;
  materialId?: string;
}

export function isReportSource(kind: MaterialKind) { return kind !== 'pptx' && kind !== 'pdf'; }

export interface Evidence {
  id: string;
  text: string;
  locations: Location[];
}

export interface Issue {
  code: string;
  detail: string;
  evidence?: Evidence;
  sourceId?: string;
}

export interface Task {
  key: string;
  title: string;
  owner: string;
  date: string;
  status: TaskStatus;
  rawStatus: string;
  evidence: Evidence;
  decision?: ReviewDecision;
  dates: string[];
}

export interface ReviewDecision {
  status: 'done' | 'open';
  reason: string;
  signature: string;
  date?: string;
}

export function evidenceSignature(evidence: Evidence) {
  return JSON.stringify(evidence.locations.map(source => [source.materialId ?? source.path, source.version, source.at, source.excerpt]).sort());
}

export interface Metrics {
  total: number;
  done: number;
  open: number;
  unverified: number;
  documents: number;
}

export interface Analysis {
  tasks: Task[];
  notes: { kind: NoteKind; evidence: Evidence }[];
  issues: Issue[];
  usable: number;
  metrics: Metrics;
}

export type Narrative = Record<'summary' | NoteKind, string>;
export const sections = ['summary', 'progress', 'risks', 'next'] as const;

export interface Report {
  id: string;
  createdAt: string;
  settings: Settings;
  metrics: Metrics;
  narrative: Narrative;
  evidence: Evidence[];
  issues: Record<string, number>;
  sample: boolean;
  polished: boolean;
}

export function calendarDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function period(cadence: Cadence, now = new Date()): Pick<Settings, 'cadence' | 'from' | 'to'> {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (cadence === 'monthly') return { cadence, from: calendarDate(new Date(y, m, 1)), to: calendarDate(new Date(y, m + 1, 0)) };
  const monday = now.getDate() - (now.getDay() + 6) % 7;
  return { cadence, from: calendarDate(new Date(y, m, monday)), to: calendarDate(new Date(y, m, monday + 6)) };
}

export function quickPeriod(cadence: Cadence, previous: boolean, now = new Date()) {
  if (!previous) return period(cadence, now);
  const prior = cadence === 'monthly'
    ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  return period(cadence, prior);
}

export interface ReportProfile {
  id: string;
  name: string;
  settings: Pick<Settings, 'team' | 'cadence' | 'locale'>;
  sourceIds: string[];
  excluded: string[];
}

function normalized(value: string) {
  return value.normalize('NFKC').trim().toLowerCase();
}

function dateValue(y: number, m: number, d: number): string | undefined {
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() + 1 === m && date.getUTCDate() === d) return date.toISOString().slice(0, 10);
}

export function businessDate(value: Cell | undefined, order: Mapping['dateOrder']): string | undefined {
  const text = normalized(String(value ?? ''));
  const yearFirst = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]\d{1,2}:\d{2}.*)?$/i.exec(text);
  if (yearFirst) return dateValue(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return dateValue(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  if (order === 'ymd') return;
  const short = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (short) return dateValue(Number(short[3]), Number(short[order === 'mdy' ? 1 : 2]), Number(short[order === 'mdy' ? 2 : 1]));
}

export function columnName(column: number): string {
  let result = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

export function columns(sheet: Sheet | undefined, row: number) {
  return Object.entries(sheet?.rows.find(item => item.number === row)?.cells ?? {})
    .map(([index, header]) => ({ index: Number(index), header: String(header).trim() }))
    .filter(col => col.header !== '');
}

export function headerSignature(sheet: Sheet | undefined, row: number): string {
  return JSON.stringify(columns(sheet, row).map(col => [col.index, normalized(col.header)]));
}

const doneStates = '已完成, 完成, 已交付, 交付, done, completed, delivered';
const openStates = '进行中, 未完成, 未开始, 待处理, 待验证, 待测试, 延期, 阻塞, open, in progress, todo, pending, not started, blocked, in review, overdue';
const headers = {
  date: ['业务日期', '日期', '完成日期', '完成时间', '结束日期', '统计日期', '上报日期', 'date', 'business date', 'completed date', 'completed at', 'report date'],
  status: ['状态', '任务状态', '进展状态', '完成状态', '处理状态', 'status', 'task status', 'state'],
  id: ['编号', '任务编号', '任务id', '工单号', '事项编号', 'id', 'task id', 'ticket id', 'key'],
  title: ['任务', '任务名称', '事项', '事项名称', '标题', '名称', '名称/描述', 'task', 'task name', 'title', 'summary', 'item'],
  owner: ['负责人', '成员', '姓名', '责任人', '经办人', 'owner', 'assignee', 'member'],
};

export function newMapping(sheet: Sheet, headerRow: number): Mapping {
  const header = columns(sheet, headerRow);
  const find = (key: keyof typeof headers) => header.find(col => headers[key].includes(normalized(col.header)))?.index;
  return {
    sheet: sheet.name, headerRow, date: find('date') ?? 0, status: find('status') ?? 0,
    id: find('id'), title: find('title'), owner: find('owner'), namespace: '',
    done: doneStates, open: openStates, dateOrder: 'ymd', signature: headerSignature(sheet, headerRow),
  };
}

export function guessMapping(sheets: Sheet[]): Mapping | undefined {
  for (const sheet of sheets) {
    for (const row of sheet.rows.slice(0, 12)) {
      const candidate = newMapping(sheet, row.number);
      if (candidate.date && candidate.status) return candidate;
    }
  }
}

function statusSet(text: string) { return new Set(text.split(/[,，;；\n]/).map(normalized).filter(Boolean)); }

export function validMapping(mapping: Mapping, sheet: Sheet | undefined) {
  const available = new Set(columns(sheet, mapping.headerRow).map(col => col.index));
  const selected = [mapping.date, mapping.status, mapping.id, mapping.title, mapping.owner].filter((col): col is number => col !== undefined);
  const done = statusSet(mapping.done);
  const open = statusSet(mapping.open);
  return available.has(mapping.date) && available.has(mapping.status) && new Set(selected).size === selected.length
    && selected.every(col => available.has(col)) && done.size > 0 && open.size > 0 && [...done].every(state => !open.has(state));
}

export function currentMapping(sheets: Sheet[], saved?: Mapping): Mapping | undefined {
  if (!saved) return guessMapping(sheets);
  const sheet = sheets.find(item => item.name === saved.sheet);
  if (sheet && saved.signature === headerSignature(sheet, saved.headerRow) && validMapping(saved, sheet)) return saved;
}

function location(entry: Loaded, at: string, excerpt: string): Location {
  return { file: entry.material.relative, path: entry.material.path, at, excerpt, version: entry.version, materialId: entry.material.id };
}

interface RowFact {
  key: string;
  title: string;
  owner: string;
  date: string;
  status: Exclude<TaskStatus, 'conflict'>;
  rawStatus: string;
  location: Location;
}

export function analyze(settings: Settings, entries: Loaded[], mappings: ReadonlyMap<string, MappingCheck>, included: Set<string>, scanIssues: Issue[],
  decisions: Record<string, ReviewDecision> = {}): Analysis {
  const result: Analysis = { tasks: [], notes: [], issues: [...scanIssues], usable: 0, metrics: { total: 0, done: 0, open: 0, unverified: 0, documents: 0 } };
  const rows = new Map<string, RowFact[]>();
  for (const entry of entries) {
    const file = entry.material;
    if (!included.has(file.id) || !isReportSource(file.kind)) continue;
    if (!entry.parsed) {
      result.issues.push({ code: entry.error, detail: file.relative });
      continue;
    }
    if (entry.parsed.kind === 'docx') {
      result.usable++;
      result.metrics.documents++;
      for (const note of entry.parsed.notes) {
        const evidence = { id: `D${result.notes.length + 1}`, text: note.text, locations: [location(entry, `§ ${note.paragraph}`, note.text)] };
        result.notes.push({ kind: note.kind, evidence });
      }
      continue;
    }
    if (entry.parsed.kind !== 'xlsx') continue;
    const check = mappings.get(file.id);
    const mapping = check?.mapping;
    const sheet = entry.parsed.sheets.find(item => item.name === mapping?.sheet);
    if (!mapping || !sheet) {
      result.issues.push({ code: check?.state ?? 'mapping_needed', detail: file.relative });
      continue;
    }
    result.usable++;
    const done = statusSet(mapping.done);
    const open = statusSet(mapping.open);
    for (const row of sheet.rows) {
      if (row.number <= mapping.headerRow) continue;
      const get = (col?: number) => col === undefined ? '' : String(row.cells[col] ?? '').trim();
      const [id, title, owner, rawStatus, rawDate] = [get(mapping.id), get(mapping.title), get(mapping.owner), get(mapping.status), get(mapping.date)];
      if (![id, title, owner, rawStatus, rawDate].some(Boolean)) continue;
      const date = businessDate(rawDate, mapping.dateOrder);
      const selectedColumns = [...new Set([mapping.id, mapping.title, mapping.owner, mapping.date, mapping.status].filter((col): col is number => col !== undefined))].sort((a, b) => a - b);
      const excerpt = selectedColumns.map(col => `${columnName(col)}${row.number}  ${get(col)}`).join('  |  ');
      const at = `${sheet.name}!${selectedColumns.map(col => `${columnName(col)}${row.number}`).join(', ')}`;
      const source = location(entry, at, excerpt);
      if (!date) {
        result.issues.push({ code: 'invalid_date', detail: `${file.relative} · ${at}`, evidence: { id: '', text: excerpt, locations: [source] } });
        continue;
      }
      if (date < settings.from || date > settings.to) continue;
      const group = mapping.namespace.trim() ? `group:${normalized(mapping.namespace)}` : `file:${file.id}`;
      const key = id ? JSON.stringify([group, normalized(id)]) : JSON.stringify([file.id, sheet.name, row.number]);
      const state = normalized(rawStatus);
      const fact: RowFact = { key, title: title || id, owner, date, rawStatus, status: done.has(state) ? 'done' : open.has(state) ? 'open' : 'unknown', location: source };
      const previous = rows.get(key);
      if (previous) previous.push(fact);
      else rows.set(key, [fact]);
    }
  }
  for (const [key, facts] of rows) {
    const first = facts[0]!;
    const conflict = facts.some(fact => fact.status !== first.status || fact.date !== first.date
      || (fact.status === 'unknown' && normalized(fact.rawStatus) !== normalized(first.rawStatus)));
    const evidence = { id: `T${result.tasks.length + 1}`, text: first.title || first.location.excerpt, locations: facts.map(fact => fact.location) };
    const saved = decisions[key];
    const decision = saved?.signature === evidenceSignature(evidence) ? saved : undefined;
    const status = decision?.status ?? (conflict ? 'conflict' : first.status);
    const dates = [...new Set(facts.map(fact => fact.date))].sort();
    result.tasks.push({ key, title: first.title, owner: first.owner, date: decision?.date ?? first.date, status, rawStatus: first.rawStatus, evidence, decision, dates });
    if (saved && !decision) result.issues.push({ code: 'decisionChanged', detail: first.title || first.location.at, evidence });
    if (!decision && (conflict || status === 'unknown' || facts.length > 1)) {
      result.issues.push({ code: conflict ? 'task_conflict' : status === 'unknown' ? 'unknown_status' : 'duplicate_task', detail: first.title || first.location.at, evidence });
    }
    result.metrics.total++;
    if (status === 'done' || status === 'open') result.metrics[status]++;
    else result.metrics.unverified++;
  }
  return result;
}

export function reportTitle(settings: Settings) {
  const type = settings.locale === 'zh-CN'
    ? (settings.cadence === 'weekly' ? '周报' : '月报')
    : (settings.cadence === 'weekly' ? 'Weekly Report' : 'Monthly Report');
  return `${settings.team.trim()}${settings.locale === 'zh-CN' ? '' : ' · '}${type}`;
}

function firstInCategories(notes: Analysis['notes'], size: number) {
  return (['progress', 'risks', 'next'] as const).flatMap(kind => notes.filter(note => note.kind === kind).slice(0, size));
}

export function createReport(settings: Settings, data: Analysis, sample: boolean): Report {
  const zh = settings.locale === 'zh-CN';
  const m = data.metrics;
  const numbers = new Intl.NumberFormat(settings.locale);
  const base = settings.locale === 'zh-CN'
    ? `本期共有 ${numbers.format(m.total)} 条任务记录，其中已完成 ${numbers.format(m.done)} 条，未完成 ${numbers.format(m.open)} 条，待核对 ${numbers.format(m.unverified)} 条。选用文字材料 ${numbers.format(m.documents)} 份。`
    : `${numbers.format(m.total)} task ${m.total === 1 ? 'record' : 'records'} this period. ${numbers.format(m.done)} complete, ${numbers.format(m.open)} open, and ${numbers.format(m.unverified)} awaiting verification. ${numbers.format(m.documents)} text ${m.documents === 1 ? 'document' : 'documents'} included.`;
  const tasks = data.tasks.filter(task => task.status === 'done').slice(0, 8);
  const recentNotes = firstInCategories(data.notes, 8);
  const asLine = (item: Evidence) => `${item.text.slice(0, 420)} [${item.id}]`;
  const noteLines = (kind: NoteKind) => recentNotes.filter(note => note.kind === kind).map(note => asLine(note.evidence));
  const missing = zh ? '本期资料未提供相关内容。' : 'The selected materials did not report this information.';
  const progress = [...tasks.map(task => asLine(task.evidence)), ...noteLines('progress')];
  const issues: Record<string, number> = {};
  for (const issue of data.issues) issues[issue.code] = (issues[issue.code] ?? 0) + 1;
  const spotlight = [...recentNotes.map(note => note.evidence), ...tasks.map(task => task.evidence)];
  return {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), settings: { ...settings }, metrics: { ...m },
    narrative: { summary: base, progress: progress.join('\n') || missing, risks: noteLines('risks').join('\n') || missing, next: noteLines('next').join('\n') || missing },
    evidence: spotlight, issues, sample, polished: false,
  };
}

export function codexInput(report: Report, data: Analysis, instructions = '') {
  const excerpt = (text: string, size: number) => text.replace(/[\u0000-\u001f]/g, ' ').slice(0, size);
  const entries = firstInCategories(data.notes, 12).map(note => ({ kind: note.kind, evidence: note.evidence }));
  const tasks = (['done', 'open', 'conflict'] as const).flatMap(status => data.tasks.filter(task => task.status === status).slice(0, 12));
  const payload = JSON.stringify({
    instructions: excerpt(instructions.trim(), 1200),
    team: report.settings.team, period: [report.settings.from, report.settings.to], cadence: report.settings.cadence,
    metrics: report.metrics, reviewCounts: report.issues,
    tasks: tasks.map(task => ({ ref: task.evidence.id, title: excerpt(task.title, 140), date: task.date, status: task.status })),
    notes: entries.map(note => ({ ref: note.evidence.id, section: note.kind, text: excerpt(note.evidence.text, 220) })),
  });
  return { payload, evidence: [...tasks.map(task => task.evidence), ...entries.map(note => note.evidence)] };
}
