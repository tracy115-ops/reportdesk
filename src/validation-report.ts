import type { TFunction } from 'i18next';
import type { BrowserQualityReport } from './EmbeddedBrowser';
import type { Cell } from './domain';
import type { NewArtifact } from './office';
import { makeWorkbook } from './office-output';

export interface MiniIssue { code: string; file: string; detail?: string }
export interface MiniReport { path: string; pages: number; issues: MiniIssue[] }
export type ValidationReport = { kind: 'web'; report: BrowserQualityReport }
  | { kind: 'mini'; report: MiniReport; checkedAt: number };

export function reportAddress(address: string) {
  const url = new URL(address);
  const path = url.pathname.replace(/^\/[0-9a-f]{32}(?=\/)/i, '');
  return url.origin + (path || '/');
}

export async function validationWorkbook(value: ValidationReport, t: TFunction): Promise<NewArtifact> {
  const web = value.kind === 'web';
  const report = value.report;
  const title = t(web ? 'validation_web_title' : 'validation_mini_title');
  const count = report.issues.length;
  const summary: Record<number, Cell>[] = [
    { 1: t('validation_field'), 2: t('validation_value') },
    { 1: t('validation_report'), 2: title },
    { 1: t('validation_target'), 2: web ? reportAddress(value.report.url) : value.report.path },
    { 1: t('validation_time'), 2: new Date(web ? value.report.checkedAt : value.checkedAt).toISOString() },
    { 1: t(web ? 'validation_checks' : 'validation_issue_count'), 2: count },
  ];
  if (web) {
    summary.push({ 1: t('validation_viewport'), 2: `${value.report.width} × ${value.report.height}` });
    summary.push({ 1: t('validation_scope'), 2: t('validation_web_scope') });
    if (value.report.truncated) summary.push({ 1: t('validation_report'), 2: t('validation_truncated') });
  } else {
    summary.push({ 1: t('validation_pages'), 2: value.report.pages });
    summary.push({ 1: t('validation_scope'), 2: t('validation_mini_scope') });
  }

  const details = value.kind === 'web'
    ? [
      { 1: t('validation_code'), 2: t('mini_program_diagnostic'), 3: t('validation_count'), 4: t('validation_examples') },
      ...value.report.issues.map(issue => ({ 1: issue.code, 2: t('validation_' + issue.code), 3: issue.count, 4: issue.examples.join('\n') })),
    ]
    : [
      { 1: t('validation_code'), 2: t('mini_program_diagnostic'), 3: t('source'), 4: t('validation_examples') },
      ...value.report.issues.map(issue => ({ 1: issue.code, 2: t(issue.code, { defaultValue: issue.code }), 3: issue.file, 4: issue.detail ?? '' })),
    ];
  const detail = t(web ? 'validation_web_summary' : 'mini_program_check_result', { issues: count, pages: web ? 0 : value.report.pages });
  const file = await makeWorkbook(t('validation_summary_sheet'), summary, {
    widths: [26, 75],
    extra: [{ name: t('validation_details_sheet'), rows: details, widths: [31, 41, web ? 16 : 44, 56] }],
  });
  return { title, kind: 'xlsx', file, detail };
}
