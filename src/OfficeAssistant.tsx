import { ArrowUpOutlined, BranchesOutlined, CloseOutlined, CodeOutlined, CopyOutlined, DatabaseOutlined, DownloadOutlined, EditOutlined, EllipsisOutlined, EyeOutlined, FilePptOutlined, FileWordOutlined, FolderOpenOutlined, GlobalOutlined, HistoryOutlined, LinkOutlined, MessageOutlined, PlusOutlined, ThunderboltOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Drawer, Dropdown, Grid, Input, Modal, Select, Spin, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelPolish, chatWithAgent, errorCode, isAgentEngine, nativeDesktop, openAgentFolder, openAgentTerminal, pickAgentFolder, runOffice } from './desktop';
import type { AgentEngine, AgentOptionGroup, AgentWorkspaceChanges } from './desktop';
import type { AgentConnection } from './agent-connections';
import { evidenceSignature, quickPeriod } from './domain';
import type { ArtifactKind, Evidence, Loaded, Locale } from './domain';
import { assistantConversationTitle, assistantInput, assistantPresets, assistantVersion, conversationPath, conversationVersions, datasetExcerpts, deleteTask, storedTasks, storeTask, storeTaskResult, taskVersions } from './office';
import type { Artifact, AssistantDatasetScope, AssistantDraft, AssistantReference, AssistantTask, AssistantVersion, Format, NewArtifact, OfficeDraft } from './office';
import { makeSlides, makeWord } from './office-output';
import { readLocal, writeLocal } from './storage';
import { retrieveAssistantEvidence } from './assistant-retrieval';
import type { KnowledgeModel } from './knowledge-index';
import type { AssistantRetrieval } from './office';
import AssistantMaterials, { maximumAttachments } from './AssistantMaterials';
import AssistantConversations from './AssistantConversations';
import AssistantReply from './AssistantReply';
import { addAgentEvents, AgentActivity, AgentFileChanges } from './AgentRun';
import type { AgentRunProgress } from './AgentRun';
import type { CreativeIntake } from './creative-project';
import { assistantCommands, readAssistantCommand } from './office-command';
import type { OfficeCommandPlan } from './office-command';

const reportFormats: Partial<Record<ArtifactKind, string>> = { docx: 'Word', xlsx: 'Excel', pptx: 'PPTX', html: 'HTML', pdf: 'PDF' };

function blankTask(locale: Locale): AssistantTask {
  return { id: crypto.randomUUID(), request: '', locale, format: 'answer', attachments: [], revise: false, status: 'idle', updatedAt: new Date().toISOString() };
}

function resumeTask(saved: AssistantTask, defaultEngine: AgentEngine): AssistantTask {
  const task = isAgentEngine(saved.engine) ? saved : { ...saved, engine: saved.status === 'idle' ? undefined : defaultEngine };
  if (task.status === 'running') return { ...task, status: 'interrupted' };
  if (task.draft && task.status === 'complete' && !task.revise && task.submittedRequest === undefined) {
    return { ...task, submittedRequest: task.request, request: '', revise: true };
  }
  return task;
}

function TaskProgress({ label, since }: { label: string; since?: number }) {
  const { t } = useTranslation();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return <div className="assistant-result-status">
    <span role="status"><Spin size="small" /> {label}</span>
    {since !== undefined && <time>{t('assistantElapsed', { seconds })}</time>}
  </div>;
}

function UserMessage({ request, branch, disabled }: { request: string; branch?: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return <div className="assistant-user-message">
    <span className="sr-only">{t('conversationYou')}</span>
    {branch && <Tooltip title={t('assistantBranchRetry')}>
      <Button className="assistant-message-branch" type="text" size="small" icon={<EditOutlined />} disabled={disabled}
        aria-label={t('assistantBranchRetry')} onClick={branch} />
    </Tooltip>}
    <p>{request}</p>
  </div>;
}

function ReplyAuthor({ model, incomplete }: { model?: string; incomplete?: boolean }) {
  const { t } = useTranslation();
  return <div className="assistant-message-meta assistant-answer-meta">
    <span className="assistant-answer-mark"><ThunderboltOutlined aria-hidden /></span><strong>{t('assistant')}</strong>
    {model && <span className="assistant-reply-model" title={model}>{model}</span>}
    {incomplete && <span className="assistant-incomplete">{t('assistantIncompleteReply')}</span>}
  </div>;
}

function ReplyContent({ draft, show }: { draft: AssistantDraft; show: (ref: Evidence) => void }) {
  return <>
    {draft.value.sections.map((part, index) => <section key={index} className="assistant-reply-section">
      {draft.value.sections.length > 1 && part.heading && <div className="assistant-reply-heading" role="heading" aria-level={3}>
        <AssistantReply text={part.heading} refs={draft.refs} show={show} />
      </div>}
      <AssistantReply text={part.text} refs={draft.refs} show={show} />
    </section>)}
    <AgentFileChanges changes={draft.changes} />
  </>;
}

interface Props {
  files: Loaded[];
  agentBusy: boolean;
  defaultEngine: AgentEngine;
  engineOptions: AgentOptionGroup[];
  engineLocked: boolean;
  resolveAgent: (engine: AgentEngine) => AgentConnection;
  prepareEngine: (engine: AgentEngine) => Promise<void>;
  recheckEngine: (engine: AgentEngine) => void;
  openAgentSettings: () => void;
  openKnowledge?: (scope: AssistantDatasetScope, addExcerpts: (items: Evidence[]) => void) => void;
  knowledgeModels?: readonly KnowledgeModel[];
  running: boolean;
  setRunning: (running: boolean) => void;
  setWriting: (writing: boolean) => void;
  pick: (folder: boolean) => void;
  previewMaterial: (id: string) => void;
  artifacts: Artifact[];
  deliver: (files: NewArtifact[], group: string) => Promise<Artifact[]>;
  preview: (id: string) => void;
  saveFile: (item: Artifact) => Promise<void>;
  exporting: boolean;
  show: (ref: Evidence) => void;
  reference?: AssistantReference;
  clearReference: () => void;
  showSourcesLoading: boolean;
  openCreative: (intake?: CreativeIntake) => void;
  newTaskSignal: number;
  openLibrary: () => void;
  openArtifacts: () => void;
  openTaskId?: string;
  clearOpenTask?: () => void;
  onTasksChange?: (tasks: AssistantTask[]) => void;
  runDatasetCommand?: (id: string, request: string, plan: OfficeCommandPlan, agent: AgentConnection) => Promise<boolean>;
  datasetCommandBusy?: boolean;
  renderTaskContext?: (context: {
    dataset?: AssistantDatasetScope;
    filenames: string[];
    retrievalActive: boolean;
    locked: boolean;
    hasDraft: boolean;
    showScope: (scope?: AssistantDatasetScope) => void;
  }) => ReactNode;
}

export default function OfficeAssistant({ files, agentBusy, defaultEngine, engineOptions, engineLocked, resolveAgent, prepareEngine, recheckEngine,
  openAgentSettings, openKnowledge, knowledgeModels = [], running, setRunning, setWriting, pick, previewMaterial,
  artifacts, deliver, preview, saveFile, exporting, show, reference, clearReference, showSourcesLoading, openCreative,
  newTaskSignal, openLibrary, openArtifacts, openTaskId, clearOpenTask, onTasksChange, runDatasetCommand, datasetCommandBusy, renderTaskContext }: Props) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [task, setTask] = useState(() => {
    const saved = readLocal('active-assistant', blankTask(i18n.language as Locale));
    return resumeTask(saved, defaultEngine);
  });
  const { request, locale, draft, attachments, dataset, agentFolder } = task;
  const agent = resolveAgent(task.engine ?? defaultEngine);
  const { engine, name: engineName, status: engineStatus } = agent;
  const hasCodex = agent.ready && !agentBusy;
  const replyModel = agent.profile ? `${agent.profile.name} · ${engineName}` : engineName;
  const [history, setHistory] = useState<AssistantTask[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [savingConversation, setSavingConversation] = useState(false);
  const changingConversation = useRef(false);
  const dockHistory = Boolean(Grid.useBreakpoint().xl);
  const [editing, setEditing] = useState<OfficeDraft>();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningReport, setRunningReport] = useState(false);
  const [versionHistory, setVersionHistory] = useState<{ taskId: string; entries: AssistantVersion[] }>();
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [versionPreview, setVersionPreview] = useState<AssistantVersion>();
  const [inputPreview, setInputPreview] = useState<Pick<ReturnType<typeof assistantInput>, 'refs' | 'unread' | 'conversation' | 'includesDraft'> & { degraded?: boolean }>();
  const [previewingInput, setPreviewingInput] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [phase, setPhase] = useState<'retrieve' | 'draft' | 'files'>('draft');
  const inputOperation = useRef<AbortController | undefined>(undefined);
  const [started, setStarted] = useState<number>();
  const [runProgress, setRunProgress] = useState<AgentRunProgress>();
  const [stopping, setStopping] = useState(false);
  const requestRef = useRef<React.ComponentRef<typeof Input.TextArea>>(null);
  const resultRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  const scrollToTask = useRef<string | undefined>(undefined);
  const followReply = useRef(true);
  const locked = running || creating || saving || runningReport;
  const switchingBlocked = locked || previewingInput || pickingFolder || savingConversation || Boolean(datasetCommandBusy);
  const stoppedReply = !running && (task.status === 'failed' || task.status === 'interrupted') ? task.interruptedReply : undefined;
  const pinned = useMemo(() => dataset && task.pinned ? datasetExcerpts(dataset, task.pinned) : task.pinned ?? [], [dataset, task.pinned]);
  const imported = useMemo(() => files.filter(file => file.parsed), [files]);
  const scopedFiles = useMemo(() => {
    if (!dataset) return files;
    const allowed = new Set(dataset.materialIds);
    return files.filter(file => allowed.has(file.material.id));
  }, [dataset, files]);
  const availableFiles = dataset ? scopedFiles.filter(file => file.parsed) : imported;
  const retrieval: AssistantRetrieval = dataset ? task.retrieval ?? 'attachments' : 'attachments';
  const retrievalActive = retrieval !== 'attachments';
  const selected = availableFiles.filter(file => attachments.includes(file.material.id));
  const missing = attachments.length - selected.length;
  const outputs = task.delivery ? artifacts.filter(item => item.group === task.delivery) : [];
  const hasContents = Boolean(task.request.trim() || task.draft || attachments.length || pinned.length || dataset || agentFolder || task.conversationTitle || task.conversationPinnedAt);
  const availableTasks = useMemo(() => {
    const archived = history.filter(item => item.id !== task.id);
    return hasContents ? [task, ...archived] : archived;
  }, [task, history, hasContents]);
  const versions = versionHistory?.taskId === task.id ? versionHistory.entries : undefined;
  const turns = useMemo(() => conversationVersions(versions ?? []), [versions]);
  const thread = useMemo(() => conversationPath(turns, task.delivery), [turns, task.delivery]);
  const activeTurn = task.delivery ? turns.get(task.delivery) : undefined;
  const forkFrom = task.forkFromId ? turns.get(task.forkFromId) : undefined;
  const parentId = forkFrom ? forkFrom.parentId ?? null : task.delivery ?? null;
  const historyLoading = Boolean(draft && !versions);
  const command = readAssistantCommand(request);
  const format = command?.format ?? task.format;
  const inputRequest = command?.format ? command.text : request.trim();
  const usingMaterials = retrievalActive || attachments.length > 0 || pinned.length > 0 || Boolean(dataset && format !== 'answer');
  const readyMaterials = !historyLoading && (!usingMaterials || !showSourcesLoading) && (retrievalActive
    ? availableFiles.length > 0 || pinned.length > 0
    : !missing && (!dataset || format === 'answer' || selected.length > 0 || pinned.length > 0));
  const canRun = !switchingBlocked && hasCodex && Boolean(inputRequest) && readyMaterials;
  const datasetPlan = command?.plan;
  const needsReportScope = Boolean(!dataset && datasetPlan?.kind === 'report');
  const reportPlan = datasetPlan?.kind === 'report' ? datasetPlan : undefined;
  const reportPeriod = reportPlan && quickPeriod(reportPlan.cadence, reportPlan.previous);
  const clarifyReport = datasetPlan?.kind === 'clarify' ? datasetPlan.reason : undefined;
  const canSubmit = !datasetCommandBusy && !clarifyReport && !needsReportScope
    && (reportPlan ? Boolean(dataset && runDatasetCommand && !switchingBlocked && !showSourcesLoading && (!reportPlan.withAgent || hasCodex)) : canRun);
  const nativeEngine = nativeDesktop && (engine === 'codex' || engine === 'claude') ? engine : undefined;
  const workspace = nativeEngine && format === 'answer' && !reportPlan ? agentFolder : undefined;
  const zh = i18n.language.startsWith('zh');
  const commandPrefix = /^\/([^\s]*)$/.exec(request.trimStart())?.[1]?.toLowerCase();
  const commandChoices = commandPrefix === undefined ? assistantCommands
    : assistantCommands.filter(item => item.aliases.some(alias => alias.startsWith(commandPrefix)));
  const inTask = Boolean(draft || running || task.status === 'failed' || task.status === 'interrupted');
  const chatReply = draft?.format === 'answer';
  const inlineTaskContext = !dataset && !workspace;
  const earlier = thread.slice(0, -1);
  const [scopePickerVersion, setScopePickerVersion] = useState(0);
  const seenNewTask = useRef(newTaskSignal);

  useEffect(() => { void prepareEngine(engine); }, [engine, prepareEngine]);
  useEffect(() => {
    if (task.engine && task.engine !== engine) setActive({ ...task, engine });
  }, [task, engine]);
  useEffect(() => {
    if (seenNewTask.current === newTaskSignal || switchingBlocked || changingConversation.current) return;
    seenNewTask.current = newTaskSignal;
    void startTask();
  }, [newTaskSignal, switchingBlocked]);

  useEffect(() => {
    if (dockHistory) setHistoryOpen(false);
  }, [dockHistory]);

  useEffect(() => {
    if (scrollToTask.current !== task.id || historyLoading) return;
    scrollToTask.current = undefined;
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [task.id, historyLoading]);

  useEffect(() => () => inputOperation.current?.abort('codex_cancelled'), [task.id]);

  useEffect(() => { setWriting(creating || saving || savingConversation); }, [creating, saving, savingConversation, setWriting]);

  useEffect(() => {
    let active = true;
    void storedTasks()
      .then(items => {
        if (active) setHistory(current => [...current, ...items.filter(item => !current.some(saved => saved.id === item.id))]);
      })
      .catch(() => { if (active) message.error(t('storage_error')); })
      .finally(() => { if (active) setHistoryReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (historyReady) onTasksChange?.(availableTasks);
  }, [historyReady, onTasksChange, availableTasks]);

  useEffect(() => {
    if (!openTaskId || switchingBlocked || changingConversation.current) return;
    const item = availableTasks.find(item => item.id === openTaskId);
    if (!item && !historyReady) return;
    if (item) void openTask(item);
    else message.warning(t('assistantTaskUnavailable'));
    clearOpenTask?.();
  }, [openTaskId, switchingBlocked, historyReady, availableTasks, clearOpenTask]);

  useEffect(() => {
    if (!reference || switchingBlocked || changingConversation.current || showSourcesLoading) return;
    if ('dataset' in reference) {
      const scope = {
        ...reference.dataset,
        sourceIds: [...new Set(reference.dataset.sourceIds)],
        materialIds: [...new Set(reference.dataset.materialIds)],
      };
      const allowed = new Set(scope.materialIds);
      const readable = reference.pinned ? [] : imported.filter(file => allowed.has(file.material.id));
      void startTask({
        dataset: scope,
        request: reference.request ?? '',
        format: reference.format ?? 'answer',
        pinned: reference.pinned && datasetExcerpts(scope, reference.pinned),
        attachments: readable.length <= maximumAttachments ? readable.map(file => file.material.id) : [],
      }, readable.length <= maximumAttachments);
    } else if ('analysis' in reference) {
      void startTask({ request: t('analysisReportRequest'), format: 'bundle', pinned: [reference.analysis] });
    } else if ('materialIds' in reference) {
      const files = reference.materialIds.filter(id => imported.some(item => item.material.id === id));
      if (!files.length) message.warning(t('source_unavailable'));
      else {
        const combined = [...new Set(reference.preset || dataset ? files : [...attachments, ...files])];
        const next = combined.slice(0, maximumAttachments);
        if (reference.preset) {
          const preset = assistantPresets[reference.preset];
          void startTask({ request: t(preset.request), format: preset.format, attachments: next });
        } else if (dataset) {
          void startTask({ attachments: next });
        } else if (next.length !== attachments.length) {
          update({ attachments: next });
          message.success(t('attachmentAdded'));
        }
        if (combined.length > maximumAttachments) message.warning(t('assistantFileLimit'));
      }
    } else if (dataset) {
      void startTask({ pinned: [reference.evidence] });
    } else {
      const signature = evidenceSignature(reference.evidence);
      if (!pinned.some(item => evidenceSignature(item) === signature)) {
        update({ pinned: [...pinned, reference.evidence] });
        message.success(t('attachmentAdded'));
      }
    }
    clearReference();
  }, [reference, switchingBlocked, showSourcesLoading]);

  useEffect(() => {
    if (!draft) return;
    let active = true;
    void taskVersions(task.id).then(entries => {
      if (!active) return;
      const current = assistantVersion(task);
      setVersionHistory({ taskId: task.id, entries: current && !entries.some(entry => entry.id === current.id) ? [current, ...entries] : entries });
    }).catch(() => {
      if (active) {
        const current = assistantVersion(task);
        setVersionHistory({ taskId: task.id, entries: current ? [current] : [] });
        message.error(t('storage_error'));
      }
    });
    return () => { active = false; };
  }, [task.id, task.delivery]);

  useEffect(() => {
    if (running && followReply.current) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [running, phase, runProgress]);

  function setActive(next: AssistantTask) {
    setTask(next);
    try { writeLocal('active-assistant', next); }
    catch { message.error(t('storage_error')); }
  }

  function update(patch: Partial<AssistantTask>) {
    setActive({ ...task, ...patch, updatedAt: new Date().toISOString() });
  }

  function changeEngine(next: AgentEngine) {
    if (engineLocked || switchingBlocked || changingConversation.current || next === engine) return;
    update({ engine: next });
  }

  async function archive(next: AssistantTask) {
    try {
      await storeTask(next);
      setHistory(items => [next, ...items.filter(item => item.id !== next.id)]);
      return true;
    } catch {
      message.error(t('storage_error'));
      return false;
    }
  }

  async function commitResult(result: AssistantTask, version: AssistantVersion, before: AssistantTask) {
    const title = before.conversationTitle || (before.draft && assistantConversationTitle(before)) || assistantConversationTitle(result);
    const next = { ...result, conversationTitle: title || undefined };
    setSaving(true);
    try {
      await storeTaskResult(next, version, assistantVersion(before));
      setHistory(items => [next, ...items.filter(item => item.id !== next.id)]);
    } catch { message.error(t('storage_error')); }
    finally {
      setVersionHistory(current => ({
        taskId: next.id,
        entries: [version, ...(current?.taskId === next.id ? current.entries.filter(item => item.id !== version.id) : [])],
      }));
      setActive(next);
      setSaving(false);
    }
    return next;
  }

  async function prepareInput(signal: AbortSignal) {
    const ancestry = conversationPath(turns, parentId);
    const history = ancestry.length || forkFrom ? ancestry : undefined;
    const previous = forkFrom ? undefined : draft;
    if (dataset && retrieval !== 'attachments') {
      if (!inputRequest) throw 'assistant_rag_request';
      const found = await retrieveAssistantEvidence(dataset.id, retrieval, availableFiles, inputRequest, knowledgeModels, signal);
      signal.throwIfAborted();
      if (!found.refs.length && !pinned.length) throw 'assistant_rag_empty';
      return { ...assistantInput(inputRequest, format, availableFiles, pinned, previous, history, found.refs), degraded: found.degraded };
    }
    return { ...assistantInput(inputRequest, format, selected, pinned, previous, history), degraded: false };
  }

  async function reviewInput() {
    if (!readyMaterials || inputOperation.current) return;
    const controller = new AbortController();
    inputOperation.current = controller;
    setPreviewingInput(true);
    try {
      const input = await prepareInput(controller.signal);
      if (!controller.signal.aborted) setInputPreview(input);
    } catch (error) {
      if (!controller.signal.aborted) message.warning(t(errorCode(error, 'assistant_input_too_large')));
    } finally {
      inputOperation.current = undefined;
      setPreviewingInput(false);
    }
  }

  function stopCurrent() {
    if (stopping) return;
    setStopping(true);
    if (inputOperation.current) inputOperation.current.abort('codex_cancelled');
    else void cancelPolish().catch(() => {
      setStopping(false);
      message.error(t('codex_failed', { engine: engineName }));
    });
  }

  async function execute() {
    if (!canRun || changingConversation.current || inputOperation.current) return;
    const controller = new AbortController();
    inputOperation.current = controller;
    followReply.current = true;
    setRunProgress(undefined);
    setStopping(false);
    setRunning(true);
    setPhase(retrieval === 'attachments' ? 'draft' : 'retrieve');
    setStarted(Date.now());
    let input: Awaited<ReturnType<typeof prepareInput>>;
    try {
      input = await prepareInput(controller.signal);
      controller.signal.throwIfAborted();
      if (input.unread.length) {
        message.warning(t('unreadableAttachments', { names: input.unread.join(', ') }));
        setRunning(false);
        return;
      }
    } catch (error) {
      if (!controller.signal.aborted) message.warning(t(errorCode(error, 'assistant_input_too_large')));
      setRunning(false);
      return;
    } finally {
      inputOperation.current = undefined;
      if (controller.signal.aborted) setStopping(false);
    }
    if (input.degraded) message.info(t('assistant_rag_degraded'));
    const { payload, refs } = input;
    setPhase('draft');
    const current: AssistantTask = { ...task, engine, status: 'running', error: undefined, failedChanges: undefined, updatedAt: new Date().toISOString() };
    setActive(current);
    let acceptingProgress = true;
    let progress: AgentRunProgress = { text: '', tools: [] };
    let changes: AgentWorkspaceChanges | undefined;
    try {
      let result: AssistantDraft;
      if (format === 'answer') {
        const reply = await chatWithAgent(payload, engine, workspace, events => {
          if (acceptingProgress) {
            progress = addAgentEvents(progress, events);
            setRunProgress(progress);
          }
        });
        changes = reply.changes;
        if (reply.error || !reply.text) throw reply.error ?? 'codex_output';
        const title = inputRequest.replace(/\s+/g, ' ').slice(0, 72);
        result = { value: { title, sections: [{ heading: '', text: reply.text }] }, reply: true, deniedTools: reply.deniedTools,
          changes, refs, language: locale, format, model: replyModel };
      } else {
        const value = await runOffice(payload, locale, engine);
        const allowed = new Set(refs.map(ref => ref.id));
        const clean = (text: string) => text.replace(/\[(S\d+)\]/g, (match, id: string) => allowed.has(id) ? match : '');
        result = { value: { title: clean(value.title), sections: value.sections.map(section => ({ heading: clean(section.heading), text: clean(section.text) })) },
          refs, language: locale, format, model: replyModel };
      }
      const next: AssistantTask = { ...current, status: 'complete', revise: true, request: '', submittedRequest: current.request.trim(), forkFromId: undefined,
        updatedAt: new Date().toISOString(), delivery: crypto.randomUUID(),
        deliveryError: undefined, retryKinds: undefined, interruptedReply: undefined, format: 'answer', draft: result };
      acceptingProgress = false;
      const committed = await commitResult(next, assistantVersion(next, 'generatedVersion', parentId)!, task);
      setRunProgress(undefined);
      if (format === 'pptx') {
        openCreative({ draft: next.draft!.value, refs, locale, brief: current.request.trim() });
      } else if (format !== 'answer') {
        setPhase('files');
        await createFiles(committed, format === 'bundle' ? ['docx', 'pptx'] : [format]);
      }
      focusResult();
    } catch (error) {
      const code = errorCode(error, 'codex_failed');
      acceptingProgress = false;
      const text = progress.text.trim();
      const interruptedReply = text ? { request: current.request.trim(), text, model: replyModel } : current.interruptedReply;
      const next: AssistantTask = { ...current, status: 'failed', error: code, failedChanges: changes, interruptedReply, updatedAt: new Date().toISOString() };
      setActive(next);
      await archive(next);
    } finally {
      acceptingProgress = false;
      setRunProgress(undefined);
      setStopping(false);
      setRunning(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    if (!reportPlan || !dataset || !runDatasetCommand) return execute();
    setRunningReport(true);
    try {
      if (await runDatasetCommand(dataset.id, request.trim(), reportPlan, agent)) update({ engine, request: '', interruptedReply: undefined });
    } catch { message.error(t('assistantReportFailed')); }
    finally { setRunningReport(false); }
  }

  async function createFiles(target: AssistantTask, kinds: ('docx' | 'pptx')[], saveAs = false) {
    if (!target.draft || !target.delivery) return;
    const draft: AssistantDraft = target.draft;
    setCreating(true);
    let next: AssistantTask;
    let output: Artifact[] = [];
    try {
      const text = draft.value.sections.map(part => `${part.heading}\n${part.text}`).join('\n');
      const refs = draft.refs.filter(ref => text.includes(`[${ref.id}]`));
      const files = await Promise.all(kinds.map(async kind => ({ title: draft.value.title, kind,
        file: kind === 'docx' ? await makeWord(draft.value, draft.language, refs) : await makeSlides(draft.value, refs, draft.language),
        detail: draft.value.sections[0]?.text.slice(0, 160) ?? '' })));
      output = await deliver(files, target.delivery);
      next = { ...target, deliveryError: undefined, retryKinds: undefined };
    } catch (error) {
      next = { ...target, deliveryError: errorCode(error, 'export_failed'), retryKinds: kinds };
    }
    try {
      setActive(next);
      await archive(next);
      if (saveAs && output[0]) await saveFile(output[0]);
    }
    finally { setCreating(false); }
  }

  function build(kinds: ('docx' | 'pptx')[], saveAs = false) {
    if (!draft || locked) return;
    const next = { ...task, delivery: task.delivery ?? crypto.randomUUID() };
    void createFiles(next, kinds, saveAs);
  }

  async function writeConversation(operation: () => Promise<boolean>) {
    if (switchingBlocked || changingConversation.current || inputOperation.current) return false;
    changingConversation.current = true;
    setSavingConversation(true);
    try {
      return await operation();
    } finally {
      changingConversation.current = false;
      setSavingConversation(false);
    }
  }

  function switchConversation(next: AssistantTask, focus: boolean) {
    return writeConversation(async () => {
      if (hasContents && !await archive(task)) return false;
      setEditing(undefined);
      setSourcesOpen(false);
      setInputPreview(undefined);
      setVersionsOpen(false);
      setVersionPreview(undefined);
      scrollToTask.current = next.id;
      setActive(next);
      if (focus) focusRequest();
      return true;
    });
  }

  function startTask(patch: Partial<AssistantTask> = {}, focus = true) {
    return switchConversation({ ...blankTask(i18n.language as Locale), ...patch }, focus);
  }

  function showScope(scope?: AssistantDatasetScope) {
    if (switchingBlocked || inputOperation.current || scope?.id === dataset?.id) return;
    const allowed = new Set(scope?.materialIds ?? []);
    const readable = scope ? imported.filter(file => allowed.has(file.material.id)) : [];
    const chooseFiles = readable.length > maximumAttachments;
    const patch = {
      dataset: scope,
      retrieval: 'attachments' as const,
      attachments: chooseFiles ? [] : readable.map(file => file.material.id),
      pinned: undefined,
    };
    if (draft) void startTask({ ...patch, request, format: task.format, locale, agentFolder }, !chooseFiles);
    else {
      update(patch);
      if (!chooseFiles) focusRequest();
    }
    setScopePickerVersion(current => current + 1);
  }

  async function saveEdit(value: OfficeDraft) {
    if (switchingBlocked || historyLoading || forkFrom) return;
    if (draft && JSON.stringify(value) === JSON.stringify(draft.value)) { setEditing(undefined); return; }
    const revised = { ...(draft ?? { refs: [], language: locale, format }), value };
    const next: AssistantTask = { ...task, engine, status: 'complete', revise: true, error: undefined,
      request: draft ? task.request : '', submittedRequest: draft ? task.submittedRequest : task.request.trim() || undefined,
      draft: revised, interruptedReply: undefined, delivery: crypto.randomUUID(), deliveryError: undefined, retryKinds: undefined, updatedAt: new Date().toISOString() };
    const committed = await commitResult(next, assistantVersion(next, 'editedVersion', activeTurn?.parentId ?? null)!, task);
    setEditing(undefined);
    const kinds = (['docx', 'pptx'] as const).filter(kind => revised.format === kind || revised.format === 'bundle' || outputs.some(file => file.kind === kind));
    if (kinds.length) await createFiles(committed, kinds);
    focusResult();
  }

  async function restoreVersion(version: AssistantVersion) {
    if (switchingBlocked) return;
    const next: AssistantTask = { ...task, ...version.task, dataset: version.task.dataset, agentFolder: version.task.agentFolder, request: '', format: 'answer', submittedRequest: version.task.request, forkFromId: undefined, delivery: version.id, revise: true, status: 'complete', error: undefined,
      deliveryError: undefined, retryKinds: undefined, failedChanges: undefined, interruptedReply: undefined, updatedAt: new Date().toISOString() };
    await commitResult(next, version, task);
    setVersionPreview(undefined);
    setVersionsOpen(false);
    focusResult();
  }

  function branchFrom(version: AssistantVersion) {
    if (locked || !version.task.request.trim()) return;
    const { dataset, retrieval, agentFolder, attachments, pinned, request, format, locale } = version.task;
    update({ forkFromId: version.id, request, dataset, retrieval, agentFolder, attachments, pinned, format, locale, error: undefined, failedChanges: undefined, interruptedReply: undefined, status: 'complete' });
    setInputPreview(undefined);
    setVersionPreview(undefined);
    setVersionsOpen(false);
    focusRequest();
  }

  function cancelBranch() {
    if (!activeTurn || locked) return;
    const { attachments, pinned, dataset, retrieval, agentFolder, locale } = activeTurn.task;
    update({ forkFromId: undefined, request: '', attachments, pinned, dataset, retrieval, agentFolder, format: 'answer', locale, error: undefined, status: 'complete' });
  }

  function cite(text: string, refs = draft?.refs ?? []) {
    return text.split(/(\[S\d+\])/g).map((part, index) => {
      const ref = refs.find(item => part === `[${item.id}]`);
      return ref ? <button className="cite" key={index} onClick={() => show(ref)}>{part}</button> : part;
    });
  }

  function focusRequest() {
    requestAnimationFrame(() => requestRef.current?.focus());
  }

  function focusResult() {
    requestAnimationFrame(() => {
      const heading = resultRef.current;
      const thread = threadRef.current;
      if (!heading?.getClientRects().length || !thread) return;
      heading.focus({ preventScroll: true });
      const result = heading.closest('.task-draft, .assistant-reply');
      if (result) {
        const top = result.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop;
        thread.scrollTo({ top: Math.max(0, top - 8) });
      }
    });
  }

  function copyReply(text: string) {
    void navigator.clipboard.writeText(text).then(() => message.success(t('copied'))).catch(() => message.error(t('file_access')));
  }

  function chooseCommand(item: typeof assistantCommands[number]) {
    const text = command?.text ?? (commandPrefix === undefined ? request.trim() : '');
    update({ request: '/' + (zh ? item.zh : item.en) + ' ' + text });
    setCommandsOpen(false);
    focusRequest();
  }

  async function selectAgentFolder() {
    if (!nativeEngine || locked || pickingFolder) return;
    setPickingFolder(true);
    try {
      const folder = await pickAgentFolder();
      if (folder) update({ agentFolder: folder });
    } catch (error) { message.error(t(errorCode(error, 'agent_folder_unavailable'))); }
    finally { setPickingFolder(false); focusRequest(); }
  }

  async function openTask(item: AssistantTask) {
    if (item.id === task.id || await switchConversation(resumeTask(item, defaultEngine), false)) setHistoryOpen(false);
  }

  async function newConversation() {
    if (await startTask()) {
      setHistoryQuery('');
      setHistoryOpen(false);
    }
  }

  function removeConversation(item: AssistantTask) {
    return writeConversation(async () => {
      try {
        await deleteTask(item.id);
        setHistory(current => current.filter(entry => entry.id !== item.id));
        if (task.id === item.id) {
          setActive(blankTask(i18n.language as Locale));
          if (dockHistory) focusRequest();
        }
        return true;
      } catch {
        message.error(t('storage_error'));
        return false;
      }
    });
  }

  function updateConversation(id: string, patch: Pick<AssistantTask, 'conversationTitle' | 'conversationPinnedAt'>) {
    return writeConversation(async () => {
      const isActive = task.id === id;
      const existing = isActive ? task : history.find(item => item.id === id);
      if (!existing) return false;
      const next = { ...existing, ...patch };
      if (next.conversationPinnedAt && !next.conversationTitle) next.conversationTitle = assistantConversationTitle(next) || undefined;
      if (!await archive(next)) return false;
      if (isActive) setActive(next);
      return true;
    });
  }

  function saveFormat(kind: 'docx' | 'pptx') {
    const file = outputs.find(output => output.kind === kind);
    if (file) void saveFile(file);
    else build([kind], true);
  }

  const failure = task.status === 'failed' || task.status === 'interrupted';
  const shownRequest = task.submittedRequest;
  const engineCopy = { engine: engineName };
  let responseStatus = workspace ? 'agentToolsRunning' : 'working';
  if (format === 'answer') {
    if (runProgress?.connection === 'retrying') responseStatus = 'agentReconnecting';
    else if (!workspace) responseStatus = runProgress?.text ? 'assistantReplying'
      : nativeEngine && !runProgress?.connection ? 'agentStarting' : 'agentWaitingReply';
  }
  const engineReady = engineStatus === 'codex_ready' || engineStatus === 'provider_configured';
  const readyText = nativeDesktop ? t(engineStatus, engineCopy) : t('assistantOffline');
  const sendLabel = t(reportPlan ? 'assistantRunReport' : failure ? 'retry' : format === 'answer' ? 'assistantSend' : 'runTask');
  const citedIds = new Set(draft && [draft.value.title, ...draft.value.sections.flatMap(part => [part.heading, part.text])].join('\n').match(/\[S\d+\]/g));
  const usedSources = draft?.refs.filter(ref => citedIds.has(`[${ref.id}]`)) ?? [];
  const taskContext = renderTaskContext?.({
    dataset, filenames: selected.map(file => file.material.relative), retrievalActive,
    locked: switchingBlocked, hasDraft: Boolean(draft), showScope,
  });
  const engineControl = <Tooltip title={readyText}>
    <Select<AgentEngine | 'check' | 'settings'> className="assistant-engine" variant="borderless" value={engine} disabled={engineLocked}
      aria-label={t('assistantConversationModel')} placement="topRight" popupMatchSelectWidth={300} showSearch={{ optionFilterProp: 'label' }}
      prefix={<span className={engineReady ? 'assistant-engine-ready' : 'assistant-engine-waiting'} aria-hidden />}
      options={[...engineOptions,
        { value: 'check', label: t('checkEngine'), disabled: !nativeDesktop || engineStatus === 'codex_checking' || engineStatus === 'provider_model' },
        { value: 'settings', label: t('agentSettings') }]}
      labelRender={() => <span className="assistant-engine-label" title={engineName}>{engineName}</span>}
      onChange={next => {
        if (next === 'settings') openAgentSettings();
        else if (next === 'check') recheckEngine(engine);
        else changeEngine(next);
      }} />
  </Tooltip>;
  const commandControl = <Dropdown trigger={['click']} placement="topLeft" open={commandsOpen && !locked && commandChoices.length > 0}
    onOpenChange={open => { setCommandsOpen(open); setCommandIndex(0); }}
    menu={{
      className: 'assistant-command-menu',
      activeKey: commandChoices[commandIndex]?.key,
      items: commandChoices.map(item => ({ key: item.key, label: <span className="assistant-command-item">
        <code>/{zh ? item.zh : item.en}</code><span>{t(item.label)}</span></span> })),
      onClick: ({ key }) => { const item = assistantCommands.find(item => item.key === key); if (item) chooseCommand(item); },
    }}>
    <Button type="text" className="assistant-composer-control" icon={<CodeOutlined />} disabled={locked}
      aria-expanded={commandsOpen && commandChoices.length > 0}>{t('assistantCommands')}</Button>
  </Dropdown>;
  const toolsControl = nativeEngine && format === 'answer' && !reportPlan && <Dropdown trigger={['click']} placement="topLeft" menu={{
    items: [
      { key: 'choose', icon: <FolderOpenOutlined />, label: t(agentFolder ? 'agentFolderChange' : 'agentFolderChoose') },
      ...(agentFolder ? [
        { key: 'folder', icon: <FolderOpenOutlined />, label: t('agentFolderOpen') },
        { key: 'terminal', icon: <CodeOutlined />, label: t('agentTerminalOpen', engineCopy) },
        { key: 'off', icon: <CloseOutlined />, label: t('agentFolderRemove') },
      ] : []),
    ],
    onClick: ({ key }) => {
      if (key === 'choose') void selectAgentFolder();
      if (key === 'off') update({ agentFolder: undefined });
      if (key === 'folder' && agentFolder) void openAgentFolder(agentFolder.id).catch(error => message.error(t(errorCode(error, 'open_failed'))));
      if (key === 'terminal' && agentFolder) void openAgentTerminal(nativeEngine, agentFolder.id).catch(error => message.error(t(errorCode(error, 'agent_terminal_failed'))));
    },
  }}><Button type="text" className="assistant-composer-control" icon={<ToolOutlined />} data-active={Boolean(workspace)}
    title={workspace?.path || t('agentFolderChoose')} loading={pickingFolder} disabled={locked}>{t(workspace ? 'agentToolsOn' : 'agentTools')}</Button></Dropdown>;
  const conversationList = <AssistantConversations tasks={availableTasks} activeId={task.id} query={historyQuery}
    changeQuery={setHistoryQuery} ready={historyReady} disabled={switchingBlocked} open={openTask} remove={removeConversation}
    rename={(id, title) => updateConversation(id, { conversationTitle: title })}
    pin={(id, pinned) => updateConversation(id, { conversationPinnedAt: pinned ? new Date().toISOString() : undefined })} />;
  const conversationTitle = assistantConversationTitle(task) || t('assistantUntitledConversation');
  const newConversationButton = <Button className="assistant-conversation-new" size="small" icon={<PlusOutlined />}
    disabled={switchingBlocked} onClick={newConversation}>{t('assistantNewConversation')}</Button>;
  const exportedFiles = outputs.length > 0 && <div className="assistant-output-list" aria-label={t('generatedFiles')}>
    {outputs.map(item => <div className="assistant-output" key={item.id}>
      <div className={'assistant-output-icon ' + item.kind}>{item.kind === 'docx' ? <FileWordOutlined /> : <FilePptOutlined />}</div>
      <div className="assistant-output-title" title={item.title + '.' + item.kind}>{item.title}.{item.kind}</div>
      <div className="assistant-toolbar">
        <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => preview(item.id)}>{t('filePreview')}</Button>
        <Button size="small" type="text" icon={<DownloadOutlined />} disabled={exporting} onClick={() => void saveFile(item)}>{t('saveAs')}</Button>
      </div>
    </div>)}
  </div>;
  const deliveryError = draft && task.deliveryError && <Alert className="mt-3" type="warning" showIcon
    title={t(task.deliveryError, { defaultValue: t('export_failed') })} action={<Button size="small" disabled={locked} onClick={() =>
      build(task.retryKinds ?? (draft.format === 'bundle' ? ['docx', 'pptx'] : [draft.format === 'pptx' ? 'pptx' : 'docx']))}>{t('retryDelivery')}</Button>} />;

  return <div className="assistant-workspace" data-history-docked={dockHistory}>
    {dockHistory && <aside className="assistant-conversations" aria-label={t('assistantConversationHistory')}>
      <header><h2>{t('assistantConversationHistory')}</h2>{newConversationButton}</header>
      {conversationList}
    </aside>}
    <div className={'assistant-layout ' + (inTask ? 'assistant-task-view' : 'assistant-start-view')}>
    <header className="assistant-session-tools">
      {!dockHistory && <Button type="text" size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>{t('assistantConversationHistory')}</Button>}
      {(inTask || task.conversationTitle) && <strong className="assistant-task-title" title={conversationTitle}>{conversationTitle}</strong>}
    </header>
    <div className="assistant-primary">
    {!inTask && <div className="assistant-intro">
      <div className="assistant-welcome">
        <h1>{t('composerWelcome')}</h1>
        {!engineReady && engineStatus !== 'codex_checking' && <div className="assistant-welcome-connection">
          <span>{readyText}</span>
          <Button size="small" onClick={openAgentSettings}>{t('agentSettings')}</Button>
        </div>}
      </div>
    </div>}
    {inTask && <section className="assistant-thread" aria-label={t('assistantThread')} ref={threadRef}
      onScroll={event => {
        const thread = event.currentTarget;
        followReply.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 72;
      }}>
      {earlier.length > 0 && <div className="assistant-earlier-messages" key={task.id}>
        {earlier.map(version => {
          const previous = version.task.draft;
          return <div className="assistant-turn" key={version.id}>
            {version.task.request && <UserMessage request={version.task.request} branch={() => branchFrom(version)} disabled={locked} />}
            {previous.format === 'answer' ? <><ReplyAuthor model={previous.model} /><article className="assistant-reply" lang={previous.language}>
              <ReplyContent draft={previous} show={show} />
            </article></> : <details className="assistant-turn-draft">
              <summary><span>{previous.value.title}</span><small className="assistant-turn-meta">{t(version.change)}</small></summary>
              <article className="assistant-preview" lang={previous.language}>
                {previous.value.sections.map((part, index) => <section className="paper-section" key={index}>
                  {part.heading && <h2>{cite(part.heading, previous.refs)}</h2>}
                  {part.text.split(/\r?\n/).filter(Boolean).map((line, index) => <p key={index}>{cite(line, previous.refs)}</p>)}
                </section>)}
              </article>
            </details>}
          </div>;
        })}
      </div>}
      {shownRequest && <UserMessage request={shownRequest} branch={activeTurn ? () => branchFrom(activeTurn) : undefined} disabled={locked} />}
      {draft && <><ReplyAuthor model={draft.model} />
      {chatReply ? <article className="assistant-reply" ref={resultRef} tabIndex={-1} lang={draft.language}>
        <ReplyContent draft={draft} show={show} />
        {exportedFiles}
        {deliveryError}
        {Boolean(draft.deniedTools) && <Alert type="info" showIcon title={t('agentToolsDenied', { count: draft.deniedTools })} />}
        <div className="assistant-reply-actions">
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyReply(draft.value.sections.map(part => part.text).join('\n\n'))}>{t('copyDraft')}</Button>
          {usedSources.length > 0 && <Button type="text" size="small" icon={<LinkOutlined />} onClick={() => setSourcesOpen(true)}>{t('assistantSourceCount', { count: usedSources.length })}</Button>}
          <Button type="text" size="small" icon={<BranchesOutlined />} disabled={historyLoading} onClick={() => setVersionsOpen(true)}>{t('assistantBranches')}</Button>
          {!draft.reply && <Dropdown trigger={['click']} menu={{
            items: [
              { key: 'edit', label: t('editDraft'), icon: <EditOutlined />, disabled: historyLoading || Boolean(forkFrom) },
              { key: 'docx', label: t('assistantSaveWord'), icon: <FileWordOutlined /> },
              { key: 'pptx', label: t('assistantSavePpt'), icon: <FilePptOutlined /> },
              { key: 'slides', label: t('assistantToSlides'), icon: <FilePptOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'edit') setEditing(structuredClone(draft.value));
              else if (key === 'docx' || key === 'pptx') saveFormat(key);
              else if (key === 'slides') openCreative({ draft: draft.value, refs: draft.refs, locale: draft.language, brief: shownRequest || request });
            },
          }}><Button type="text" size="small" icon={<EllipsisOutlined />} disabled={locked || exporting}
            aria-label={t('assistantReplyActions')} title={t('assistantReplyActions')} /></Dropdown>}
        </div>
      </article> : <section className="task-draft">
        <div className="assistant-result-heading">
          <h1 id="assistant-result-title" ref={element => { resultRef.current = element; }} tabIndex={-1} lang={draft.language}>{cite(draft.value.title)}</h1>
          <Dropdown trigger={['click']} menu={{
            items: [
              { key: 'docx', label: t('assistantSaveWord'), icon: <FileWordOutlined /> },
              { key: 'pptx', label: t('assistantSavePpt'), icon: <FilePptOutlined /> },
              { key: 'copy', label: t('copyDraft'), icon: <CopyOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'docx' || key === 'pptx') saveFormat(key);
              else void navigator.clipboard.writeText([draft.value.title, ...draft.value.sections.map(part => [part.heading, part.text].filter(Boolean).join('\n'))].join('\n\n'))
                .then(() => message.success(t('copied'))).catch(() => message.error(t('file_access')));
            },
          }}><Button type="default" icon={<DownloadOutlined />} disabled={locked || exporting}>{t('assistantExport')}</Button></Dropdown>
        </div>
        <div className="assistant-toolbar assistant-result-actions">
          <Button type="text" size="small" icon={<EditOutlined />} disabled={locked || historyLoading || Boolean(forkFrom)} onClick={() => setEditing(structuredClone(draft.value))}>{t('editDraft')}</Button>
          <Button type="text" size="small" icon={<BranchesOutlined />} disabled={historyLoading} onClick={() => setVersionsOpen(true)}>{t('assistantBranches')}</Button>
          <Button type="text" size="small" icon={<FilePptOutlined />} disabled={locked} aria-label={t('creativeFromDraft')}
            onClick={() => openCreative({ draft: draft.value, refs: draft.refs, locale: draft.language, brief: task.submittedRequest || task.request })}>{t('assistantToSlides')}</Button>
          {usedSources.length > 0 && <Button type="text" size="small" icon={<LinkOutlined />} onClick={() => setSourcesOpen(true)}>{t('assistantSourceCount', { count: usedSources.length })}</Button>}
        </div>
        {exportedFiles}
        {deliveryError}
        <article className="assistant-preview" lang={draft.language}>
          {draft.value.sections.map((part, index) => <section className="paper-section" key={index}>
            {part.heading && <h2>{cite(part.heading)}</h2>}{part.text.split(/\r?\n/).filter(Boolean).map((line, lineIndex) => <p key={lineIndex}>{cite(line)}</p>)}
          </section>)}
        </article>
      </section>}</>}
      {running && request.trim() && <UserMessage request={request.trim()} />}
      {running && runProgress && <>
        <AgentActivity tools={runProgress.tools} />
        {runProgress.text && <article className="assistant-reply agent-live-reply">
          <ReplyAuthor model={replyModel} />
          <AssistantReply text={runProgress.text} refs={[]} show={show} />
        </article>}
      </>}
      {stoppedReply && <div className="assistant-turn assistant-interrupted-turn">
        <UserMessage request={stoppedReply.request} />
        <ReplyAuthor model={stoppedReply.model} incomplete />
        <article className="assistant-reply">
          <AssistantReply text={stoppedReply.text} refs={[]} show={show} />
          <div className="assistant-reply-actions">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyReply(stoppedReply.text)}>{t('copyDraft')}</Button>
          </div>
        </article>
      </div>}
      {locked && <TaskProgress since={running ? started : undefined} label={t(creating || phase === 'files' && running
        ? 'buildingFiles' : stopping ? 'agentStopping' : saving ? 'assistantSavingDraft' : phase === 'retrieve' && running ? 'assistant_rag_searching' : responseStatus, engineCopy)} />}
    </section>}
    <div className="assistant-panel">
      {dataset && <section className="assistant-dataset-context" aria-label={t('assistantDatasetLabel')}>
        <span className="assistant-dataset-icon" aria-hidden="true"><DatabaseOutlined /></span>
        <div>
          <strong title={dataset.name}>{dataset.name}</strong>
          {!showSourcesLoading && <p role="status">
            {t('assistantDatasetCoverage', { sources: dataset.sourceIds.length, readable: availableFiles.length, files: dataset.materialIds.length })}
            {!retrievalActive && <> · {t('assistantDatasetCap', { count: selected.length, max: maximumAttachments })}</>}
            {pinned.length > 0 && <> · {t('assistantDatasetExcerptCount', { count: pinned.length })}</>}
          </p>}
          {!showSourcesLoading && !pinned.length && availableFiles.length === 0 &&
            <p className="assistant-dataset-message">{t('assistantDatasetEmpty')}</p>}
          {!retrievalActive && !showSourcesLoading && !pinned.length && availableFiles.length > maximumAttachments && selected.length === 0 &&
            <p className="assistant-dataset-message">{t('assistantDatasetChooseHint')}</p>}
        </div>
      </section>}
      {task.status === 'interrupted' && <Alert type="info" showIcon title={t('interruptedTask')} />}
      {task.status === 'failed' && <Alert type={task.error === 'codex_cancelled' ? 'info' : 'error'} showIcon
        title={task.error === 'codex_cancelled' ? t('assistantTaskStopped') : t(task.error ?? 'codex_failed', { ...engineCopy, defaultValue: t('codex_failed', engineCopy) })}
        action={task.error === 'codex_auth' || task.error === 'codex_missing' || task.error === 'codex_version' || task.error === 'codex_network'
          ? <Button size="small" onClick={openAgentSettings}>{t('assistantConnection', engineCopy)}</Button> : undefined} />}
      {task.status === 'failed' && <AgentFileChanges changes={task.failedChanges} />}
      <section className="assistant-composer" aria-label={t('assistantMessage')}>
        {forkFrom && <div className="assistant-branch-banner" role="status">
          <BranchesOutlined /><div><strong>{t('assistantBranchPending')}</strong><small title={forkFrom.task.request}>{forkFrom.task.request}</small></div>
          <Button type="text" size="small" disabled={locked} onClick={cancelBranch}>{t('cancel')}</Button>
        </div>}
        <Input.TextArea id="office-request" ref={requestRef} variant="borderless" autoSize={{ minRows: running ? 1 : 2, maxRows: draft ? 5 : 8 }} maxLength={2500}
          aria-label={t('assistantMessage')} placeholder={t(running ? 'assistantWorkingInput' : format === 'answer' ? 'assistantChatInput' : 'assistantDocumentInput')}
          value={running ? '' : request}
          disabled={locked || pickingFolder || savingConversation} onChange={event => {
            const text = event.target.value;
            update({ request: text });
            setCommandsOpen(/^\/[^\s]*$/.test(text.trimStart()));
            setCommandIndex(0);
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (commandsOpen && commandChoices.length) {
              if (event.key === 'Escape') { setCommandsOpen(false); return; }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const offset = event.key === 'ArrowDown' ? 1 : -1;
                setCommandIndex((commandIndex + offset + commandChoices.length) % commandChoices.length);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                const choice = commandChoices[commandIndex];
                if (choice) chooseCommand(choice);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              setCommandsOpen(false);
              void submit();
            }
          }} />
        {(reportPlan || clarifyReport) && <div className="assistant-report-plan" aria-live="polite">
          {reportPlan && reportPeriod && dataset && <>
            <div className="assistant-report-plan-details">
              <strong>{t(reportPlan.cadence === 'weekly' ? 'assistantReportWeekly' : 'assistantReportMonthly')}</strong>
              <span>{t('assistantReportScope', { name: dataset.name })}</span>
              <span><time dateTime={reportPeriod.from}>{reportPeriod.from}</time> – <time dateTime={reportPeriod.to}>{reportPeriod.to}</time></span>
              <span>{reportPlan.outputs.length ? reportPlan.outputs.map(kind => reportFormats[kind] ?? kind.toUpperCase()).join(' / ') : t('assistantReportDraft')}</span>
              {reportPlan.withAgent && <span>{t('assistantReportWithAgent')}</span>}
            </div>
            {reportPlan.withAgent && !hasCodex && !datasetCommandBusy && <p>{t('assistantReportNeedsAgent', engineCopy)}</p>}
          </>}
          {clarifyReport && <p>{t(clarifyReport === 'cadence' ? 'assistantReportClarifyCadence' : 'assistantReportClarifyPeriod')}</p>}
        </div>}
        {!inlineTaskContext && taskContext && <div className="assistant-task-context">{taskContext}</div>}
        {workspace && <div className="assistant-workspace-path" title={workspace.path}>
          <FolderOpenOutlined aria-hidden /><span>{workspace.path}</span>
        </div>}
        {dataset && !reportPlan && <div className="assistant-rag-control">
          <Select<AssistantRetrieval> aria-label={t('assistant_rag_mode')} variant="borderless" size="small" value={retrieval}
            disabled={locked || previewingInput} onChange={mode => update({ retrieval: mode })}
            options={[
              { value: 'attachments', label: t('assistant_rag_attachments') },
              { value: 'keyword', label: t('assistant_rag_keyword') },
              { value: 'hybrid', label: t('assistant_rag_hybrid') },
            ]} />
          {retrieval !== 'attachments' && <span>{t(retrieval === 'hybrid' ? 'assistant_rag_hybrid_hint' : 'assistant_rag_keyword_hint')}</span>}
          {openKnowledge && <Button type="text" size="small" disabled={locked || previewingInput} onClick={() => openKnowledge(dataset, items => {
            update({ pinned: [...pinned, ...datasetExcerpts(dataset, items)].slice(-12) });
            focusRequest();
          })}>{t('assistant_rag_manage')}</Button>}
        </div>}
        {needsReportScope && <p className="assistant-scope-hint" role="status"><DatabaseOutlined aria-hidden />{t('assistantChooseReportScope')}</p>}
        <AssistantMaterials key={task.id + '/' + scopePickerVersion} compact files={scopedFiles} attachments={retrievalActive ? [] : attachments} pinned={pinned} locked={locked || previewingInput} loading={showSourcesLoading}
          scope={dataset ? { name: dataset.name, openInitially: format !== 'answer' && !draft && task.pinned === undefined
            && !attachments.length && availableFiles.length > maximumAttachments } : undefined}
          change={ids => update({ attachments: ids })} pick={pick} preview={previewMaterial} show={show}
          removeExcerpt={index => update({ pinned: pinned.filter((_, position) => index !== position) })}
          reviewContext={Boolean(parentId && turns.has(parentId))}
          retrievalActive={retrievalActive}
          review={reportPlan ? undefined : () => void reviewInput()} controls={<>
          {inlineTaskContext && taskContext && <div className="assistant-task-context is-inline">{taskContext}</div>}
          {commandControl}
          {toolsControl}
          {!reportPlan && <div className="assistant-options">
            <Select id="office-format" aria-label={t('output')} value={format} variant="borderless" prefix={format === 'pptx' ? <FilePptOutlined /> : format === 'answer' ? <MessageOutlined /> : <FileWordOutlined />} disabled={locked || Boolean(command?.format)} onChange={(format: Format) => update({ format })}
              options={(['answer', 'docx', 'pptx', 'bundle'] as const).map(item => ({ value: item, label: t(item) }))} />
            {format !== 'answer' && <Select id="office-language" aria-label={t('outputLanguage')} value={locale} variant="borderless" prefix={<GlobalOutlined />} disabled={locked} onChange={(locale: Locale) => update({ locale })}
              options={[{ value: 'zh-CN', label: t('zh') }, { value: 'en-US', label: t('en') }]} />
            }
          </div>}
          <div className="assistant-submit-controls">
            {engineControl}
            {running ? <Button className="assistant-send assistant-stop" disabled={phase === 'files' || stopping} icon={<span className="assistant-stop-square" />} onClick={stopCurrent}><span className="assistant-send-label">{t(stopping ? 'agentStopping' : 'stopTask')}</span></Button> :
              <Tooltip title={t('assistantSendShortcut')}><Button className="assistant-send" type="primary" icon={<ArrowUpOutlined />} loading={runningReport} disabled={!canSubmit} aria-label={sendLabel} onClick={() => { setCommandsOpen(false); void submit(); }}><span className="assistant-send-label">{sendLabel}</span></Button></Tooltip>}
          </div>
        </>} />
      </section>
      <div className="assistant-composer-note">
        {!draft && !running && format !== 'answer' && <Button type="text" size="small" onClick={() => setEditing({ title: '', sections: [{ heading: '', text: '' }] })}
          disabled={locked} icon={<EditOutlined />}>{t('assistantWriteManually')}</Button>}
        {draft && !chatReply && !request.trim() && !locked && <div className="assistant-revision-suggestions">
          {([{ label: 'assistantShorten', request: 'assistantShortenRequest' }, { label: 'assistantActionItems', request: 'assistantActionItemsRequest' }] as const).map(suggestion =>
            <Button key={suggestion.label} size="small" type="text" onClick={() => { update({ request: t(suggestion.request, { lng: locale }) }); focusRequest(); }}>{t(suggestion.label)}</Button>)}
        </div>}
      </div>
    </div>
    </div>
    <Drawer open={sourcesOpen} size={480} title={t('assistantSourceCount', { count: usedSources.length })} onClose={() => setSourcesOpen(false)}>
      <div className="assistant-source-list">{usedSources.map(ref => <button key={ref.id} type="button" onClick={() => { setSourcesOpen(false); show(ref); }}>
        <strong>{ref.id} · {ref.locations[0]?.file}</strong><small>{ref.locations[0]?.at}</small><span>{ref.text}</span>
      </button>)}</div>
    </Drawer>
    <Drawer open={versionsOpen} size={520} title={t('assistantBranches')} onClose={() => { setVersionsOpen(false); setVersionPreview(undefined); }}>
      {!versions ? <Spin /> : [...turns.values()].reverse().map(version => <div className="assistant-history-row assistant-branch-row" key={version.id}>
        <button type="button" onClick={() => setVersionPreview(version)}>
          <strong>{version.task.draft.value.title}</strong>
          <small>{t(version.change)} · {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.savedAt))}</small>
        </button>
        <div className="assistant-branch-actions">
          {version.id === task.delivery ? <Tag color="green">{t('activeVersion')}</Tag> :
            <Button size="small" disabled={locked} onClick={() => void restoreVersion(version)}>{t('assistantBranchSwitch')}</Button>}
          {version.task.request.trim() && <Button type="text" size="small" icon={<BranchesOutlined />} disabled={locked} onClick={() => branchFrom(version)}>{t('assistantBranchRetry')}</Button>}
        </div>
        <small className="assistant-branch-parent">{version.parentId && turns.has(version.parentId)
          ? t('assistantBranchParent', { name: turns.get(version.parentId)?.task.draft.value.title })
          : t('assistantBranchStart')}</small>
      </div>)}
      {versionPreview && <article className="file-paper version-preview">
        <h3>{versionPreview.task.draft.value.title}</h3>
        {versionPreview.task.draft.value.sections.map((part, index) => <section key={index}><h4>{part.heading}</h4><p>{part.text}</p></section>)}
      </article>}
    </Drawer>
    <Modal open={Boolean(inputPreview)} title={t('previewAssistantInput')} width={680} footer={<Button onClick={() => setInputPreview(undefined)}>{t('close')}</Button>} onCancel={() => setInputPreview(undefined)}>
      {inputPreview && <div className="edit-sections">
        {inputPreview.degraded && <Alert showIcon type="info" title={t('assistant_rag_degraded')} />}
        {inputRequest && <div className="review-original"><strong>{t('assistantMessage')}</strong><p>{inputRequest}</p></div>}
        {workspace && <div className="review-original"><strong>{t('agentTools')}</strong><p>{workspace.path}</p></div>}
        <span className="muted">{t(inputPreview.includesDraft ? 'assistantInputWithDraft' : 'assistantInputExcerpts', { count: inputPreview.refs.length })}</span>
        {inputPreview.conversation && <details className="assistant-memory-preview">
          <summary>{t('assistantMemoryIncluded')}</summary>
          {inputPreview.conversation.earlierSummary.length > 0 && <div><strong>{t('assistantMemorySummary')}</strong>
            <ul>{inputPreview.conversation.earlierSummary.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
          {[...inputPreview.conversation.recent, ...inputPreview.conversation.relevant].map((turn, index) => <div key={index}>
            <strong>{turn.request}</strong><p>{cite(turn.response, inputPreview.refs)}</p>
          </div>)}
        </details>}
        {inputPreview.unread.length > 0 && <Alert showIcon type="warning" title={t('unreadableAttachments', { names: inputPreview.unread.join(', ') })} />}
        {inputPreview.refs.map(ref => <div className="review-original" key={ref.id}>
          <span className="muted">{ref.id} · {ref.locations[0]?.file} · {ref.locations[0]?.at}</span><p>{ref.text}</p>
        </div>)}
      </div>}
    </Modal>
    <Modal open={Boolean(editing)} title={t(draft ? 'editDraft' : 'assistantWriteManually')} width={680} okText={t('save')} cancelText={t('cancel')} confirmLoading={saving}
      okButtonProps={{ disabled: !editing?.title.trim() || !editing?.sections.some(part => part.text.trim()) }} onCancel={() => setEditing(undefined)}
      onOk={() => { if (editing) void saveEdit(editing); }}>
      {editing && <div className="edit-sections">
        <div className="field"><label htmlFor="draft-title">{t('draftTitleField')}</label><Input id="draft-title" value={editing.title} maxLength={120}
          onChange={event => setEditing({ ...editing, title: event.target.value })} /></div>
        {editing.sections.map((part, index) => <div className="draft-edit-part" key={index}>
          <div className="flex gap-2"><Input aria-label={t('sectionHeading')} placeholder={t('sectionHeading')} value={part.heading} maxLength={120}
            onChange={event => setEditing({ ...editing, sections: editing.sections.map((item, i) => i === index ? { ...item, heading: event.target.value } : item) })} />
            <Button type="text" icon={<CloseOutlined />} aria-label={t('removeSection')} onClick={() => setEditing({ ...editing, sections: editing.sections.filter((_, i) => i !== index) })} /></div>
          <Input.TextArea aria-label={t('body')} rows={4} maxLength={8000} value={part.text} onChange={event => setEditing({ ...editing,
            sections: editing.sections.map((item, i) => i === index ? { ...item, text: event.target.value } : item) })} />
        </div>)}
        <Button icon={<PlusOutlined />} disabled={editing.sections.length >= 12} onClick={() => setEditing({ ...editing, sections: [...editing.sections, { heading: '', text: '' }] })}>{t('addSection')}</Button>
      </div>}
    </Modal>
    </div>
    {!dockHistory && <Drawer open={historyOpen} placement="left" size="min(90vw, 380px)" title={t('assistantConversationHistory')}
      extra={newConversationButton} classNames={{ body: 'assistant-conversations-drawer-body' }} onClose={() => setHistoryOpen(false)}
      footer={<div className="assistant-history-links">
        <Button type="text" onClick={() => { setHistoryOpen(false); openLibrary(); }}>{t('library')}</Button>
        <Button type="text" onClick={() => { setHistoryOpen(false); openArtifacts(); }}>{t('artifacts')}</Button>
      </div>}>
      {conversationList}
    </Drawer>}
  </div>;
}
