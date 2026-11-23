import { CalendarOutlined, HistoryOutlined, SaveOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Popconfirm, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportProfile } from './domain';

interface Props {
  profiles: ReportProfile[];
  value?: string;
  disabled: boolean;
  canSave: boolean;
  previous: (previous: boolean) => void;
  choose: (id?: string) => void;
  save: (name: string, id?: string) => void;
  remove: (id: string) => void;
  history: () => void;
}

export default function ReportControls({ profiles, value, disabled, canSave, previous, choose, save, remove, history }: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<{ name: string; id?: string }>();
  const selected = profiles.find(profile => profile.id === value);
  return <div className="report-controls">
    <span className="report-control-label">{t('reportProfile')}</span>
    <Select aria-label={t('reportProfile')} value={value} placeholder={t('allSources')} allowClear disabled={disabled}
      onChange={choose} options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} />
    <Button size="small" disabled={disabled || !canSave} icon={<SaveOutlined />} onClick={() => setDialog({ name: '' })}>{t(selected ? 'saveNewProfile' : 'saveProfile')}</Button>
    {selected && <Button size="small" disabled={disabled || !canSave} onClick={() => setDialog({ id: selected.id, name: selected.name })}>{t('updateProfile')}</Button>}
    {selected && <Popconfirm title={t('removeProfile')} description={selected.name} okText={t('removeProfile')} cancelText={t('cancel')} onConfirm={() => remove(selected.id)}>
      <Button type="text" size="small" disabled={disabled}>{t('removeProfile')}</Button>
    </Popconfirm>}
    <div className="period-shortcuts">
      <CalendarOutlined /><Button size="small" disabled={disabled} onClick={() => previous(false)}>{t('currentPeriod')}</Button>
      <Button size="small" disabled={disabled} onClick={() => previous(true)}>{t('previousPeriod')}</Button>
    </div>
    <Button size="small" type="text" icon={<HistoryOutlined />} onClick={history}>{t('history')}</Button>
    <Modal open={Boolean(dialog)} title={t(dialog?.id ? 'updateProfile' : 'saveProfile')} okText={t('save')} cancelText={t('cancel')} okButtonProps={{ disabled: !dialog?.name.trim() }}
      onCancel={() => setDialog(undefined)} onOk={() => { if (dialog?.name.trim()) save(dialog.name.trim(), dialog.id); setDialog(undefined); }}>
      <Input aria-label={t('profileName')} placeholder={t('profileName')} maxLength={80} value={dialog?.name ?? ''}
        onChange={event => setDialog(current => current && { ...current, name: event.target.value })} />
      <p className="muted">{t('profileHint')}</p>
    </Modal>
  </div>;
}
