import { CalculatorOutlined, CloseOutlined, DownloadOutlined, FileExcelOutlined, FolderOpenOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, DatePicker, Drawer, Input, InputNumber, Pagination, Select, Tag } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode } from './desktop';
import type { Evidence, Loaded, Locale, Location } from './domain';
import type { Artifact, NewArtifact } from './office';
import { readLocal, writeLocal } from './storage';
import { aggregateMethods, commonColumns, emptyAnalysis, tableAnalysisKey, validAnalysisFields, validTableAnalysis, workbookSheets } from './table-analysis';
import type { Metric, TableAnalysisResult, TableAnalysisSpec, WorkbookSheet } from './table-analysis';
import { analysisEvidence, analysisLabels, detailLocation, exportAnalysis, methodLabels } from './table-analysis-output';
import type { CreativeIntake } from './creative-project';

interface Props {
  files: Loaded[];
  incoming?: { ids: string[]; replace: boolean };
  finishImport: () => void;
  busy: boolean;
  locked: boolean;
  pick: (folder: boolean) => void;
  refresh: () => void;
  setBusy: (busy: boolean) => void;
  locate: (location: Location) => void;
  writeReport: (evidence: Evidence) => void;
  deliver: (files: NewArtifact[], group: string) => Promise<Artifact[]>;
  save: (file: Artifact) => Promise<void>;
  savePack: (title: string, files: Artifact[]) => Promise<void>;
  compose: (intake: CreativeIntake) => void;
}

function calculate(spec: TableAnalysisSpec, tables: WorkbookSheet[]) {
  return new Promise<TableAnalysisResult>((resolve, reject) => {
    const worker = new Worker(new URL('./table-analysis.worker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject('analysis_timeout');
    }, 45000);
    function finish() {
      window.clearTimeout(timer);
      worker.terminate();
    }
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(data.error);
      else resolve(data.result);
    };
    worker.onerror = () => { finish(); reject('analysis_failed'); };
    try { worker.postMessage({ spec, tables }); }
    catch (error) { finish(); reject(error); }
  });
}

export default function TableAnalysis({ files, incoming, finishImport, busy, locked, pick, refresh, setBusy, locate, writeReport, deliver, save, savePack, compose }: Props) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [spec, setSpec] = useState(() => {
    const value = readLocal<unknown>(tableAnalysisKey, null);
    return validTableAnalysis(value) ? value : emptyAnalysis();
  });
  const [result, setResult] = useState<{ key: string; data: TableAnalysisResult }>();
  const [headerOpen, setHeaderOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(Boolean(spec.dateColumn || spec.filterColumn));
  const [settingOpen, setSettingOpen] = useState(true);
  const [detailKey, setDetailKey] = useState<string>();
  const [groupPage, setGroupPage] = useState(1);
  const [detailPage, setDetailPage] = useState(1);
  const [job, setJob] = useState<'compute' | 'xlsx' | 'pack'>();
  const [problem, setProblem] = useState<string>();
  const all = useMemo(() => workbookSheets(files), [files]);
  const byId = useMemo(() => new Map(all.map(table => [table.id, table])), [all]);
  const selected = useMemo(() => spec.sheets.flatMap(id => byId.get(id) ?? []), [spec.sheets, byId]);
  const fields = useMemo(() => commonColumns(selected, spec.headers), [selected, spec.headers]);
  const title = t('analysisExportTitle');
  const key = JSON.stringify([spec, selected.map(table => [table.id, table.version])]);
  const active = result?.key === key ? result.data : undefined;
  const missing = spec.sheets.length - selected.length;
  const ready = selected.length > 0 && !missing && validAnalysisFields(spec, fields);
  const disabled = locked || Boolean(job);
  const labels = analysisLabels(spec, fields, t);
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 });
  const format = (value: number | null) => value === null ? '—' : number.format(value);
  const activeGroup = active?.groups.find(group => group.key === detailKey);
  const details = useMemo(() => active?.rows.filter(row => detailKey === 'dates' ? row.issue === 'date' : row.group === detailKey) ?? [], [active, detailKey]);
  const groupSize = 12;
  const detailSize = 16;
  const displayGroup = (group: { labels: string[] }) => group.labels.length ? group.labels.map(label => label || t('analysisBlank')).join(' / ') : t('analysisTotal');

  function update(patch: Partial<TableAnalysisSpec>) {
    const next = { ...spec, ...patch };
    try { writeLocal(tableAnalysisKey, next); setSpec(next); setProblem(undefined); }
    catch { message.error(t('storage_error')); }
  }

  useEffect(() => {
    if (!incoming || busy || job) return;
    const ids = new Set(incoming.ids);
    const sheets = all.filter(table => ids.has(table.fileId)).map(table => table.id);
    if (sheets.length) {
      if (!incoming.replace) update({ sheets: [...new Set([...spec.sheets, ...sheets])] });
      else if (sheets.length !== spec.sheets.length || sheets.some(id => !spec.sheets.includes(id))) {
        update({ ...emptyAnalysis(), sheets });
        setSettingOpen(true);
      }
    }
    else message.warning(t('analysisNoTables'));
    finishImport();
  }, [incoming, busy, job, all]);

  function editMetric(index: number, value: Metric) {
    update({ metrics: spec.metrics.map((metric, position) => position === index ? value : metric) });
  }

  async function run() {
    if (!ready || disabled) return;
    setJob('compute');
    setBusy(true);
    setProblem(undefined);
    try {
      const data = await calculate(spec, selected);
      setResult({ key, data });
      setSettingOpen(false);
      setGroupPage(1);
      setDetailKey(undefined);
    } catch (error) {
      const code = errorCode(error, 'analysis_failed');
      setProblem(code);
      setResult(undefined);
    } finally { setBusy(false); setJob(undefined); }
  }

  async function exportFiles(kind: 'xlsx' | 'pack') {
    if (!active || !active.included || disabled) return;
    setJob(kind);
    setBusy(true);
    try {
      const kinds = kind === 'xlsx' ? ['xlsx'] as const : ['xlsx', 'docx', 'pptx'] as const;
      const output = await Promise.all(kinds.map(format => exportAnalysis(format, title, spec, active, selected, fields, t, i18n.language as Locale)));
      const stored = await deliver(output, crypto.randomUUID());
      if (kind === 'xlsx') await save(stored[0]!);
      else await savePack(title, stored);
    } catch (error) { message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') })); }
    finally { setBusy(false); setJob(undefined); }
  }

  function openDetails(id: string) { setDetailKey(id); setDetailPage(1); }

  return <>
    <div className="page-heading">
      <div><h1>{t('analysis')}</h1><p>{t('analysisIntro')}</p></div>
      <div className="heading-actions">
        <Button icon={<FolderOpenOutlined />} disabled={disabled || busy} onClick={() => pick(true)}>{t('addFolder')}</Button>
        <Button icon={<PlusOutlined />} disabled={disabled || busy} onClick={() => pick(false)}>{t('addFiles')}</Button>
        <Button icon={<ReloadOutlined />} aria-label={t('refresh')} title={t('refresh')} disabled={disabled || busy} onClick={refresh} />
      </div>
    </div>
    {active && !settingOpen ? <div className="panel analysis-run-bar">
      <div><strong>{t('analysisSelectedSheets', { count: selected.length })}</strong>
        <small>{[
          ...spec.dimensions.map(labels.label),
          ...(spec.dateColumn ? [spec.from + ' – ' + spec.to] : []),
          ...(spec.filterColumn ? [labels.label(spec.filterColumn) + ' = ' + spec.filterText] : []),
        ].join(' · ')}</small></div>
      <Button icon={<SettingOutlined />} disabled={disabled} onClick={() => setSettingOpen(true)}>{t('analysisEditSettings')}</Button>
    </div> : <section className="panel analysis-config">
      <div className="analysis-config-head">
        <div className="field"><label htmlFor="analysis-sheets">{t('analysisSheets')}</label>
          <Select id="analysis-sheets" mode="multiple" showSearch={{ optionFilterProp: 'label' }} maxTagCount={3} value={spec.sheets}
            disabled={disabled || busy} options={all.map(table => ({ value: table.id, label: table.file + ' / ' + table.sheet.name }))}
            placeholder={t('analysisSelectSheets')} onChange={sheets => update({ sheets })} />
        </div>
        <Button icon={<SettingOutlined />} disabled={!selected.length || disabled || busy} onClick={() => setHeaderOpen(true)}>{t('analysisHeaders')}</Button>
      </div>
      {missing > 0 && !busy && <Alert type="warning" showIcon title={t('analysisMissingSheets', { count: missing })}
        action={<Button size="small" disabled={disabled} onClick={() => update({ sheets: selected.map(table => table.id) })}>{t('removeMissing')}</Button>} />}
      {!busy && selected.length > 1 && !fields.length && <Alert type="info" showIcon title={t('analysisNoCommon')} />}
      <div className="analysis-fields">
        <div className="field"><label htmlFor="analysis-dimensions">{t('analysisGroupBy')}</label>
          <Select id="analysis-dimensions" mode="multiple" maxCount={2} value={spec.dimensions} placeholder={t('analysisAllRows')}
            options={fields} disabled={disabled || busy || !selected.length} showSearch={{ optionFilterProp: 'label' }}
            onChange={dimensions => update({ dimensions })} />
        </div>
        <div className="field">
          <div id="analysis-metrics" className="analysis-field-label">{t('analysisMetrics')}</div>
          <div className="analysis-metric-list" aria-labelledby="analysis-metrics">
            {spec.metrics.map((metric, index) => <div className="analysis-metric-form" key={index}>
              <Select value={metric.method} aria-label={t('analysisMethod')} disabled={disabled || busy} options={aggregateMethods.map(value => ({ value, label: t(methodLabels[value]) }))}
                onChange={method => editMetric(index, { method, column: method === 'count' ? undefined : metric.column })} />
              {metric.method !== 'count' && <Select value={metric.column} aria-label={t('analysisColumn')} placeholder={t('analysisColumn')}
                options={fields} disabled={disabled || busy} showSearch={{ optionFilterProp: 'label' }} onChange={column => editMetric(index, { ...metric, column })} />}
              {spec.metrics.length > 1 && <Button type="text" icon={<CloseOutlined />} aria-label={t('analysisRemoveMetric')} disabled={disabled}
                onClick={() => update({ metrics: spec.metrics.filter((_, position) => position !== index) })} />}
            </div>)}
          </div>
          {spec.metrics.length < 3 && <Button className="analysis-filter-button" type="link" size="small" icon={<PlusOutlined />} disabled={disabled}
            onClick={() => update({ metrics: [...spec.metrics, { method: 'sum' }] })}>{t('analysisAddMetric')}</Button>}
        </div>
      </div>
      {filterOpen && <div className="analysis-filters">
        <div className="field"><label htmlFor="analysis-date">{t('dateCol')}</label>
          <Select id="analysis-date" allowClear options={fields} value={spec.dateColumn} disabled={disabled || busy} placeholder={t('optional')}
            onChange={dateColumn => update({ dateColumn })} />
        </div>
        {spec.dateColumn && <>
          <div className="field"><label htmlFor="analysis-from">{t('from')}</label><DatePicker id="analysis-from" value={spec.from ? dayjs(spec.from) : null}
            disabled={disabled} format="YYYY-MM-DD" onChange={value => update({ from: value?.format('YYYY-MM-DD') ?? '' })} /></div>
          <div className="field"><label htmlFor="analysis-to">{t('to')}</label><DatePicker id="analysis-to" value={spec.to ? dayjs(spec.to) : null}
            disabled={disabled} format="YYYY-MM-DD" onChange={value => update({ to: value?.format('YYYY-MM-DD') ?? '' })} /></div>
        </>}
        <div className="field"><label htmlFor="analysis-filter">{t('analysisFilterColumn')}</label>
          <Select id="analysis-filter" allowClear options={fields} value={spec.filterColumn} disabled={disabled || busy} placeholder={t('optional')}
            onChange={filterColumn => update({ filterColumn })} />
        </div>
        {spec.filterColumn && <div className="field"><label htmlFor="analysis-filter-text">{t('analysisEquals')}</label>
          <Input id="analysis-filter-text" value={spec.filterText} maxLength={160} disabled={disabled} onChange={event => update({ filterText: event.target.value })} /></div>}
      </div>}
      <div className="analysis-actions">
        <Button type="text" onClick={() => setFilterOpen(value => !value)} aria-expanded={filterOpen}>{t('analysisFilters')}</Button>
        <Button type="primary" icon={<CalculatorOutlined />} disabled={!ready || busy || locked && job !== 'compute'} loading={job === 'compute'}
          onClick={() => void run()}>{t('analysisCalculate')}</Button>
      </div>
      {selected.length > 0 && !missing && !ready && !busy && <p className="muted">{t('analysisChooseColumns')}</p>}
    </section>}
    {problem && <Alert className="analysis-alert" type="error" showIcon title={t(problem, { defaultValue: t('analysis_failed') })} />}
    {result && !active && <Alert className="analysis-alert" type="info" showIcon title={t('analysisStale')} />}
    {active && <section className="panel analysis-result">
      <div className="analysis-result-head">
        <div><h2>{t('analysisSummarySheet')}</h2><p>{t('analysisCoverage', { included: active.included, filtered: active.filtered, invalid: active.invalidDates })}</p></div>
        <div className="heading-actions">
          <Button disabled={disabled || !active.included} onClick={() => {
            const evidence = { ...analysisEvidence(spec, active, selected, fields, t), id: 'A1' };
            const groups = active.groups.filter(group => group.values[0] !== null).slice(0, 10);
            compose({ draft: { title, sections: [{ heading: t('analysisSummarySheet'), text: evidence.text }] }, refs: [evidence], locale: i18n.language as Locale,
              chart: spec.dimensions.length && groups.length ? { title: labels.metrics[0]!, series: labels.metrics[0]!, source: evidence.text.split('\n')[0]!,
                labels: groups.map(group => displayGroup(group)), values: groups.map(group => group.values[0]!) } : undefined });
          }}>{t('creativeFromAnalysis')}</Button>
          <Button icon={<ThunderboltOutlined />} disabled={disabled || !active.included}
            onClick={() => writeReport(analysisEvidence(spec, active, selected, fields, t))}>{t('analysisWriteReport')}</Button>
          <Button icon={<DownloadOutlined />} disabled={locked && job !== 'pack' || !active.included} loading={job === 'pack'} onClick={() => void exportFiles('pack')}>{t('reportPack')}</Button>
          <Button type="primary" icon={<FileExcelOutlined />} disabled={locked && job !== 'xlsx' || !active.included} loading={job === 'xlsx'}
            onClick={() => void exportFiles('xlsx')}>{t('analysisExportWorkbook')}</Button>
        </div>
      </div>
      <div className="analysis-totals">
        {labels.metrics.map((label, index) => <div className="analysis-total" key={index}>
          <span>{label}</span>
          <strong data-analysis-total={index}>{format(active.totals[index] ?? null)}</strong>
          {(active.missing[index] ?? 0) > 0 && <small>{t('analysisMissingCount', { count: active.missing[index] })}</small>}
        </div>)}
      </div>
      {active.invalidDates > 0 && <Button type="link" onClick={() => openDetails('dates')}>{t('analysisViewInvalidDates')}</Button>}
      {!active.groups.length ? <Alert type="info" showIcon title={t('analysisEmptyResult')} /> : <div className="table-scroll">
        <table className="data-table analysis-table">
          <thead><tr>{[...labels.dimensions, ...labels.metrics, t('analysisRecords')].map((label, index) => <th key={index}>{label}</th>)}
            <th><span className="sr-only">{t('analysisDetailsSheet')}</span></th></tr></thead>
          <tbody>{active.groups.slice((groupPage - 1) * groupSize, groupPage * groupSize).map(group => <tr key={group.key}>
            {(group.labels.length ? group.labels : [t('analysisTotal')]).map((label, index) => <td key={index}>{label || t('analysisBlank')}</td>)}
            {group.values.map((value, index) => <td className="numeric" key={'v' + index}>{format(value)}</td>)}
            <td className="numeric">{group.rows}</td>
            <td><Button type="link" size="small" onClick={() => openDetails(group.key)}>{t('analysisDetailsSheet')}</Button></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {active.groups.length > groupSize && <Pagination size="small" current={groupPage} pageSize={groupSize} total={active.groups.length} showSizeChanger={false} onChange={setGroupPage} />}
    </section>}
    <Drawer open={headerOpen} size="min(620px, 96vw)" title={t('analysisHeaders')} onClose={() => setHeaderOpen(false)}>
      <p className="muted">{t('analysisHeaderHint')}</p>
      {selected.map(table => <div className="analysis-header-row" key={table.id}>
        <div><strong>{table.file}</strong><small>{table.sheet.name}</small></div>
        <InputNumber aria-label={t('headerRow') + ' ' + table.file + ' ' + table.sheet.name} min={1} max={1048576} precision={0}
          disabled={disabled} value={spec.headers[table.id] ?? table.header} onChange={value => { if (value) update({ headers: { ...spec.headers, [table.id]: value } }); }} />
      </div>)}
    </Drawer>
    <Drawer open={Boolean(active && detailKey)} size="min(950px, 96vw)"
      title={detailKey === 'dates' ? t('analysisInvalidDate') : activeGroup ? displayGroup(activeGroup) : t('analysisDetailsSheet')}
      onClose={() => setDetailKey(undefined)}>
      {active && <><p className="muted">{t('analysisRows', { count: details.length })}</p>
        <div className="table-scroll"><table className="data-table analysis-table">
          <thead><tr><th>{t('source')}</th><th>{t('analysisOriginalRow')}</th>{active.columns.map(column => <th key={column}>{labels.label(column)}</th>)}<th>{t('filePreview')}</th></tr></thead>
          <tbody>{details.slice((detailPage - 1) * detailSize, detailPage * detailSize).map(row => {
            const table = selected[row.source]!;
            return <tr key={row.source + '-' + row.row}>
              <td title={table.path}>{table.file}<Tag>{table.sheet.name}</Tag></td><td>{row.row}</td>
              {row.cells.map((cell, index) => <td key={index}>{cell ?? '—'}</td>)}
              <td><Button type="text" icon={<LinkOutlined />} size="small" aria-label={t('jumpToSource')} onClick={() => {
                setDetailKey(undefined);
                locate(detailLocation(row, selected, row.cells.join(' · ')));
              }} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        {details.length > detailSize && <Pagination size="small" current={detailPage} pageSize={detailSize} total={details.length} showSizeChanger={false} onChange={setDetailPage} />}
      </>}
    </Drawer>
  </>;
}
