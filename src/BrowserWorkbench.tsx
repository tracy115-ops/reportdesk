import { Alert, App as AntApp, Button, DatePicker, Input, Modal, Select, Table } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeftOutlined, CheckCircleOutlined, FileExcelOutlined, FolderOpenOutlined, HistoryOutlined, MobileOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import EmbeddedBrowser from './EmbeddedBrowser';
import type { BrowserQualityReport } from './EmbeddedBrowser';
import { errorCode, nativeDesktop } from './desktop';
import type { SourceSelection } from './desktop';
import type { NewArtifact } from './office';
import { reportAddress, validationWorkbook } from './validation-report';
import type { MiniIssue, MiniReport, ValidationReport } from './validation-report';
import { webMaterialMarkdown } from './web-material';
import type { BrowserCapture } from './web-material';

export type BrowserIntake = { url: string; key: string; links?: readonly string[] };
interface Props {
  incoming?: BrowserIntake;
  deliver: (files: NewArtifact[]) => Promise<unknown>;
  openArtifacts: () => void;
  importMaterials: (selection: SourceSelection) => Promise<string[]>;
  returnToAssistant: (ids: string[]) => void;
  locked: boolean;
}

export default function BrowserWorkbench({ incoming, deliver, openArtifacts, importMaterials, returnToAssistant, locked }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [local, setLocal] = useState<BrowserIntake>();
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<ValidationReport>();
  const [reportOpen, setReportOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ValidationReport>();
  const saveLock = useRef(false);
  const [capture, setCapture] = useState<BrowserCapture>();
  const [captureTitle, setCaptureTitle] = useState('');
  const [capturePeriod, setCapturePeriod] = useState<[string, string]>();
  const [capturedIds, setCapturedIds] = useState<string[]>([]);
  const [savingCapture, setSavingCapture] = useState(false);
  const captureLock = useRef(false);
  const web = latest?.kind === 'web' ? latest.report : undefined;
  const mini = latest?.kind === 'mini' ? latest.report : undefined;

  useEffect(() => { setLocal(undefined); }, [incoming?.key]);
  useEffect(() => () => { void invoke('preview_stop').catch(() => undefined); }, []);

  function reviewCapture(page: BrowserCapture) {
    setCaptureTitle(page.title);
    setCapturePeriod(undefined);
    setCapture(page);
  }

  async function saveCapture() {
    if (!capture || !captureTitle.trim() || captureLock.current || locked) return;
    captureLock.current = true;
    setSavingCapture(true);
    try {
      const selection = await invoke<SourceSelection>('save_browser_capture', {
        title: captureTitle.trim(),
        markdown: webMaterialMarkdown(capture, captureTitle, capturePeriod),
      });
      const ids = await importMaterials(selection);
      setCapturedIds(current => [...new Set([...current, ...ids])]);
      setCapture(undefined);
      message.success(t('browserCaptureSaved'));
    } catch (error) {
      message.error(t(errorCode(error, 'file_access'), { defaultValue: t('file_access') }));
    } finally {
      captureLock.current = false;
      setSavingCapture(false);
    }
  }

  function showReport(report: ValidationReport) {
    setLatest(report);
    setSaved(undefined);
    setReportOpen(true);
  }

  function showWebReport(report: BrowserQualityReport) {
    showReport({ kind: 'web', report });
  }

  async function saveReport() {
    if (!latest || saveLock.current || saved === latest) return;
    saveLock.current = true;
    setSaving(true);
    try {
      await deliver([await validationWorkbook(latest, t)]);
      setSaved(latest);
    } catch (error) {
      message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') }));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  async function loadProject(kind: 'web' | 'mini') {
    setBusy(true);
    try {
      const result = await invoke<string | null>(kind === 'web' ? 'preview_pick_folder' : 'mini_program_open');
      if (!result) return;
      if (kind === 'web') setLocal({ url: result, key: crypto.randomUUID() });
      else message.success(t('mini_program_opened'));
    } catch (error) {
      message.error(t(errorCode(error, 'preview_failed'), { defaultValue: t('preview_failed') }));
    } finally { setBusy(false); }
  }

  async function checkMiniProgram() {
    setBusy(true);
    try {
      const result = await invoke<MiniReport | null>('mini_program_check');
      if (result) showReport({ kind: 'mini', report: result, checkedAt: Date.now() });
    } catch (error) {
      message.error(t(errorCode(error, 'mini_program_invalid'), { defaultValue: t('mini_program_invalid') }));
    } finally { setBusy(false); }
  }

  return <section className="browser-workbench">
    <div className="browser-workbench-top">
      <div className="browser-project-actions">
        {!incoming?.links && <>
          <Button icon={<FolderOpenOutlined />} disabled={!nativeDesktop || busy} onClick={() => void loadProject('web')}>{t('preview_local_web')}</Button>
          <Button icon={<CheckCircleOutlined />} disabled={!nativeDesktop || busy} onClick={() => void checkMiniProgram()}>{t('preview_check_mini_program')}</Button>
          <Button icon={<MobileOutlined />} disabled={!nativeDesktop || busy} onClick={() => void loadProject('mini')}>{t('preview_mini_program')}</Button>
          {latest && <Button icon={<HistoryOutlined />} onClick={() => setReportOpen(true)}>{t('validation_latest')}</Button>}
        </>}
        {(incoming?.links || capturedIds.length > 0) && <Button
          className="browser-return-assistant" type={capturedIds.length ? 'primary' : 'default'} icon={<ArrowLeftOutlined />}
          disabled={locked || savingCapture} onClick={() => returnToAssistant(capturedIds)}>
          {capturedIds.length ? t('browserCaptureToAssistant', { count: capturedIds.length }) : t('browserReturnAssistant')}
        </Button>}
      </div>
      {incoming?.links && incoming.links.length > 1 && <Select className="browser-link-queue" aria-label={t('browserLinkQueue')}
        value={local?.url ?? incoming.url} disabled={savingCapture}
        options={incoming.links.map(url => {
          const page = new URL(url);
          return { value: url, label: page.host + page.pathname };
        })}
        onChange={url => setLocal({ url, key: crypto.randomUUID() })} />}
    </div>
    <EmbeddedBrowser intake={local ?? incoming} onQualityReport={showWebReport} onCapture={reviewCapture} />
    <Modal title={t('browserCaptureTitle')} open={Boolean(capture)} width={720} onCancel={() => { if (!savingCapture) setCapture(undefined); }}
      okText={t('browserCaptureSave')} cancelText={t('cancel')} onOk={() => void saveCapture()} confirmLoading={savingCapture}
      okButtonProps={{ disabled: locked || !captureTitle.trim() }}>
      {capture && <div className="browser-capture-form">
        <label>{t('browserCaptureName')}<Input value={captureTitle} maxLength={120} disabled={savingCapture}
          onChange={event => setCaptureTitle(event.target.value)} /></label>
        <span className="muted browser-capture-url">{capture.url}</span>
        <label>{t('browserCapturePeriod')}
          <DatePicker.RangePicker format="YYYY-MM-DD" disabled={savingCapture}
            onChange={(dates, formatted) => setCapturePeriod(dates ? formatted : undefined)} />
        </label>
        <p className="muted">{t(capture.selection ? 'browserCaptureSelection' : 'browserCaptureScope')}</p>
        {capture.truncated && <Alert type="warning" showIcon title={t('browserCaptureTruncated')} />}
        <Input.TextArea aria-label={t('browserCapturePreview')} rows={10} readOnly value={capture.text} />
      </div>}
    </Modal>
    <Modal title={t(web ? 'validation_web_result' : 'preview_check_mini_program')} open={reportOpen}
      width={760} onCancel={() => { if (!saveLock.current) setReportOpen(false); }} footer={[
        <Button key="close" disabled={saving} onClick={() => setReportOpen(false)}>{t('cancel')}</Button>,
        saved && saved === latest
          ? <Button key="artifacts" type="primary" onClick={openArtifacts}>{t('validation_open_artifacts')}</Button>
          : <Button key="save" type="primary" icon={<FileExcelOutlined />} loading={saving} disabled={!latest} onClick={() => void saveReport()}>
            {t('validation_save')}</Button>,
      ]}>
      {web && <>
        <Alert type={web.issues.length ? 'warning' : 'success'} showIcon
          title={t(web.issues.length ? 'validation_web_summary' : 'validation_clear', { issues: web.issues.length })}
          description={<>{reportAddress(web.url)} · {web.width} × {web.height} px</>} />
        <p className="validation-scope">{t('validation_web_scope')}{web.truncated && <> {t('validation_truncated')}</>}</p>
        {!!web.issues.length && <Table<BrowserQualityReport['issues'][number]> size="small" dataSource={web.issues}
          rowKey="code" pagination={false} columns={[
            { title: t('mini_program_diagnostic'), render: (_, issue) => t('validation_' + issue.code) },
            { title: t('validation_count'), dataIndex: 'count', width: 72 },
            { title: t('validation_examples'), render: (_, issue) => <span className="validation-evidence">{issue.examples.join('\n')}</span> },
          ]} />}
      </>}
      {mini && <>
        <Alert type={mini.issues.length ? 'warning' : 'success'} showIcon title={t('mini_program_check_result', {
          pages: mini.pages, issues: mini.issues.length,
        })} description={mini.path} />
        <p className="validation-scope">{t('validation_mini_scope')}</p>
        {!!mini.issues.length && <Table<MiniIssue> size="small" dataSource={mini.issues} pagination={{ pageSize: 8 }}
          rowKey={(item, index) => [item.file, item.code, index].join('/')} columns={[
            { title: t('source'), dataIndex: 'file', width: '34%' },
            { title: t('mini_program_diagnostic'), render: (_, issue) => <>{t(issue.code, { defaultValue: issue.code })}{issue.detail && <div className="muted">{issue.detail}</div>}</> },
          ]} />}
      </>}
    </Modal>
  </section>;
}
