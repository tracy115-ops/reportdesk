import { Button, Input, InputNumber, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { columns } from './domain';
import type { Loaded } from './domain';
import { chartData, chartSelection } from './slide-data';
import type { ChartSelection } from './slide-data';

export default function SlideDataFields({ workbooks, selection, change, disabled, add }: {
  workbooks: Loaded[]; selection: ChartSelection | undefined; change: (selection: ChartSelection) => void; disabled: boolean; add: () => void;
}) {
  const { t } = useTranslation();
  const source = workbooks.find(item => item.material.id === selection?.fileId);
  const sheets = source?.parsed?.kind === 'xlsx' ? source.parsed.sheets.filter(sheet => sheet.rows.length) : [];
  const sheet = sheets.find(item => item.name === selection?.sheetName);
  const options = columns(sheet, selection?.header ?? 1).map(column => ({ value: column.index, label: column.header }));
  const data = chartData(source, selection);
  return <div className="chart-fields">
    <div className="tool-grid">
      <div className="field"><label htmlFor="slide-chart-file">{t('selectWorkbook')}</label>
        <Select id="slide-chart-file" value={source?.material.id} disabled={disabled}
          options={workbooks.map(item => ({ value: item.material.id, label: item.material.relative }))}
          placeholder={t(workbooks.length ? 'pickAvailable' : 'noCompatible')} onChange={id => {
            const file = workbooks.find(item => item.material.id === id);
            const first = file?.parsed?.kind === 'xlsx' ? file.parsed.sheets.find(item => item.rows.length) : undefined;
            if (first) change(chartSelection(id, first));
          }} /></div>
      <div className="field"><label htmlFor="slide-chart-sheet">{t('sheet')}</label>
        <Select id="slide-chart-sheet" value={sheet?.name} disabled={!sheets.length || disabled} options={sheets.map(item => ({ value: item.name, label: item.name }))}
          onChange={name => { const next = sheets.find(item => item.name === name); if (source && next) change(chartSelection(source.material.id, next)); }} /></div>
    </div>
    {!workbooks.length && <div><Button size="small" disabled={disabled} onClick={add}>{t('fileChoose')}</Button></div>}
    {selection && sheet && <>
      <div className="tool-grid triple">
        <div className="field"><label htmlFor="slide-chart-label">{t('chartLabels')}</label>
          <Select id="slide-chart-label" value={selection.label} disabled={disabled} options={options} onChange={label => change({ ...selection, label })} /></div>
        <div className="field"><label htmlFor="slide-chart-value">{t('chartNumbers')}</label>
          <Select id="slide-chart-value" value={selection.value} disabled={disabled} options={options} onChange={value => change({ ...selection, value })} /></div>
        <div className="field"><label htmlFor="slide-chart-header">{t('headerRow')}</label>
          <InputNumber id="slide-chart-header" min={1} max={1048576} precision={0} value={selection.header} disabled={disabled}
            onChange={header => { if (header) change(chartSelection(selection.fileId, sheet, header)); }} /></div>
      </div>
      <div className="tool-grid chart-range">
        <div className="field"><label htmlFor="slide-chart-heading">{t('chartHeading')}</label>
          <Input id="slide-chart-heading" value={selection.title} disabled={disabled} maxLength={120}
            placeholder={data.data?.series} onChange={event => change({ ...selection, title: event.target.value })} /></div>
        <div className="field"><label htmlFor="slide-chart-from">{t('chartFromRow')}</label>
          <InputNumber id="slide-chart-from" min={1} max={1048576} precision={0} value={selection.from} disabled={disabled}
            onChange={from => { if (from) change({ ...selection, from }); }} /></div>
        <div className="field"><label htmlFor="slide-chart-to">{t('chartToRow')}</label>
          <InputNumber id="slide-chart-to" min={1} max={1048576} precision={0} value={selection.to} disabled={disabled}
            onChange={to => { if (to) change({ ...selection, to }); }} /></div>
      </div>
      {data.error && <p className="error-text">{t(data.error, { row: data.row })}</p>}
      {data.data && <p className="muted">{t('chartDataCount', { count: data.data.values.length })} · {data.data.source}</p>}
    </>}
  </div>;
}
