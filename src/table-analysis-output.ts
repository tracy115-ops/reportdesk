import type { TFunction } from 'i18next';
import type { Cell, Evidence, Locale, Location } from './domain';
import { columnName } from './domain';
import type { NewArtifact, OfficeDraft } from './office';
import { makeSlides, makeWord, makeWorkbook } from './office-output';
import type { SlideData } from './slide-data';
import type { AggregateMethod, Metric, SummaryRow, TableAnalysisResult, TableAnalysisSpec, WorkbookSheet } from './table-analysis';

export const methodLabels: Record<AggregateMethod, string> = {
  sum: 'analysisSum', count: 'analysisCount', average: 'analysisAverage', min: 'analysisMin', max: 'analysisMax',
};

export function metricLabel(metric: Metric, columnLabel: (value: string) => string, t: TFunction) {
  const name = t(methodLabels[metric.method]);
  return metric.method === 'count' ? name : columnLabel(metric.column ?? '') + ' · ' + name;
}

export function detailLocation(row: SummaryRow, tables: WorkbookSheet[], text: string): Location {
  const table = tables[row.source]!;
  const original = table.sheet.rows.find(item => item.number === row.row);
  const first = Object.keys(original?.cells ?? {})[0] ?? '1';
  return { file: table.file, path: table.path, materialId: table.fileId, version: table.version,
    at: table.sheet.name + '!' + columnName(Number(first)) + row.row, excerpt: text };
}

export function analysisLabels(spec: TableAnalysisSpec, fields: { value: string; label: string }[], t: TFunction) {
  const label = (key: string) => fields.find(field => field.value === key)?.label ?? key;
  return { label, dimensions: spec.dimensions.length ? spec.dimensions.map(label) : [t('analysisGroup')],
    metrics: spec.metrics.map(metric => metricLabel(metric, label, t)) };
}

export function analysisEvidence(spec: TableAnalysisSpec, result: TableAnalysisResult, tables: WorkbookSheet[],
  fields: { value: string; label: string }[], t: TFunction): Evidence {
  const { metrics, label } = analysisLabels(spec, fields, t);
  const value = (values: (number | null)[]) => metrics.map((label, index) => label + ' = ' + (values[index] ?? '—')).join(' · ');
  const totals = t('analysisRows', { count: result.included }) + ' · ' + value(result.totals);
  const groups = result.groups.slice(0, 10).map(group => group.labels.map(label => label || t('analysisBlank')).join(' / ') + ' · ' + value(group.values));
  const text = [totals, ...conditions(spec, label), ...groups, ...(result.groups.length > 10 ? [t('analysisTopGroups', { count: 10, total: result.groups.length })] : [])].join('\n').slice(0, 1600);
  const seen = new Set<number>();
  const locations = result.rows.flatMap(row => {
    if (row.issue || seen.has(row.source)) return [];
    seen.add(row.source);
    return [detailLocation(row, tables, row.cells.join(' · '))];
  }).slice(0, 24);
  return { id: '', text, locations };
}

function conditions(spec: TableAnalysisSpec, label: (column: string) => string) {
  return [
    ...(spec.dateColumn ? [label(spec.dateColumn) + ' · ' + spec.from + ' – ' + spec.to] : []),
    ...(spec.filterColumn ? [label(spec.filterColumn) + ' = ' + spec.filterText] : []),
  ];
}

function cells(values: (Cell | null)[]) {
  return Object.fromEntries(values.flatMap((value, index) => value === null ? [] : [[index + 1, value]])) as Record<number, Cell>;
}

export async function exportAnalysis(kind: 'xlsx' | 'docx' | 'pptx', title: string, spec: TableAnalysisSpec, result: TableAnalysisResult,
  tables: WorkbookSheet[], fields: { value: string; label: string }[], t: TFunction, locale: Locale): Promise<NewArtifact> {
  const { label, dimensions, metrics } = analysisLabels(spec, fields, t);
  const metricText = (values: (number | null)[]) => metrics.map((name, index) => name + ' · ' + (values[index] ?? '—')).join(' / ');
  const detail = t('analysisRows', { count: result.included }) + ' · ' + metricText(result.totals);
  const groupName = (values: string[]) => values.length ? values.map(value => value || t('analysisBlank')).join(' / ') : t('analysisTotal');
  if (kind === 'xlsx') {
    const summary = [cells([...dimensions, ...metrics, t('analysisRecords')]), ...result.groups.map(group =>
      cells([...(group.labels.length ? group.labels.map(value => value || t('analysisBlank')) : [t('analysisTotal')]), ...group.values, group.rows]))];
    if (spec.dimensions.length) summary.push(cells([t('analysisTotal'), ...dimensions.slice(1).map(() => null), ...result.totals, result.included]));
    const details = [cells([t('source'), t('sheet'), t('analysisOriginalRow'), t('state'), ...result.columns.map(label), t('analysisSourcePath')]),
      ...result.rows.map(row => {
        const table = tables[row.source]!;
        return cells([table.file, table.sheet.name, row.row, t(row.issue ? 'analysisInvalidDate' : 'analysisIncluded'), ...row.cells, table.path]);
      })];
    const rules = [
      cells([t('analysisRule'), t('analysisValue')]),
      cells([t('analysisSheets'), tables.length]),
      cells([t('analysisRecords'), result.included]),
      cells([t('analysisExcluded'), result.filtered]),
      cells([t('analysisInvalidDate'), result.invalidDates]),
      ...metrics.map((name, index) => cells([name + ' · ' + t('analysisMissing'), result.missing[index] ?? 0])),
      ...(spec.dateColumn ? [cells([label(spec.dateColumn), spec.from + ' – ' + spec.to])] : []),
      ...(spec.filterColumn ? [cells([label(spec.filterColumn), spec.filterText])] : []),
      ...tables.map(table => cells([table.sheet.name + ' · ' + t('headerRow') + ' ' + (spec.headers[table.id] ?? table.header), table.path])),
    ];
    const file = await makeWorkbook(t('analysisSummarySheet'), summary, {
      widths: [...dimensions.map(() => 24), ...metrics.map(() => 23), 12],
      extra: [
        { name: t('analysisDetailsSheet'), rows: details, widths: [34, 20, 11, 16, ...result.columns.map(() => 20), 55] },
        { name: t('analysisRulesSheet'), rows: rules, widths: [37, 95] },
      ],
    });
    return { kind, title, file, detail };
  }

  const leading = result.groups.slice(0, 10);
  const draft: OfficeDraft = {
    title, sections: [
      { heading: t('analysisSummarySheet'), text: [detail, ...conditions(spec, label),
        t('analysisCoverage', { included: result.included, filtered: result.filtered, invalid: result.invalidDates })].join('\n') },
      ...(spec.dimensions.length ? [{ heading: t('analysisByGroup'), text: [
        ...leading.map(group => groupName(group.labels) + ' · ' + metricText(group.values)),
        ...(result.groups.length > leading.length ? [t('analysisTopGroups', { count: leading.length, total: result.groups.length })] : []),
      ].join('\n') }] : []),
    ],
  };
  if (kind === 'docx') return { kind, title, detail, file: await makeWord(draft, locale) };
  const chartGroups = leading.filter(group => group.values[0] !== null);
  const chart: SlideData | undefined = spec.dimensions.length && chartGroups.length ? {
    title: metrics[0]!, series: metrics[0]!, source: t('analysisTopGroups', { count: chartGroups.length, total: result.groups.length }),
    labels: chartGroups.map(group => groupName(group.labels).slice(0, 45)), values: chartGroups.map(group => group.values[0]!),
  } : undefined;
  return { kind, title, detail, file: await makeSlides(draft, [], locale, { theme: 'blue', chart }) };
}
