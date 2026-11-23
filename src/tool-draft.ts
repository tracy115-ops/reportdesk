import type { Locale } from './domain';
import type { SlideTheme } from './office-output';
import type { ChartSelection } from './slide-data';
import { readLocal } from './storage';

export type ToolKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'audit';
export type ToolIntake = { kind: 'docx' | 'pdf' | 'xlsx' | 'audit' | 'chart'; ids: string[]; append?: boolean };
export interface ToolDraft {
  kind: ToolKind;
  titles: Partial<Record<ToolKind, string>>;
  body: string;
  outline: string;
  locale: Locale;
  tableId?: string;
  sheetName: string;
  header: number;
  dedupe: boolean;
  pdfIds: string[];
  pages: string;
  theme: SlideTheme;
  chartEnabled: boolean;
  chartSelection?: ChartSelection;
  auditId?: string;
}

const string = (value: unknown): value is string => typeof value === 'string';
const worksheetIndex = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_048_576;

export function validToolDraft(value: unknown): value is ToolDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ToolDraft>;
  if (!draft.kind || !['docx', 'xlsx', 'pptx', 'audit', 'pdf'].includes(draft.kind)
    || !draft.titles || Array.isArray(draft.titles) || typeof draft.titles !== 'object' || !Object.values(draft.titles).every(string)) return false;
  const chart = draft.chartSelection;
  return [draft.body, draft.outline, draft.sheetName, draft.pages].every(string)
    && (draft.locale === 'zh-CN' || draft.locale === 'en-US') && worksheetIndex(draft.header)
    && typeof draft.dedupe === 'boolean' && typeof draft.chartEnabled === 'boolean' && Array.isArray(draft.pdfIds) && draft.pdfIds.every(string)
    && ['forest', 'blue', 'ink'].includes(String(draft.theme)) && [draft.tableId, draft.auditId].every(id => id === undefined || string(id))
    && (chart === undefined || Boolean(chart && [chart.fileId, chart.sheetName, chart.title].every(string)
      && [chart.header, chart.from, chart.to].every(worksheetIndex) && [chart.label, chart.value].every(col => col === undefined || worksheetIndex(col))));
}

export function readToolDraft(locale: Locale): ToolDraft {
  const saved = readLocal<unknown>('tool-draft', null);
  if (validToolDraft(saved)) return saved;
  return { kind: 'docx', titles: {}, body: '', outline: '', locale, sheetName: '', header: 1, dedupe: true,
    pdfIds: [], pages: '', theme: 'forest', chartEnabled: false };
}
