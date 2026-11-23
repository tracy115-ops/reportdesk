import { Alert, Input, Modal, Tabs } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Papa from 'papaparse';
import type { Loaded } from './domain';
import type { SlideData, ChartSelection } from './slide-data';
import { chartData, chartSelection } from './slide-data';
import { parseCreativeChart } from './creative-workflows';
import SlideDataFields from './SlideDataFields';

export default function CreativeChartDialog({ open, initial, files, busy, pick, close, save }: {
  open: boolean; initial?: SlideData; files: Loaded[]; busy: boolean; pick: () => void; close: () => void; save: (chart: SlideData) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('manual');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [series, setSeries] = useState('');
  const [source, setSource] = useState('');
  const [selection, setSelection] = useState<ChartSelection>();
  const [error, setError] = useState<string>();
  const workbooks = files.filter(file => file.parsed?.kind === 'xlsx');
  useEffect(() => {
    if (!open) return;
    setText(initial ? Papa.unparse(initial.labels.map((label, index) => [label, initial.values[index]]), { delimiter: '\t' }) : '');
    setTitle(initial?.title ?? t('studioChartTitle')); setSeries(initial?.series ?? ''); setSource(initial?.source ?? '');
    setMode('manual'); setError(undefined); setSelection(undefined);
  }, [open]);
  useEffect(() => {
    if (!open || selection) return;
    const first = workbooks[0];
    const sheet = first?.parsed?.kind === 'xlsx' ? first.parsed.sheets.find(sheet => sheet.rows.length) : undefined;
    if (first && sheet) setSelection(chartSelection(first.material.id, sheet));
  }, [open, files, selection]);
  function submit() {
    try {
      if (!title.trim()) throw Error('studio_chart_invalid');
      if (mode === 'manual') save(parseCreativeChart(text, title, series, source));
      else {
        const data = chartData(workbooks.find(file => file.material.id === selection?.fileId), selection);
        if (!data.data) throw Error(data.error ?? 'studio_chart_invalid');
        save({ ...data.data, title: title.trim(), series: series.trim() || data.data.series, source: source.trim() || data.data.source });
      }
      close();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <Modal open={open} width={660} title={t('studioChartTitle')} okText={t('studioChartInsert')} cancelText={t('cancel')}
    onCancel={close} onOk={submit} okButtonProps={{ disabled: busy }}>
    <div className="studio-chart-dialog">
      {error && <Alert showIcon type="error" title={t(error, { defaultValue: t('studio_chart_invalid') })} />}
      <div className="field"><label htmlFor="studio-chart-title">{t('contentTitle')}</label><Input id="studio-chart-title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></div>
      <Tabs activeKey={mode} onChange={value => { setMode(value); setError(undefined); }} items={[
        { key: 'manual', label: t('studioChartManual'), children: <div className="field"><label htmlFor="studio-chart-paste">{t('studioChartPaste')}</label>
          <Input.TextArea id="studio-chart-paste" value={text} rows={7} maxLength={6000} placeholder={t('studioChartLabel') + ',' + t('studioChartValue') + '\nA,27\nB,-8\nC,0'} onChange={event => { setText(event.target.value); setError(undefined); }} /></div> },
        { key: 'excel', label: t('studioChartExcel'), children: <SlideDataFields workbooks={workbooks} selection={selection} change={setSelection} disabled={busy} add={pick} /> },
      ]} />
      <div className="tool-grid"><div className="field"><label htmlFor="studio-chart-series">{t('studioChartSeries')}</label><Input id="studio-chart-series" value={series} maxLength={120} onChange={event => setSeries(event.target.value)} /></div>
        <div className="field"><label htmlFor="studio-chart-source">{t('studioChartSource')}</label><Input id="studio-chart-source" value={source} maxLength={260} onChange={event => setSource(event.target.value)} /></div></div>
    </div>
  </Modal>;
}
