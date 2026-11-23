import type { Analysis, Cell, Report, Settings, TaskStatus } from './domain';
import { dictionaries } from './i18n';
import { makeWorkbook } from './office-output';
import type { NewArtifact } from './office';
import type { ReportInput } from './report-input';

interface TaskDetail {
  title: string;
  owner: string;
  date: string;
  status: TaskStatus;
  rawStatus: string;
  confirmed: boolean;
  reason: string;
  sources: string;
}

interface IssueDetail {
  code: string;
  detail: string;
  sources: string;
  excerpt: string;
}

export interface ReportDetails { tasks: TaskDetail[]; issues: IssueDetail[] }

export interface SavedReport {
  report: Report;
  snapshot?: { input: ReportInput; details: ReportDetails };
  dataset?: { id: string; name: string; sourceIds: string[] };
  revision?: string;
  updatedAt?: string;
}

export function reportDetails(data: Analysis): ReportDetails {
  return {
    tasks: data.tasks.map(task => ({
      title: task.title, owner: task.owner, date: task.date, status: task.status, rawStatus: task.rawStatus,
      confirmed: Boolean(task.decision), reason: task.decision?.reason ?? '',
      sources: task.evidence.locations.map(location => location.file + ' · ' + location.at).join('\n').slice(0, 25000),
    })),
    issues: data.issues.map(issue => ({
      code: issue.code, detail: issue.detail,
      sources: issue.evidence?.locations.map(location => location.file + ' · ' + location.at).join('\n').slice(0, 25000) ?? '',
      excerpt: issue.evidence?.locations.map(location => location.excerpt).join('\n').slice(0, 25000) ?? '',
    })),
  };
}

export async function detailFile(settings: Settings, detail: ReportDetails): Promise<NewArtifact> {
  const language = dictionaries[settings.locale];
  const rows: Record<number, Cell>[] = [{
    1: language.task, 2: language.owner, 3: language.date, 4: language.state,
    5: language.confirmed, 6: language.decisionNote, 7: language.source, 8: language.rawValue,
  }];
  for (const task of detail.tasks) rows.push({
    1: task.title, 2: task.owner, 3: task.date, 4: language[task.status],
    5: task.confirmed ? language.confirmed : '', 6: task.reason, 7: task.sources, 8: task.rawStatus,
  });
  const review: Record<number, Cell>[] = [{ 1: language.reviewTitle, 2: language.reviewItem, 3: language.source, 4: language.excerpt }];
  for (const issue of detail.issues) review.push({
    1: language[issue.code as keyof typeof language] ?? issue.code, 2: issue.detail, 3: issue.sources, 4: issue.excerpt,
  });
  const extra = [{ name: language.review, rows: review, widths: [42, 44, 36, 62] }];
  const file = await makeWorkbook(language.taskTable, rows, { widths: [36, 17, 15, 19, 17, 34, 48, 23], extra });
  return {
    title: (settings.team.trim() || language.taskTable) + ' ' + language.detailLabel + ' ' + settings.from,
    kind: 'xlsx', file, detail: language.dataRows.replace('{{count}}', String(detail.tasks.length)),
  };
}

export function reportGroup(record: SavedReport) {
  if (record.snapshot) return 'report-' + record.report.id + '-' + (record.revision ?? 'initial');
}

export function archiveKey(record: SavedReport) {
  return record.revision ? record.report.id + '-' + record.revision : record.report.id;
}
