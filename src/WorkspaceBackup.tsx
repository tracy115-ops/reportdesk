import { DownloadOutlined, HistoryOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BACKUP_EXTENSION, errorCode, nativeDesktop, pickWorkspaceBackup, saveArtifact, ZIP_LIMIT } from './desktop';
import { calendarDate } from './domain';
import { buildWorkspaceBackup, openWorkspaceBackup } from './workspace-backup';
import { captureWorkspace, hasPreviousWorkspace, previousWorkspace, restoreWorkspace } from './workspace-data';
import type { WorkspacePoint } from './workspace-data';

export default function WorkspaceBackup({ close }: { close: () => void }) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [operation, setOperation] = useState<'export' | 'read' | 'restore' | 'undo'>();
  const [backup, setBackup] = useState<WorkspacePoint>();
  const [problem, setProblem] = useState<string>();
  const [canUndo, setCanUndo] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = operation !== undefined;

  useEffect(() => {
    let active = true;
    void hasPreviousWorkspace().then(available => { if (active) setCanUndo(available); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function save() {
    setOperation('export');
    setProblem(undefined);
    try {
      const file = await buildWorkspaceBackup(await captureWorkspace());
      const path = await saveArtifact(t('backupFilename') + ' ' + calendarDate(new Date()) + BACKUP_EXTENSION, file);
      if (path) message.success(t('exported', { path }));
    } catch (error) { setProblem(errorCode(error, 'storage_error')); }
    finally { setOperation(undefined); }
  }

  async function read(file?: File) {
    setOperation('read');
    setProblem(undefined);
    try {
      if (file && file.size > ZIP_LIMIT) throw 'backup_too_large';
      const bytes = file ? await file.arrayBuffer() : await pickWorkspaceBackup();
      if (bytes) setBackup(await openWorkspaceBackup(bytes));
    } catch (error) { setProblem(errorCode(error, 'backup_invalid')); }
    finally { setOperation(undefined); }
  }

  async function restore(undo: boolean) {
    setOperation(undo ? 'undo' : 'restore');
    setProblem(undefined);
    try {
      const point = undo ? await previousWorkspace() : backup;
      if (!point) throw 'backup_invalid';
      await restoreWorkspace(point);
      window.location.reload();
    } catch (error) {
      setProblem(errorCode(error, 'storage_error'));
      setOperation(undefined);
    }
  }

  return <Modal open title={t('workspaceBackup')} width={670} closable={!busy} keyboard={!busy} maskClosable={false}
    onCancel={() => { if (!busy) close(); }}
    footer={backup ? <>
      <Button disabled={busy} onClick={() => { setBackup(undefined); setProblem(undefined); }}>{t('backToBackup')}</Button>
      <Button type="primary" loading={operation === 'restore'} onClick={() => void restore(false)}>{t('restoreBackup')}</Button>
    </> : <Button disabled={busy} onClick={close}>{t('close')}</Button>}>
    <div className="backup-content">
      {problem && <Alert type="error" showIcon title={t(problem, { defaultValue: t('storage_error') })} />}
      {backup ? <>
        <div className="backup-state">
          <strong>{t('backupCreated', { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(backup.createdAt)) })}</strong>
          <p>{t('backupCounts', { files: backup.data.artifacts.length, reports: backup.data.reports.length, tasks: backup.data.tasks.length, sources: backup.sources.length })}</p>
          {backup.data['slide-assets'].length > 0 && <p>{t('backupSlideCount', { count: backup.data['slide-assets'].length })}</p>}
          {backup.data['creative-projects'].length > 0 && <p>{t('creativeBackupCount', { count: backup.data['creative-projects'].length })}</p>}
          {backup.sources.length > 0 && <details><summary>{t('backupSourcePaths')}</summary>
            <ul>{backup.sources.map(source => <li key={source.id}>{source.path}</li>)}</ul>
          </details>}
        </div>
        <Alert showIcon type="info" title={t('backupRestoreInfo')} description={t('backupLinksInfo')} />
      </> : <>
        <p>{t('backupSummary')}</p>
        <p className="muted">{t('backupLinksInfo')}</p>
        <div className="artifact-actions">
          <Button type="primary" icon={<DownloadOutlined />} loading={operation === 'export'} disabled={busy && operation !== 'export'}
            onClick={() => void save()}>{t('exportBackup')}</Button>
          <Button icon={<UploadOutlined />} loading={operation === 'read'} disabled={busy && operation !== 'read'}
            onClick={() => { if (nativeDesktop) void read(); else input.current?.click(); }}>{t('chooseBackup')}</Button>
        </div>
        {canUndo && <div className="backup-undo">
          <Button icon={<HistoryOutlined />} loading={operation === 'undo'} disabled={busy && operation !== 'undo'}
            onClick={() => void restore(true)}>{t('undoWorkspaceRestore')}</Button>
        </div>}
      </>}
    </div>
    {!nativeDesktop && <input ref={input} type="file" accept={BACKUP_EXTENSION} hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void read(file);
    }} />}
  </Modal>;
}
