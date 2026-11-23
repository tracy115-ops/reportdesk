import { ApiOutlined, CheckCircleFilled, CodeOutlined, CopyOutlined, DatabaseOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Modal, Spin, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { nativeDesktop } from './desktop';
import type { AgentCliDetails, AgentEngine } from './desktop';
import { configuredModels, providerEngine, providerTarget } from './provider-client';
import type { ProviderProfile } from './provider-client';
import './agent-settings.css';

export interface AgentSettingsProps {
  open: boolean;
  engine: AgentEngine;
  status: string;
  details?: AgentCliDetails;
  profiles: readonly ProviderProfile[];
  locked?: boolean;
  close: () => void;
  changeEngine: (engine: AgentEngine) => void;
  recheck: () => void;
  manageProviders: () => void;
}

const commands = {
  codex: { install: 'npm install -g @openai/codex', login: 'codex login' },
  claude: { install: 'winget install Anthropic.ClaudeCode', login: 'claude auth login' },
} as const;

const copy = {
  zh: {
    title: 'Agent 设置',
    engine: '默认引擎',
    defaultHint: '用于新会话和工作台。',
    terminal: '本机命令行',
    api: 'API 模型',
    configure: '配置 API 模型',
    active: '已选为默认',
    ready: '连接正常',
    configured: '已配置',
    checking: '检查中',
    missing: '未检测到命令行工具',
    signIn: '缺少登录或 API 凭据',
    failed: '连接失败',
    update: '需要更新命令行工具',
    desktop: '请在桌面版检测连接',
    unconfigured: '请选择已配置的对话模型',
    cliDescription: '使用本机命令行工具对话和执行任务。服务商可以在 CLI 中配置，也可以在左侧添加 API 模型。',
    providerDescription: '使用所配置的 API 服务和文本模型对话、生成内容。',
    install: '安装 CLI',
    login: '使用官方账号登录',
    setup: '安装与连接',
    codexGateway: 'Codex 使用第三方 Responses 服务时，在 CLI 配置服务商，并在对话的「工具」中选择工作目录。',
    claudeGateway: 'Claude Code 可从用户设置或环境变量读取 Anthropic 兼容服务的地址、密钥和模型。',
    terminalHint: '完成配置后重新检测。启动应用的终端会传入其环境变量。',
    copyCommand: '复制命令',
    copied: '命令已复制',
    copyFailed: '请选中文字复制。',
    path: 'CLI 路径',
    version: '版本',
    copyPath: '复制 CLI 路径',
    pathCopied: 'CLI 路径已复制',
    check: '检测连接',
    scope: '任务资料范围',
    excerpts: '按任务选定文件、数据集或知识库。需要发送资料时，可在任务中核对摘录和引用。',
    cliScope: '在对话的「工具」菜单选定工作目录后，CLI 会在该目录运行并使用原生工具。Codex 使用工作区写入权限，Claude Code 按 CLI 权限设置执行。需要交互审批时，可从同一菜单打开原生终端。',
    apiScope: '任务要求、选中的资料摘录和相关对话内容会发送到该模型配置的 API 服务。',
  },
  en: {
    title: 'Agent settings',
    engine: 'Default engine',
    defaultHint: 'Used for new chats and workbench tasks.',
    terminal: 'Local command line',
    api: 'API models',
    configure: 'Configure API models',
    active: 'Selected as default',
    ready: 'Connected',
    configured: 'Configured',
    checking: 'Checking connection',
    missing: 'CLI unavailable',
    signIn: 'Sign-in or API credential needed',
    failed: 'Connection failed',
    update: 'CLI update required',
    desktop: 'Check the connection in the desktop app',
    unconfigured: 'Choose a configured chat model',
    cliDescription: 'Chat and run tasks with your installed CLI. Configure its provider in the CLI or add an API model on the left.',
    providerDescription: 'Chat and create content with the configured API provider and text model.',
    install: 'Install the CLI',
    login: 'Sign in with an official account',
    setup: 'Install and connect',
    codexGateway: 'To use a third-party Responses service, configure its provider in Codex and choose a working folder in the chat Tools menu.',
    claudeGateway: 'Claude Code can read the endpoint, key, and model for an Anthropic-compatible service from user settings or environment variables.',
    terminalHint: 'Check again after setup. The desktop app inherits environment variables from the terminal that launches it.',
    copyCommand: 'Copy command',
    copied: 'Command copied',
    copyFailed: 'Select and copy the text.',
    path: 'CLI path',
    version: 'Version',
    copyPath: 'Copy CLI path',
    pathCopied: 'CLI path copied',
    check: 'Check connection',
    scope: 'Task data scope',
    excerpts: 'Choose files, a dataset, or a knowledge base for each task. Review the excerpts and citations in the task before sending material.',
    cliScope: 'Choose a working folder from Tools to run the CLI there with native tools. Codex uses workspace write access. Claude Code follows its CLI permissions. Open the native terminal from the same menu for interactive approvals.',
    apiScope: 'Office requests, selected excerpts, and relevant conversation context are sent to the API service configured for this model.',
  },
};

export default function AgentSettings({ open, engine, status, details, profiles, locked, close, changeEngine, recheck, manageProviders }: AgentSettingsProps) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const labels = i18n.language.startsWith('zh') ? copy.zh : copy.en;
  const cli = engine === 'codex' || engine === 'claude' ? engine : undefined;
  const target = engine === 'codex' || engine === 'claude' ? undefined : providerTarget(engine);
  const provider = target && profiles.find(item => item.id === target.id);
  const model = target?.modelId ?? provider?.textModel;
  const available = Boolean(provider && model && configuredModels(provider).includes(model));
  const engineName = cli === 'codex' ? 'Codex' : cli === 'claude' ? 'Claude Code' : provider?.name ?? labels.api;
  const ready = nativeDesktop && status === 'codex_ready';
  const checking = nativeDesktop && status === 'codex_checking';
  const connectionText = !nativeDesktop ? labels.desktop : checking ? labels.checking : ready ? labels.ready
    : !cli ? !available ? labels.unconfigured : status === 'provider_configured' ? labels.configured : t(status, { defaultValue: labels.failed })
    : status === 'codex_missing' ? labels.missing
    : status === 'codex_login' || status === 'codex_auth' ? labels.signIn
    : status === 'codex_version' ? labels.update : labels.failed;
  const connectionTone = ready ? 'ready' : checking || !nativeDesktop || status === 'provider_configured' ? 'neutral' : 'attention';
  const cliCommands = cli ? commands[cli] : undefined;
  const installation = cli && !checking && details?.status === status ? details : undefined;

  const copyText = async (value: string, confirmation: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(confirmation);
    } catch { message.info(labels.copyFailed); }
  };

  function option(value: AgentEngine, name: string, model?: string) {
    const selected = value === engine;
    return <button key={value} type="button" className="agent-settings-option" aria-pressed={selected} disabled={locked}
      onClick={() => { if (!selected) changeEngine(value); }}>
      <span className="agent-settings-option-icon" aria-hidden>{value.startsWith('provider:') ? <ApiOutlined /> : <CodeOutlined />}</span>
      <span className="agent-settings-option-text"><strong title={name}>{name}</strong>{model && <small title={model}>{model}</small>}</span>
      {selected && <CheckCircleFilled className="agent-settings-active" aria-label={labels.active} />}
    </button>;
  }

  return <Modal open={open} className="agent-settings-modal" title={labels.title} width={680} onCancel={close}
    footer={<Button onClick={close}>{t('close')}</Button>}>
    <div className="agent-settings-layout">
      <div className="agent-settings-engines">
        <h2>{labels.engine}</h2>
        <p className="agent-settings-default-hint">{labels.defaultHint}</p>
        <div className="agent-settings-options">{option('codex', 'Codex', labels.terminal)}{option('claude', 'Claude Code', labels.terminal)}</div>
        <div className="agent-settings-providers">
          <h3>{labels.api}</h3>
          <div className="agent-settings-options">{profiles.flatMap(item => configuredModels(item).map(id =>
            option(providerEngine(item.id, id), id, item.name)))}</div>
          <Button className="agent-settings-manage" type="text" icon={<SettingOutlined />} onClick={manageProviders} disabled={locked}>{labels.configure}</Button>
        </div>
      </div>
      <section className="agent-settings-detail" aria-label={engineName}>
        <div className="agent-settings-detail-head">
          <div><h2>{engineName}</h2>{model && <p className="agent-settings-model" title={model}>{model}</p>}</div>
          <span className="agent-settings-status" data-tone={connectionTone} role="status">
            {checking ? <Spin size="small" /> : <i aria-hidden />}{connectionText}
          </span>
        </div>
        <p>{cli ? labels.cliDescription : labels.providerDescription}</p>
        {(installation?.path || installation?.version) && <dl className="agent-settings-installation">
          {installation.version && <div><dt>{labels.version}</dt><dd>{installation.version}</dd></div>}
          {installation.path && <div><dt>{labels.path}</dt><dd>
            <code title={installation.path}>{installation.path}</code>
            <Tooltip title={labels.copyPath}><Button size="small" type="text" aria-label={labels.copyPath} icon={<CopyOutlined />}
              onClick={() => void copyText(installation.path!, labels.pathCopied)} /></Tooltip>
          </dd></div>}
        </dl>}
        <Button className="agent-settings-check" icon={<ReloadOutlined />} loading={checking}
          disabled={!nativeDesktop || locked || (!cli && !available)} onClick={recheck}>{labels.check}</Button>
        {cliCommands && <details className="agent-settings-setup" key={cli} open={!ready || undefined}>
          <summary>{labels.setup}</summary>
          <div className="agent-settings-steps">
            {([{ label: labels.install, command: cliCommands.install }, { label: labels.login, command: cliCommands.login }]).map(({ label, command }) =>
              <div key={command} className="agent-settings-step">
                <span>{label}</span>
                <div className="agent-settings-command">
                  <code>{command}</code>
                  <Tooltip title={labels.copyCommand}><Button type="text" size="small" icon={<CopyOutlined />}
                    aria-label={labels.copyCommand + ' · ' + label} onClick={() => void copyText(command, labels.copied)} /></Tooltip>
                </div>
              </div>)}
          </div>
          <p>{cli === 'codex' ? labels.codexGateway : labels.claudeGateway}</p>
          <p>{labels.terminalHint}</p>
        </details>}
        <section className="agent-settings-scope">
          <DatabaseOutlined aria-hidden />
          <div><h3>{labels.scope}</h3><p>{labels.excerpts}</p><p>{cli ? labels.cliScope : labels.apiScope}</p></div>
        </section>
      </section>
    </div>
  </Modal>;
}
