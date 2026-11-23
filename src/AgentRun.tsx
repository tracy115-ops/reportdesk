import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, FileOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { App as AntApp, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { errorCode, nativeDesktop, revealAgentFile } from './desktop';
import type { AgentEvent, AgentWorkspaceChanges } from './desktop';

type ToolActivity = Extract<AgentEvent, { kind: 'tool' }>;
export interface AgentRunProgress {
  text: string;
  tools: ToolActivity[];
  connection?: 'waiting' | 'retrying';
}

export function addAgentEvents(previous: AgentRunProgress, events: AgentEvent[]): AgentRunProgress {
  let text = previous.text;
  let connection = previous.connection;
  const tools = new Map(previous.tools.map(item => [item.id, item]));
  for (const event of events) {
    if (event.kind === 'connection') {
      connection = event.retrying ? 'retrying' : 'waiting';
    } else if (event.kind === 'text') {
      text = (event.replace ? event.text : text + event.text).slice(0, 50_000);
    } else if (event.kind === 'tool') {
      const current = tools.get(event.id);
      tools.set(event.id, {
        ...event,
        target: event.target || current?.target || '',
        state: event.state === 'running' && current ? current.state : event.state,
      });
    } else {
      const current = tools.get(event.id);
      if (current) tools.set(event.id, { ...current, state: event.failed ? 'failed' : 'done' });
    }
  }
  return { text, connection, tools: [...tools.values()].slice(-24) };
}

const stateIcons = { running: ClockCircleOutlined, done: CheckCircleOutlined, failed: ExclamationCircleOutlined };

export function AgentActivity({ tools }: { tools: ToolActivity[] }) {
  const { t } = useTranslation();
  if (!tools.length) return null;
  return <details className="agent-run-tools" open>
    <summary>{t('agentToolActivity')}</summary>
    <ul>{tools.map(tool => {
      const Icon = stateIcons[tool.state];
      return <li key={tool.id} data-state={tool.state}>
        <Icon aria-hidden />
        <span>{t(`agentAction_${tool.action}`)}</span>
        {tool.target && <code title={tool.target}>{tool.target}</code>}
        <small>{t(`agentState_${tool.state}`)}</small>
      </li>;
    })}</ul>
  </details>;
}

export function AgentFileChanges({ changes }: { changes?: AgentWorkspaceChanges }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  if (!changes || !changes.files.length && !changes.limited) return null;
  const { folderId } = changes;

  function rows(files: AgentWorkspaceChanges['files']) {
    return <ul>{files.map(file => <li key={file.path}>
      <FileOutlined aria-hidden />
      <span title={file.path}>{file.path}</span>
      <small>{t(file.change === 'created' ? 'agentFileCreated' : 'agentFileModified')}</small>
      {nativeDesktop && <Button type="text" size="small" icon={<FolderOpenOutlined />}
        aria-label={t('agentFileFolderLabel', { path: file.path })} title={t('agentFileFolder')}
        onClick={() => void revealAgentFile(folderId, file.path)
          .catch(error => message.error(t(errorCode(error, 'agent_file_unavailable'))))} />}
    </li>)}</ul>;
  }
  return <section className="agent-file-changes" aria-label={t('agentFileChanges')}>
    <h3>{t('agentFileChanges')}</h3>
    {changes.files.length > 0 && rows(changes.files.slice(0, 5))}
    {changes.files.length > 5 && <details><summary>{t('agentMoreFiles', { count: changes.files.length - 5 })}</summary>
      {rows(changes.files.slice(5))}
    </details>}
    {changes.limited && <p>{t('agentFileScanLimited')}</p>}
  </section>;
}
