import { Alert, App as AntApp, Button, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import App from './App';
import i18n from './i18n';
import { finishWorkspaceRestore, hasPreviousWorkspace, previousWorkspace, savedLanguage, stageWorkspace } from './workspace-data';
import './style.css';
import './workspace.css';
import './assistant.css';

function Workspace({ restored }: { restored: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  useEffect(() => { if (restored) message.success(t('workspaceRestored')); }, [restored]);
  return <App />;
}

function RestoreRecovery({ canUndo }: { canUndo: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function undo() {
    setBusy(true);
    try {
      const previous = await previousWorkspace();
      if (!previous) throw 'backup_invalid';
      await stageWorkspace(previous);
      window.location.reload();
    } catch { setFailed(true); setBusy(false); }
  }
  return <main className="recovery-screen">
    <Alert showIcon type="warning" title={t('workspaceRecoveryTitle')} description={t(failed ? 'storage_error' : 'workspaceRecoveryBody')} />
    <div className="artifact-actions">
      <Button type="primary" disabled={busy} onClick={() => window.location.reload()}>{t('retry')}</Button>
      {canUndo && <Button loading={busy} onClick={() => void undo()}>{t('undoWorkspaceRestore')}</Button>}
    </div>
  </main>;
}

function Root({ restored, recovery }: { restored?: boolean; recovery?: { canUndo: boolean } }) {
  const { i18n, t } = useTranslation();
  const zh = i18n.language === 'zh-CN';
  useEffect(() => {
    dayjs.locale(zh ? 'zh-cn' : 'en');
    document.documentElement.lang = i18n.language;
    document.title = t('brand');
  }, [i18n.language, t, zh]);
  return <ConfigProvider locale={zh ? zhCN : enUS} theme={{
    token: { colorPrimary: '#246b59', colorLink: '#246b59', borderRadius: 7, controlHeight: 36, colorText: '#252b29', colorTextSecondary: '#717873',
      fontFamily: 'Segoe UI, system-ui, Microsoft YaHei UI, sans-serif', colorBorder: '#dfe3dd' },
    components: { Button: { primaryShadow: 'none' }, Segmented: { trackBg: '#f0f2ee', itemSelectedColor: '#246b59' } },
  }}><AntApp message={{ maxCount: 2 }}>{recovery ? <RestoreRecovery canUndo={recovery.canUndo} /> : <Workspace restored={Boolean(restored)} />}</AntApp></ConfigProvider>;
}

const root = createRoot(document.getElementById('root')!);
void (async () => {
  let restored: boolean;
  try { restored = await finishWorkspaceRestore(); }
  catch {
    const canUndo = await hasPreviousWorkspace().catch(() => false);
    root.render(<Root recovery={{ canUndo }} />);
    return;
  }
  if (i18n.language !== savedLanguage()) await i18n.changeLanguage(savedLanguage());
  root.render(<Root restored={restored} />);
})();
