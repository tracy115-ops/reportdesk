import { DownloadOutlined, DownOutlined, EditOutlined, FileWordOutlined, HistoryOutlined, LinkOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input, Modal, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reportTitle, sections } from './domain';
import type { Evidence, Narrative, Report } from './domain';
import { dictionaries } from './i18n';
import type { Artifact } from './office';

interface Props {
  report: Report;
  show: (item: Evidence) => void;
  saveText: (narrative: Narrative) => Promise<boolean>;
  onExport: () => void;
  compose: () => void;
  archive?: () => void;
  artifact: (kind: 'docx' | 'pptx') => void;
  pack?: { create: () => void; busy: boolean; files: Artifact[]; preview: (id: string) => void; save: () => void };
  busy: boolean;
  exporting: boolean;
}

export default function ReportView({ report, show, saveText, onExport, compose, archive, artifact, pack, busy, exporting }: Props) {
  const { t } = useTranslation();
  const language = dictionaries[report.settings.locale];
  const [editing, setEditing] = useState<Narrative | null>(null);
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const issueCount = Object.values(report.issues).reduce((sum, value) => sum + value, 0);
  const completePack = pack && ['docx', 'xlsx', 'pptx'].every(kind => pack.files.some(file => file.kind === kind));
  function line(text: string) {
    return text.split(/(\[[DT]\d+\])/g).map((part, i) => {
      const source = part.startsWith('[') ? evidence.get(part.slice(1, -1)) : undefined;
      return source ? <button className="cite" key={i} onClick={() => show(source)} title={t('evidenceTitle')}>{part}</button> : part;
    });
  }
  return <>
    {pack && pack.files.length > 0 && <div className="task-files" aria-label={t('generatedFiles')}>
      {pack.files.map(file => <Button icon={<LinkOutlined />} key={file.id} onClick={() => pack.preview(file.id)}>{t(file.kind)}</Button>)}
    </div>}
    <div className="report-tools">
      <Button disabled={busy} onClick={compose}>{t('creativeFromReport')}</Button>
      {pack && (completePack ?
        <Button type="primary" icon={<DownloadOutlined />} disabled={busy} loading={exporting} onClick={pack.save}>{t('saveReportPack')}</Button> :
        <Button type="primary" icon={<FileWordOutlined />} disabled={busy && !pack.busy} loading={pack.busy} onClick={pack.create}>{t('reportPack')}</Button>)}
      <Button icon={<EditOutlined />} disabled={busy} onClick={() => setEditing({ ...report.narrative })}>{t('edit')}</Button>
      {archive && <Button icon={<HistoryOutlined />} disabled={busy} onClick={archive}>{t('archive')}</Button>}
      <Dropdown menu={{ items: [{ key: 'docx', label: t('docx') }, { key: 'pptx', label: t('exportPpt') }],
        onClick: ({ key }) => artifact(key === 'pptx' ? 'pptx' : 'docx') }} trigger={['click']}>
        <Button disabled={busy}>{t('saveWorkReport')} <DownOutlined /></Button>
      </Dropdown>
      <Button type={pack ? 'default' : 'primary'} icon={<DownloadOutlined />} disabled={busy} loading={exporting} onClick={onExport}>{t('export')}</Button>
    </div>
    <article className="report-paper" lang={report.settings.locale}>
      <div className="report-letterhead"><FileWordOutlined /> {language[report.settings.cadence]}
        {report.sample && <Tag>{language.sampleBadge}</Tag>}{report.polished && <Tag color="green">{language.codexBadge}</Tag>}
      </div>
      <h2>{reportTitle(report.settings)}</h2>
      <p className="report-dates numeric">{report.settings.from} — {report.settings.to}</p>
      {sections.map(section => <section className="paper-section" key={section}><h3>{language[section]}</h3>
        {report.narrative[section].split(/\r?\n/).filter(Boolean).map((text, index) => <p key={index}>{line(text)}</p>)}
      </section>)}
      {issueCount > 0 && <p className="report-audit">{language.issueTotals.replace('{{count}}', String(issueCount))}</p>}
      {report.evidence.length > 0 && <section className="paper-section report-evidence">
        <h3>{language.reportEvidence}</h3><div className="source-citations">
          {report.evidence.map(item => <button className="source-chip" title={item.text} key={item.id} onClick={() => show(item)}>
            <LinkOutlined /> <span>{item.id} · {item.locations[0]?.file}</span>
          </button>)}
        </div>
      </section>}
    </article>
    <Modal open={Boolean(editing)} title={t('editTitle')} width={640} okText={t('save')} cancelText={t('cancel')} confirmLoading={busy}
      onCancel={() => setEditing(null)} onOk={async () => { if (editing && await saveText(editing)) setEditing(null); }}>
      {editing && <div className="edit-sections">{sections.map(section => <div className="field" key={section}>
        <label htmlFor={`edit-${section}`}>{language[section]}</label>
        <Input.TextArea id={`edit-${section}`} autoSize={{ minRows: 3, maxRows: 7 }} maxLength={8000} value={editing[section]}
          onChange={event => setEditing({ ...editing, [section]: event.target.value })} />
      </div>)}</div>}
    </Modal>
  </>;
}
