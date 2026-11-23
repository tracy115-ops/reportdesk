import { Alert, Button, Checkbox, Input, InputNumber, Modal, Popconfirm, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { columns, columnName, guessMapping, headerSignature, newMapping, validMapping } from './domain';
import type { Mapping, MappingCheck, Sheet } from './domain';
import { sameLayout } from './report-input';

interface Props {
  file: string;
  sheets: Sheet[];
  check?: MappingCheck;
  previous?: Mapping;
  rules?: Mapping[];
  close: () => void;
  save: (mapping: Mapping, reuse: boolean) => void;
  removeRule: (rule: Mapping) => void;
}

export default function MappingDialog({ file, sheets, check, previous, rules, close, save, removeRule }: Props) {
  const { t } = useTranslation();
  const firstSheet = sheets.find(sheet => sheet.rows.length)!;
  const [value, setValue] = useState(() => {
    if (check?.mapping) return check.mapping;
    if (previous) {
      const sheet = sheets.find(item => item.name === previous.sheet && item.rows.length) ?? firstSheet;
      const row = sheet.rows.find(item => item.number === previous.headerRow) ?? sheet.rows[0]!;
      const suggestion = newMapping(sheet, row.number);
      return { ...suggestion, namespace: previous.namespace, done: previous.done, open: previous.open, dateOrder: previous.dateOrder };
    }
    return guessMapping(sheets) ?? newMapping(firstSheet, firstSheet.rows[0]!.number);
  });
  const [reuse, setReuse] = useState(false);
  const sheet = sheets.find(item => item.name === value.sheet);
  const mapping = { ...value, signature: headerSignature(sheet, value.headerRow) };
  const existingRule = rules?.find(rule => sameLayout(rule, mapping));
  const header = columns(sheet, value.headerRow);
  const options = header.map(col => ({ value: col.index, label: `${columnName(col.index)} · ${col.header}` }));
  const allowed = validMapping(value, sheet);
  const peek = sheet?.rows.filter(row => row.number > value.headerRow).slice(0, 3) ?? [];
  const fields = [['date', 'dateCol'], ['status', 'statusCol'], ['id', 'idCol'], ['title', 'nameCol'], ['owner', 'ownerCol']] as const;
  const previewColumns = fields.flatMap(([key, label]) => value[key] ? [{ index: value[key]!, label }] : []);
  return <Modal open title={t('mappingTitle')} width={680} onCancel={close}
    footer={<><Button onClick={close}>{t('cancel')}</Button><Button type="primary" disabled={!allowed}
      onClick={() => save(mapping, reuse)}>{t('saveMapping')}</Button></>}>
    <p className="col-dialog-file">{file}</p>
    <p className="muted">{t('mappingIntro')}</p>
    {check && !check.mapping && check.state !== 'mapping_needed' && <Alert type="warning" showIcon title={t(check.state)} />}
    <div className="mapping-grid">
      <div className="field">
        <label htmlFor="map-sheet">{t('sheet')}</label>
        <Select id="map-sheet" value={value.sheet} options={sheets.map(item => ({ value: item.name, label: item.name, disabled: !item.rows.length }))}
          onChange={name => {
            const target = sheets.find(item => item.name === name)!;
            const suggested = guessMapping([target]) ?? newMapping(target, target.rows[0]!.number);
            setValue({ ...suggested, namespace: value.namespace, done: value.done, open: value.open, dateOrder: value.dateOrder });
          }} />
      </div>
      <div className="field">
        <label htmlFor="map-header">{t('headerRow')}</label>
        <InputNumber id="map-header" value={value.headerRow} min={1} max={1048576} precision={0} onChange={row => {
          if (row && sheet) setValue({ ...value, ...newMapping(sheet, row), namespace: value.namespace, done: value.done, open: value.open, dateOrder: value.dateOrder });
        }} />
      </div>
      {fields.map(([key, label]) => <div className="field" key={key}>
        <label htmlFor={`map-${key}`}>{t(label)}</label>
        <Select id={`map-${key}`} value={value[key] || undefined} options={options} allowClear={key !== 'date' && key !== 'status'}
          placeholder={t(key === 'date' || key === 'status' ? 'chooseColumn' : 'optional')}
          onChange={col => setValue({ ...value, [key]: col })} />
      </div>)}
      <div className="field">
        <label htmlFor="map-format">{t('dateOrder')}</label>
        <Select id="map-format" value={value.dateOrder} options={[
          { value: 'ymd', label: 'YYYY-MM-DD' }, { value: 'mdy', label: 'MM/DD/YYYY' }, { value: 'dmy', label: 'DD/MM/YYYY' },
        ]} onChange={dateOrder => setValue({ ...value, dateOrder })} />
      </div>
      <div className="field map-span">
        <label htmlFor="map-namespace">{t('namespace')}</label>
        <Input id="map-namespace" value={value.namespace} maxLength={64} placeholder={t('namespaceHint')}
          onChange={event => setValue({ ...value, namespace: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="map-done">{t('doneTokens')}</label>
        <Input.TextArea id="map-done" rows={2} maxLength={600} value={value.done} onChange={event => setValue({ ...value, done: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="map-open">{t('openTokens')}</label>
        <Input.TextArea id="map-open" rows={2} maxLength={600} value={value.open} onChange={event => setValue({ ...value, open: event.target.value })} />
      </div>
    </div>
    <p className={allowed ? 'muted' : 'error-text'}>{t(allowed ? 'statusHint' : 'invalidMapping')}</p>
    {rules && <div className="mapping-reuse">
      <Checkbox checked={reuse} onChange={event => setReuse(event.target.checked)}>{t('reuseMapping')}</Checkbox>
      {existingRule && <Popconfirm title={t('removeFolderMapping')} okText={t('remove')} cancelText={t('cancel')}
        onConfirm={() => { setReuse(false); removeRule(existingRule); }}>
        <Button size="small" type="text">{t('removeFolderMapping')}</Button>
      </Popconfirm>}
      <p className="muted">{t('reuseMappingHint')}</p>
    </div>}
    {peek.length > 0 && previewColumns.length > 0 && <div className="mapping-peek">
      <h4>{t('sampleRows')}</h4>
      <div className="table-scroll"><table className="data-table"><thead><tr>
        {previewColumns.map(col => <th key={col.label}>{t(col.label)}</th>)}
      </tr></thead><tbody>{peek.map(row => <tr key={row.number}>
        {previewColumns.map(col => <td key={col.label}>{String(row.cells[col.index] ?? '—').slice(0, 100)}</td>)}
      </tr>)}</tbody></table></div>
    </div>}
  </Modal>;
}
