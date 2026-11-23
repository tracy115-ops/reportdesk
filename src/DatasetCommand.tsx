import { useState } from 'react';
import { ArrowRightOutlined, CheckCircleOutlined, DeleteOutlined, FolderOpenOutlined, SendOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Input, Modal, Popconfirm } from 'antd';
import type { ReportProfile } from './domain';
import type { dataWorkbenchZh } from './data-workbench-i18n';
import { planOfficeCommand } from './office-command';
import type { OfficeCommandPlan } from './office-command';
import { readLocal, writeLocal } from './storage';

export type RunDatasetCommand = (id: string, request: string, plan: OfficeCommandPlan) => Promise<boolean>;

interface Props {
  dataset: ReportProfile;
  copy: typeof dataWorkbenchZh;
  busy: boolean;
  engineReady: boolean;
  stageText?: string;
  onRun: RunDatasetCommand;
  openArtifacts: () => void;
}

const formats = { docx: 'Word', xlsx: 'Excel', pptx: 'PPTX', html: 'HTML', pdf: 'PDF' };
interface SavedCommand { id: string; name: string; request: string }

export default function DatasetCommand({ dataset, copy, busy, engineReady, stageText, onRun, openArtifacts }: Props) {
  const { message } = AntApp.useApp();
  const [request, setRequest] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState(() => readLocal<SavedCommand[]>('office-commands', []));
  const [commandName, setCommandName] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<'failed' | 'complete' | 'files'>();
  const instruction = request.trim();
  const plan = instruction ? planOfficeCommand(instruction) : undefined;
  const report = plan?.kind === 'report' ? plan : undefined;
  const period = report?.cadence === 'weekly' ? (report.previous ? copy.lastWeek : copy.thisWeek)
    : (report?.previous ? copy.lastMonth : copy.thisMonth);
  const reportLabel = report?.cadence === 'weekly' ? copy.commandWeeklyReport : copy.commandMonthlyReport;
  const blocked = busy || running || !plan || plan.kind === 'clarify' || (report?.withAgent && !engineReady);

  function change(value: string) {
    setRequest(value);
    setResult(undefined);
  }

  function saveLibrary(items: SavedCommand[]) {
    try { writeLocal('office-commands', items); setLibrary(items); return true; }
    catch { message.error(copy.commandSaveFailed); return false; }
  }

  function applyCommand(value: string) {
    change(value);
    setLibraryOpen(false);
  }

  async function submit() {
    if (blocked || !plan) return;
    setRunning(true);
    setResult(undefined);
    try {
      const completed = await onRun(dataset.id, instruction, plan);
      setResult(completed ? report?.outputs.length ? 'files' : 'complete' : 'failed');
    } catch { setResult('failed'); }
    finally { setRunning(false); }
  }

  return <section className="data-panel data-command" aria-labelledby="dataset-command-title">
    <header className="data-command-heading">
      <h2 id="dataset-command-title"><label htmlFor="dataset-command-input">{copy.commandTitle}</label></h2>
      <div className="data-command-dataset"><span>{copy.reportDataset}</span><strong title={dataset.name}>{dataset.name}</strong></div>
      <Button type="text" icon={<FolderOpenOutlined />} disabled={busy || running} onClick={() => { setCommandName(''); setLibraryOpen(true); }}>
        {copy.commandLibrary}
      </Button>
    </header>
    <Input.TextArea id="dataset-command-input" value={request} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={1200}
      placeholder={copy.commandPrompt} disabled={busy || running} onChange={event => change(event.target.value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void submit();
      }} />
    <div className="data-command-actions">
      <div className="data-command-plan" aria-live="polite">
        {!plan && <div className="data-command-examples">
          {[copy.commandExampleReport, copy.commandExampleMonth].map(example => <Button type="default" size="small" key={example}
            disabled={busy || running} onClick={() => change(example)}>{example}</Button>)}
        </div>}
        {report && <ul className="data-command-steps">
          <li>{copy.commandRefresh}</li>
          <li>{copy.commandSummarize.replace('{{report}}', reportLabel)} <span>· {period}</span></li>
          {report.withAgent && <li>{copy.commandDraft}</li>}
          {!!report.outputs.length && <li>{copy.commandExport.replace('{{files}}', report.outputs.map(format => formats[format]).join(' / '))}</li>}
        </ul>}
        {report?.withAgent && !engineReady && <p className="data-refresh-warning">{copy.commandOffline}</p>}
        {plan?.kind === 'agent' && <p>{copy.commandHandoff}</p>}
        {plan?.kind === 'clarify' && <p className="data-refresh-warning">{plan.reason === 'cadence' ? copy.commandClarifyCadence : copy.commandClarifyPeriod}</p>}
      </div>
      <Button type="primary" icon={plan?.kind === 'agent' ? <ArrowRightOutlined /> : <SendOutlined />}
        iconPlacement="end" loading={running} disabled={blocked} onClick={() => void submit()}>
        {plan?.kind === 'agent' ? copy.commandAgent : copy.commandRun}
      </Button>
    </div>
    {running && <p className="data-command-status" role="status">{stageText || copy.commandRunning}</p>}
    {result === 'failed' && <p className="data-command-status data-refresh-warning" role="alert">{copy.commandFailed}</p>}
    {(result === 'complete' || result === 'files') && <div className="data-command-result" role="status">
      <span><CheckCircleOutlined /> {result === 'files' ? copy.commandFilesReady : copy.commandDone}</span>
      {result === 'files' && <Button type="link" size="small" onClick={openArtifacts}>{copy.artifacts}</Button>}
    </div>}
    <Modal title={copy.commandLibrary} open={libraryOpen} onCancel={() => setLibraryOpen(false)} footer={null}>
      <div className="data-command-library">
        {[copy.commandExampleReport, copy.commandExampleMonth, copy.commandExampleMeeting, copy.commandExampleActions, copy.commandExampleSlides].map(example =>
          <Button key={example} className="data-library-command" onClick={() => applyCommand(example)}>{example}</Button>)}
        {library.map(item => <div className="data-library-saved" key={item.id}>
          <Button className="data-library-command" title={item.request} onClick={() => applyCommand(item.request)}>{item.name}</Button>
          <Popconfirm title={copy.commandDelete} okText={copy.commandDelete} cancelText={copy.cancel}
            onConfirm={() => saveLibrary(library.filter(saved => saved.id !== item.id))}>
            <Button type="text" icon={<DeleteOutlined />} aria-label={`${copy.commandDelete} ${item.name}`} />
          </Popconfirm>
        </div>)}
        {instruction && library.length < 32 && <form className="data-library-save" onSubmit={event => {
          event.preventDefault();
          if (!commandName.trim()) return;
          if (saveLibrary([...library, { id: crypto.randomUUID(), name: commandName.trim(), request: instruction }])) setCommandName('');
        }}>
          <Input value={commandName} maxLength={60} aria-label={copy.commandName} placeholder={copy.commandName}
            onChange={event => setCommandName(event.target.value)} />
          <Button htmlType="submit" disabled={!commandName.trim()}>{copy.commandSave}</Button>
        </form>}
        {library.length >= 32 && <p className="data-command-status">{copy.commandLibraryLimit}</p>}
      </div>
    </Modal>
  </section>;
}
