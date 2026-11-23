import {
  ArrowLeftOutlined, BarChartOutlined, CalendarOutlined, CloseOutlined, ExperimentOutlined, EyeOutlined, FileTextOutlined,
  DatabaseOutlined, FilePptOutlined, FileWordOutlined, FolderOpenOutlined, GlobalOutlined, HddOutlined, HistoryOutlined, MoreOutlined, PlusOutlined, QuestionCircleOutlined,
  ApiOutlined, ApartmentOutlined, AppstoreOutlined, BlockOutlined, MessageOutlined, PlaySquareOutlined, ReloadOutlined,
  SettingOutlined, SwapOutlined, ThunderboltOutlined, ToolOutlined,
} from '@ant-design/icons';
import {
  Alert, App as AntApp, Button, Checkbox, DatePicker, Dropdown, Input, Modal, Popconfirm, Segmented, Select, Spin, Tag, Tooltip,
} from 'antd';
import type { MenuProps } from 'antd';
import { listen } from '@tauri-apps/api/event';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MappingDialog from './MappingDialog';
import ArtifactsView from './ArtifactsView';
import FilePreview from './FilePreview';
import type { PreviewFile } from './FilePreview';
import MaterialsView from './MaterialsView';
import DataWorkbench from './DataWorkbench';
import BrowserWorkbench from './BrowserWorkbench';
import type { BrowserIntake } from './BrowserWorkbench';
import { invoke } from '@tauri-apps/api/core';
import ModelWorkbench from './ModelWorkbench';
import WorkflowWorkbench from './WorkflowWorkbench';
import McpPanel from './McpPanel';
import { deleteKnowledgeIndex } from './knowledge-index';
import type { KnowledgeModel } from './knowledge-index';
import { listProviders, providerEmbeddings, providerMedia, startVideo, videoStatus } from './provider-client';
import type { ProviderProfile } from './provider-client';
import { mcpCall } from './mcp-client';
import { expandWorkflow, matchingWorkflows, runWorkflow, validWorkflows, workflowArguments } from './office-workflows';
import type { OfficeWorkflow, StepUpdate, WorkflowRun } from './office-workflows';
import type { DatasetActivity } from './DataWorkbench';
import { scanDataset } from './dataset-scan';
import type { DatasetScan } from './dataset-scan';
import type { OfficeCommandPlan } from './office-command';
import OfficeAssistant from './OfficeAssistant';
import TaskScopePicker from './TaskScopePicker';
import AgentSettings from './AgentSettings';
import DatasetSearch from './DatasetSearch';
import { dataWorkbenchEn, dataWorkbenchZh } from './data-workbench-i18n';
import OfficeTools, { fileIcons } from './OfficeTools';
import PptWorkspace from './PptWorkspace';
import type { PptPageLocation } from './PptWorkspace';
import ReportControls from './ReportControls';
import ReportView from './ReportView';
import TableAnalysis from './TableAnalysis';
import CreativeStudio from './CreativeStudio';
import { creativeExportPages, newCreativeProject, pagesFromDraft } from './creative-project';
import type { CreativeIntake } from './creative-project';
import WorkspaceBackup from './WorkspaceBackup';
import WorkspaceSearch from './WorkspaceSearch';
import { Blank, EvidenceDrawer, MetricStrip, Review } from './Review';
import {
  addBrowserFiles, agentCliDetails, cancelPolish, codexStatus, demoSource, errorCode, FILE_LIMIT, saveArtifact, listSources,
  loadMaterials, nativeDesktop, openArtifact, openMaterial, parseArtifact, pickSources, polishReport, readMaterial, relinkSource, removeSource, runOffice,
} from './desktop';
import type { AgentCliDetails, AgentEngine, SourceSelection } from './desktop';
import { analyze, businessDate, codexInput, createReport, fromSource, isMedia, isReportSource, period, quickPeriod, reportTitle, sections, supportedFiles } from './domain';
import type { Analysis, ArtifactKind, Cadence, Evidence, Issue, Loaded, Locale, Location, Mapping, Narrative, Parsed, Report, ReportProfile, ReviewDecision, Settings, Source } from './domain';
import { artifactName, assistantConversationTitle, assistantInput, assistantPresets, deleteArtifact, deleteReportArchive, storeArtifact, storeArtifacts, storedArtifacts, storeReportArchive, storeReportDraft, storedReports } from './office';
import type { ArchivedReport, Artifact, AssistantDatasetScope, AssistantPreset, AssistantReference, AssistantTask, Format, NewArtifact } from './office';
import { makeSlides, makeWord, packageFiles } from './office-output';
import { checkMapping, inputChanges, mappingFolder, relinkFolderMappings, reportInput, sameLayout } from './report-input';
import { documentPeriod } from './report-period';
import { archiveKey, detailFile, reportDetails, reportGroup } from './report-snapshot';
import type { SavedReport } from './report-snapshot';
import { dictionaries } from './i18n';
import { readLocal, writeLocal } from './storage';
import type { ToolIntake } from './tool-draft';

const sampleSettings: Settings = { team: 'Atlas 交付组', locale: 'zh-CN', cadence: 'weekly', from: '2026-11-16', to: '2026-11-22' };

type Preview = { type: PptPageLocation['type']; id: string; anchor?: string; audit?: boolean };
type Page = 'data' | 'assistant' | 'library' | 'analysis' | 'tools' | 'slides' | 'creative' | 'current' | 'artifacts' | 'history'
  | 'workflows' | 'models' | 'media' | 'mcp' | 'browser';
type ImportTarget = 'assistant' | 'analysis' | 'creative' | ToolIntake['kind'];
const primaryNavigation = [
  ['assistant', MessageOutlined, 'navChat'], ['data', DatabaseOutlined],
  ['library', FolderOpenOutlined], ['artifacts', HistoryOutlined, 'navFiles'],
] as const;
const officeNavigation = [
  ['current', FileTextOutlined], ['analysis', BarChartOutlined], ['creative', FilePptOutlined],
  ['slides', FilePptOutlined], ['tools', ToolOutlined], ['media', PlaySquareOutlined], ['browser', GlobalOutlined],
] as const;
const extensionNavigation = [['models', ThunderboltOutlined], ['workflows', ApartmentOutlined], ['mcp', ApiOutlined]] as const;
const navigation = [...primaryNavigation, ...officeNavigation, ...extensionNavigation] as const;
type NavItem = typeof navigation[number];

function SidebarMenu({ label, icon: Icon, menu, current, bottom = false }: {
  label: string; icon: typeof AppstoreOutlined; menu: MenuProps; current?: string; bottom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <Dropdown trigger={['click']} placement={bottom ? 'rightBottom' : 'rightTop'} align={{ offset: [12, 0] }} autoFocus
    classNames={{ root: 'sidebar-menu' }} open={open} onOpenChange={visible => setOpen(visible)} menu={{ ...menu, onKeyDown: event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } }}>
    <button ref={trigger} type="button" className={'nav-link' + (current ? ' active' : '') + (bottom ? ' sidebar-settings' : '')}
      aria-haspopup="menu" aria-expanded={open} aria-label={current ? `${label} · ${current}` : label}>
      <Icon /><span>{label}</span>
    </button>
  </Dropdown>;
}

function assistantScope(profile: ReportProfile, files: Loaded[]): AssistantDatasetScope {
  const omitted = new Set(profile.excluded);
  const materialIds = files.filter(file => !omitted.has(file.material.id)
    && profile.sourceIds.some(sourceId => fromSource(file, sourceId))).map(file => file.material.id);
  return { id: profile.id, name: profile.name, sourceIds: profile.sourceIds, materialIds };
}

function reportReviewKey(settings: Settings, sample = false, datasetId?: string) {
  if (!sample && datasetId) return JSON.stringify(['dataset', datasetId, settings.from, settings.to]);
  return JSON.stringify([sample ? 'sample' : 'team', settings.team.trim(), settings.from, settings.to]);
}

function reportMaterials(files: Loaded[]) {
  return files.filter(item => isReportSource(item.material.kind))
    .sort((a, b) => a.material.id < b.material.id ? -1 : a.material.id > b.material.id ? 1 : 0);
}

const incompleteSourceCodes = new Set(['datasetSourceRemoved', 'source_unavailable', 'source_timeout', 'file_access', 'workspace_limit', 'folder_limit']);

function reportScope(
  files: Loaded[], settings: Settings, sources: Source[], selected: string[] | null, excluded: Set<string>, issues: Issue[],
  mappings: Record<string, Mapping>, folderMappings: Record<string, Mapping[]>, overrides?: Record<string, string>,
) {
  const selectedSet = selected && new Set(selected);
  const scan = issues.filter(issue => !issue.sourceId || !selectedSet || selectedSet.has(issue.sourceId));
  if (selectedSet) for (const id of selectedSet) {
    if (!sources.some(source => source.id === id)) scan.push({ code: 'datasetSourceRemoved', detail: '', sourceId: id });
  }
  const mappingChecks = new Map(files.flatMap(({ material, parsed }) => {
    if (parsed?.kind !== 'xlsx') return [];
    const folder = mappingFolder(material);
    return [[material.id, checkMapping(parsed.sheets, mappings[material.id], folder ? folderMappings[folder] ?? [] : [])] as const];
  }));
  const docPeriods = new Map(files.flatMap(({ material, parsed }) => parsed?.kind === 'docx'
    ? [[material.id, documentPeriod(parsed.paragraphs, settings)] as const] : []));
  const included = new Set<string>();
  for (const file of files) {
    const { material, version } = file;
    if (excluded.has(material.id) || (selectedSet && !selectedSet.has(material.sourceId)
      && !file.sourceAliases?.some(id => selectedSet.has(id)))) continue;
    const date = docPeriods.get(material.id);
    if (!date || date.state === 'docInPeriod' || (version && overrides?.[material.id] === version)) included.add(material.id);
    else if (selectedSet && date.state !== 'docOutsidePeriod') scan.push({ code: date.state, detail: material.relative, sourceId: material.sourceId });
  }
  return { mappingChecks, docPeriods, included, reportIssues: scan };
}

export default function App() {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [page, setPage] = useState(() => readLocal('task-home-seen', false) ? readLocal<Page>('page', 'assistant') : 'assistant');
  const [tab, setTab] = useState(() => readLocal<'review' | 'preview'>('report-tab', 'review'));
  const [reportSettingsOpen, setReportSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(() => readLocal<Settings>('settings', { ...period('weekly'), team: '', locale: i18n.language as Locale }));
  const [exampleSettings, setExampleSettings] = useState(sampleSettings);
  const [sources, setSources] = useState<Source[]>([]);
  const [sample, setSample] = useState(false);
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [scanIssues, setScanIssues] = useState<Issue[]>([]);
  const [mappings, setMappings] = useState(() => readLocal<Record<string, Mapping>>('columns', {}));
  const [exampleMappings, setExampleMappings] = useState<Record<string, Mapping>>({});
  const [folderMappings, setFolderMappings] = useState(() => readLocal<Record<string, Mapping[]>>('folder-columns', {}));
  const [excluded, setExcluded] = useState(() => new Set(readLocal<string[]>('excluded', [])));
  const [exampleExcluded, setExampleExcluded] = useState(() => new Set<string>());
  const [realDraft, setRealDraft] = useState<SavedReport | null>(null);
  const [sampleDraft, setSampleDraft] = useState<SavedReport | null>(null);
  const [reportsReady, setReportsReady] = useState(false);
  const [reportSaving, setReportSaving] = useState(false);
  const [datasetStage, setDatasetStage] = useState<'refresh' | 'aggregate' | 'agent' | 'export'>();
  const datasetRun = useRef(false);
  const [profiles, setProfiles] = useState(() => readLocal<ReportProfile[]>('report-profiles', []));
  const [profileId, setProfileId] = useState(() => readLocal<string | undefined>('active-profile', undefined));
  const [scope, setScope] = useState(() => readLocal<string[] | null>('active-scope', null));
  const [decisions, setDecisions] = useState(() => readLocal<Record<string, Record<string, ReviewDecision>>>('review-decisions', {}));
  const [documentInclusions, setDocumentInclusions] = useState(() => readLocal<Record<string, Record<string, string>>>('document-inclusions', {}));
  const [history, setHistory] = useState<ArchivedReport[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyFromDataset, setHistoryFromDataset] = useState(false);
  const [workbenchDataset, setWorkbenchDataset] = useState(() => readLocal<string | undefined>('workbench-dataset', undefined));
  const [datasetScans, setDatasetScans] = useState(() => readLocal<Record<string, DatasetScan>>('dataset-scans', {}));
  const [assistantTasks, setAssistantTasks] = useState<AssistantTask[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [engineStatus, setEngineStatus] = useState('codex_checking');
  const [engineDetails, setEngineDetails] = useState<AgentCliDetails>();
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [assistantKnowledge, setAssistantKnowledge] = useState<{ scope: AssistantDatasetScope; attach: (items: Evidence[]) => void }>();
  const [agentEngine, setAgentEngine] = useState<AgentEngine>(() => {
    const saved = readLocal<string>('agent-engine', 'codex');
    return saved === 'claude' || saved.startsWith('provider:') ? saved as AgentEngine : 'codex';
  });
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>([]);
  const [workflows, setWorkflows] = useState<OfficeWorkflow[]>(() => {
    const stored = readLocal<unknown>('office-workflows', []);
    return validWorkflows(stored) ? stored : [];
  });
  const [workflowIncoming, setWorkflowIncoming] = useState<WorkflowRun>();
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [browserIntake, setBrowserIntake] = useState<BrowserIntake>();
  const workflowAbort = useRef<AbortController | undefined>(undefined);
  const [engineCheck, setEngineCheck] = useState(0);
  const engineName = agentEngine === 'claude' ? 'Claude Code' : agentEngine === 'codex' ? 'Codex' :
    providerProfiles.find(item => 'provider:' + item.id === agentEngine)?.name ?? t('models');
  const knowledgeModels = useMemo<KnowledgeModel[]>(() => providerProfiles.filter(item => item.embeddingModel).map(item => ({
    id: item.id, label: [item.name, item.embeddingModel].join(' · '),
    fingerprint: [item.id, item.baseUrl, item.embeddingModel].join('|'),
    embed: input => providerEmbeddings(item.id, input),
  })), [providerProfiles]);
  const hasCodex = engineStatus === 'codex_ready';
  const [assistantRunning, setAssistantRunning] = useState(false);
  const [assistantWriting, setAssistantWriting] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [creativeBusy, setCreativeBusy] = useState(false);
  const [creativeWriting, setCreativeWriting] = useState(false);
  const [creativeIntake, setCreativeIntake] = useState<CreativeIntake>();
  const [creativeImported, setCreativeImported] = useState<string[]>();
  const [pptBusy, setPptBusy] = useState(false);
  const [pptFocus, setPptFocus] = useState<PptPageLocation>();
  const [backupOpen, setBackupOpen] = useState(false);
  const [assistantReference, setAssistantReference] = useState<AssistantReference>();
  const [toolIntake, setToolIntake] = useState<ToolIntake>();
  const [analysisIntake, setAnalysisIntake] = useState<{ ids: string[]; replace: boolean }>();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [commandArtifactGroup, setCommandArtifactGroup] = useState<string>();
  const [artifactFilter, setArtifactFilter] = useState<string>();
  const [polishing, setPolishing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [packing, setPacking] = useState(false);
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [help, setHelp] = useState(false);
  const [newTaskSignal, setNewTaskSignal] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<SourceSelection>();
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<Preview>();
  const [artifactPreview, setArtifactPreview] = useState<{ id: string; parsed?: Parsed; html?: string; error?: string }>();
  const sourceInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<ImportTarget | undefined>(undefined);
  const scanId = useRef(0);
  const scanController = useRef<AbortController | undefined>(undefined);
  const realSettings = sample ? exampleSettings : settings;
  const activeSources = useMemo(() => sample ? [demoSource()] : sources, [sample, sources]);
  const draft = sample ? sampleDraft : realDraft;
  const reportReading = tab === 'preview' && Boolean(draft) && !reportSettingsOpen;
  const validReportPeriod = Boolean(businessDate(realSettings.from, 'ymd') && businessDate(realSettings.to, 'ymd') && realSettings.from <= realSettings.to);
  const activeMappings = sample ? exampleMappings : mappings;
  const activeExcluded = sample ? exampleExcluded : excluded;
  const locked = busy || picking || polishing || assistantRunning || packing || reportSaving || backupOpen || pptBusy || analysisBusy || creativeBusy || Boolean(datasetStage);
  const pptLocked = locked || exporting || toolBusy || assistantWriting || creativeWriting;
  const workspaceLocked = pptLocked || workflowBusy;
  const reviewKey = reportReviewKey(realSettings, sample, profileId);
  const legacyReviewKey = legacyDatasetReviewKey(realSettings, sample, profileId);
  const reportFiles = useMemo(() => reportMaterials(loaded), [loaded]);
  const docOverrides = documentInclusions[reviewKey] ?? (legacyReviewKey ? documentInclusions[legacyReviewKey] : undefined);
  const selectedSources = sample ? null : scope;
  const { mappingChecks, docPeriods, included, reportIssues } = useMemo(() => reportScope(reportFiles, realSettings, activeSources, selectedSources,
    activeExcluded, scanIssues, activeMappings, sample ? {} : folderMappings, docOverrides),
  [reportFiles, realSettings, activeSources, selectedSources, activeExcluded, scanIssues, activeMappings, sample, folderMappings, docOverrides]);
  const reportDecisions = decisions[reviewKey] ?? (legacyReviewKey ? decisions[legacyReviewKey] : undefined);
  const incompleteDataset = Boolean(!sample && scope && reportIssues.some(issue => incompleteSourceCodes.has(issue.code)));
  const result = useMemo(() => analyze(realSettings, reportFiles, mappingChecks, included, reportIssues, reportDecisions), [realSettings, reportFiles, mappingChecks, included, reportIssues, reportDecisions]);
  const input = useMemo(() => reportInput(realSettings, reportFiles, included, mappingChecks, reportIssues, reportDecisions ?? {}), [realSettings, reportFiles, included, mappingChecks, reportIssues, reportDecisions]);
  const selectedMapping = loaded.find(item => item.material.id === mappingId);
  const selectedHistory = history.find(item => item.id === historyId);
  const datasetActivity = useMemo<DatasetActivity[]>(() => {
    const items: DatasetActivity[] = [];
    const currentKey = realDraft && archiveKey(realDraft);
    for (const record of history) if (record.dataset && record.id !== currentKey) {
      const { report, dataset } = record;
      items.push({ id: record.id, datasetId: dataset.id, kind: 'report', title: reportTitle(report.settings),
        at: record.updatedAt ?? report.createdAt, detail: `${report.settings.from} – ${report.settings.to}` });
    }
    if (realDraft?.dataset) {
      const { report, dataset } = realDraft;
      items.push({ id: report.id, datasetId: dataset.id, kind: 'draft', title: reportTitle(report.settings),
        at: realDraft.updatedAt ?? report.createdAt, detail: `${report.settings.from} – ${report.settings.to}` });
    }
    for (const task of assistantTasks) if (task.dataset && (task.draft || task.request.trim() || task.submittedRequest)) {
      items.push({ id: task.id, datasetId: task.dataset.id, kind: 'agent', at: task.updatedAt,
        title: assistantConversationTitle(task) || t('assistantUntitledConversation'),
        detail: t(task.status === 'complete' ? 'draftReady' : task.status === 'idle' ? 'datasetUnsent' : 'datasetAgentPending') });
    }
    return items;
  }, [realDraft, history, assistantTasks, t]);
  const datasetRefreshes = useMemo(() => Object.fromEntries(Object.entries(datasetScans).map(([id, scan]) => [id, scan.changes])), [datasetScans]);
  const changes = draft?.snapshot && !busy ? inputChanges(draft.snapshot.input, input) : undefined;
  const stale = Boolean(draft && (!draft.snapshot || changes && (changes.other || changes.added.length || changes.changed.length || changes.removed.length)));
  const canGenerate = Boolean(reportsReady && result.usable && realSettings.team.trim() && validReportPeriod && !incompleteDataset);

  async function refresh(list: Source[], force = false, refreshSources?: string[]) {
    scanController.current?.abort('scan_cancelled');
    const controller = new AbortController();
    scanController.current = controller;
    const id = ++scanId.current;
    setBusy(true);
    setProgress(0);
    try {
      const cache = force ? [] : refreshSources ? loaded.filter(file => !refreshSources.some(id => fromSource(file, id))) : loaded;
      const input = await loadMaterials(list, count => { if (scanId.current === id) setProgress(count); }, controller.signal, cache);
      if (id !== scanId.current) return;
      setLoaded(input.loaded);
      setScanIssues(input.issues);
      return input;
    } catch (error) {
      if (id !== scanId.current) return;
      setScanIssues(current => [...current.filter(issue => issue.code !== 'scan_cancelled'), { code: errorCode(error), detail: '' }]);
    } finally {
      if (id === scanId.current) { setBusy(false); scanController.current = undefined; }
    }
  }

  useEffect(() => {
    let active = true;
    void listSources().then(list => {
      if (!active) return;
      setSources(list);
      void refresh(list);
    }).catch(error => { if (active) { setScanIssues([{ code: errorCode(error), detail: '' }]); setBusy(false); } });
    void storedReports().then(items => {
      if (active) { setRealDraft(items.draft); setHistory(items.history); }
    }).catch(() => { if (active) message.error(t('storage_error')); }).finally(() => { if (active) setReportsReady(true); });
    void storedArtifacts().then(items => {
      if (active) setArtifacts(current => [...current, ...items.filter(item => !current.some(added => added.id === item.id))]);
    }).catch(() => {});
    const listeners = nativeDesktop ? [
      listen<boolean>('office-dragging', event => { if (active) setDragging(event.payload); }),
      listen<{ Ok: SourceSelection } | { Err: string }>('office-sources-dropped', event => {
        if (!active) return;
        if ('Ok' in event.payload) setDropped(event.payload.Ok);
        else {
          const code = event.payload.Err;
          setScanIssues(current => [...current, { code, detail: '' }]);
        }
      }),
    ] : [];
    return () => {
      active = false;
      scanId.current++;
      scanController.current?.abort('scan_cancelled');
      for (const listener of listeners) void listener.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let current = true;
    async function detect() {
      try {
        const details = nativeDesktop && (agentEngine === 'codex' || agentEngine === 'claude')
          ? await agentCliDetails(agentEngine).catch(() => undefined) : undefined;
        const status = details?.status ?? await codexStatus(agentEngine);
        if (current) { setEngineDetails(details); setEngineStatus(status); }
      } catch { if (current) { setEngineDetails(undefined); setEngineStatus('codex_failed'); } }
    }
    void detect();
    return () => { current = false; };
  }, [agentEngine, engineCheck]);

  async function refreshProviders() {
    if (nativeDesktop) setProviderProfiles(await listProviders());
  }

  useEffect(() => { void refreshProviders().catch(() => undefined); }, []);

  function recheckEngine() {
    setEngineStatus('codex_checking');
    setEngineDetails(undefined);
    setEngineCheck(current => current + 1);
  }

  function selectAgentEngine(engine: AgentEngine) {
    if (engine === agentEngine || workspaceLocked) return;
    if (persist('agent-engine', engine)) { setAgentEngine(engine); recheckEngine(); }
  }

  useEffect(() => {
    persist('task-home-seen', true);
    if (page !== 'history') persist('page', page);
    if (page !== 'browser') setBrowserIntake(undefined);
  }, [page]);

  function newAssistantTask() {
    setOpenTaskId(undefined);
    setAssistantReference(undefined);
    setPage('assistant');
    setNewTaskSignal(value => value + 1);
  }

  useEffect(() => {
    function onNewTask(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n') return;
      if (workspaceLocked) return;
      event.preventDefault();
      newAssistantTask();
    }
    window.addEventListener('keydown', onNewTask);
    return () => window.removeEventListener('keydown', onNewTask);
  }, [workspaceLocked]);

  useEffect(() => {
    if (!sample) persist('report-tab', tab);
  }, [tab, sample]);

  useEffect(() => {
    if (!dropped || locked) return;
    setDropped(undefined);
    void acceptSources(dropped, page === 'assistant' || page === 'analysis' || page === 'creative' ? page : undefined).catch(error => message.error(trError(error)));
    if (dropped.added && (page === 'artifacts' || page === 'history')) setPage('library');
  }, [dropped, locked]);

  const previewedArtifact = preview?.type === 'artifact' ? artifacts.find(item => item.id === preview.id) : undefined;
  const previewedMaterial = preview?.type === 'material' ? loaded.find(item => item.material.id === preview.id) : undefined;
  const previewedSource = activeSources.find(item => item.id === previewedMaterial?.material.sourceId);
  useEffect(() => {
    if (!previewedArtifact) return;
    const controller = new AbortController();
    const { id, file, kind } = previewedArtifact;
    if (isMedia(kind)) return;
    if (kind === 'html') {
      void file.text().then(html => { if (!controller.signal.aborted) setArtifactPreview({ id, html }); });
      return () => controller.abort();
    }
    void parseArtifact(file, kind, controller.signal).then(parsed => {
      if (!controller.signal.aborted) setArtifactPreview({ id, parsed });
    }).catch(error => { if (!controller.signal.aborted) setArtifactPreview({ id, error: errorCode(error, 'file_parse') }); });
    return () => controller.abort();
  }, [previewedArtifact]);

  const currentPreview = useMemo<PreviewFile | undefined>(() => {
    if (preview?.type === 'material' && previewedMaterial) {
      const item = previewedMaterial.material;
      return { title: item.relative, kind: item.kind, parsed: previewedMaterial.parsed, error: previewedMaterial.error, anchor: preview.anchor, audit: preview.audit,
        location: item.path, bytes: previewedSource ? () => readMaterial(previewedSource, item) : undefined,
        reusePage: item.kind === 'pptx' && previewedSource ? page => reuseSlide({ type: 'material', id: item.id, page }) : undefined,
        attach: previewedMaterial.parsed && !assistantRunning ? () => useAssistant({ materialIds: [item.id] }) : undefined,
        actions: previewedMaterial.parsed && !locked && !toolBusy && !assistantWriting ? materialMenu(previewedMaterial) : undefined,
        open: nativeDesktop && previewedSource && !previewedSource.sample ? () => openMaterial(item) : undefined };
    }
    if (previewedArtifact) {
      const item = previewedArtifact;
      return { title: item.title, kind: item.kind, location: item.savedPath, audit: preview?.audit, anchor: preview?.anchor, media: isMedia(item.kind) ? item.file : undefined,
        reusePage: item.kind === 'pptx' ? page => reuseSlide({ type: 'artifact', id: item.id, page }) : undefined,
        parsed: artifactPreview?.id === item.id ? artifactPreview.parsed : undefined, error: artifactPreview?.id === item.id ? artifactPreview.error : undefined,
        html: artifactPreview?.id === item.id ? artifactPreview.html : undefined,
        browse: nativeDesktop && item.kind === 'html' ? () => openHtmlInBrowser(item.file) : undefined,
        bytes: () => item.file.arrayBuffer(), open: nativeDesktop ? () => openArtifact(artifactName(item), item.file) : undefined,
        save: () => exportArtifact(item), saving: exporting, copy: true };
    }
  }, [preview, previewedArtifact, previewedMaterial, previewedSource, artifactPreview, assistantRunning, locked, toolBusy, assistantWriting, exporting]);

  function useAssistant(reference: AssistantReference) {
    if (assistantRunning) return;
    setOpenTaskId(undefined);
    setAssistantReference(reference);
    setPreview(undefined);
    setEvidence(null);
    setPage('assistant');
  }

  async function openHtmlInBrowser(file: Blob) {
    const url = await invoke<string>('preview_html', { html: await file.text() });
    setPreview(undefined);
    setBrowserIntake({ url, key: crypto.randomUUID() });
    setPage('browser');
  }

  function legacyDatasetReviewKey(settings: Settings, sample: boolean, id?: string) {
    if (!sample && id && profiles.filter(profile => profile.id === id || profile.settings.team.trim() === settings.team.trim()).length === 1) {
      return reportReviewKey(settings);
    }
  }

  function useTool(kind: ToolIntake['kind'], ids: string[], append = false) {
    setToolIntake({ kind, ids, append });
    setPreview(undefined);
    setPage('tools');
  }

  function useAnalysis(ids: string[] = [], replace = false) {
    if (ids.length) setAnalysisIntake({ ids, replace });
    setPreview(undefined);
    setPage('analysis');
  }

  function useCreative(intake?: CreativeIntake) {
    if (intake) setCreativeIntake(intake);
    setPreview(undefined);
    setPage('creative');
  }

  function reportPresentation(record: SavedReport) {
    const { report } = record;
    const lang = dictionaries[report.settings.locale];
    const { total, done, open, unverified } = report.metrics;
    const scope = `${report.settings.from} – ${report.settings.to}`;
    useCreative({ draft: { title: reportTitle(report.settings), sections: sections.map(section => ({
      heading: lang[section], text: report.narrative[section],
    })) }, refs: report.evidence, locale: report.settings.locale, sourceReport: archiveKey(record),
      brief: scope, chart: total > 0 ? {
        title: lang.reportMetrics, source: scope, series: lang.taskTotal, labels: [lang.done, lang.open, lang.unverified],
        values: [done, open, unverified],
      } : undefined });
  }

  function reuseSlide(location: PptPageLocation) {
    setPptFocus(location);
    setPreview(undefined);
    setArtifactPreview(undefined);
    setPage('slides');
  }

  function materialMenu(item: Loaded): MenuProps {
    const { material } = item;
    return {
      items: [
        ...(material.kind === 'pptx' ? [{ key: 'audit', label: t('pptCheck') }, { key: 'reuse', label: t('pptUsePage') }] : []),
        ...(item.parsed?.kind === 'xlsx' ? [{ key: 'analysis', label: t('analysis') }, { key: 'xlsx', label: t('cleanTool') }, { key: 'chart', label: t('includeChart') }] : []),
        ...(material.kind === 'pdf' ? [{ key: 'pdf', label: t('pdfTool') }] : []),
        ...Object.entries(assistantPresets).map(([key, preset]) => ({ key, label: t(preset.label) })),
      ],
      onClick: ({ key }) => {
        if (key === 'audit') setPreview({ type: 'material', id: material.id, audit: true });
        else if (key === 'reuse') reuseSlide({ type: 'material', id: material.id, page: 1 });
        else if (key === 'analysis') useAnalysis([material.id]);
        else if (key === 'xlsx' || key === 'pdf' || key === 'chart') useTool(key, [material.id]);
        else useAssistant({ materialIds: [material.id], preset: key as AssistantPreset });
      },
    };
  }

  const trError = (error: unknown, fallback = 'file_access') => t(errorCode(error, fallback), { engine: engineName, defaultValue: t(fallback, { engine: engineName }) });

  function persist(name: string, value: unknown) {
    try { writeLocal(name, value); return true; }
    catch { message.error(t('storage_error')); return false; }
  }

  function changeSettings(patch: Partial<Settings>) {
    const next = { ...realSettings, ...patch };
    if (sample) setExampleSettings(next);
    else { setSettings(next); persist('settings', next); }
  }

  function selectProfile(id?: string) {
    const profile = profiles.find(item => item.id === id);
    activateProfile(profile);
  }

  function activateProfile(profile?: ReportProfile, nextSettings?: Settings) {
    const id = profile?.id;
    const sources = profile?.sourceIds ?? null;
    const removed = profile?.excluded ?? [];
    setProfileId(id);
    setScope(sources);
    setExcluded(new Set(removed));
    persist('active-profile', id ?? null);
    persist('active-scope', sources);
    persist('excluded', removed);
    if (profile) {
      const next = nextSettings ?? { ...profile.settings, ...period(profile.settings.cadence) };
      setSettings(next);
      persist('settings', next);
    }
  }

  function saveProfile(name: string, existing?: string) {
    const sourceIds = sources.filter(source => (scope === null || scope.includes(source.id)) && (source.directory
      || reportFiles.some(file => fromSource(file, source.id) && !excluded.has(file.material.id)))).map(source => source.id);
    if (!sourceIds.length || !settings.team.trim()) return;
    const id = existing ?? crypto.randomUUID();
    const profile: ReportProfile = { id, name, settings: { team: settings.team, cadence: settings.cadence, locale: settings.locale }, sourceIds,
      excluded: reportFiles.filter(item => sourceIds.some(sourceId => fromSource(item, sourceId)) && excluded.has(item.material.id)).map(item => item.material.id) };
    const position = profiles.findIndex(item => item.id === id);
    const next = position < 0 ? [...profiles, profile] : profiles.map(item => item.id === id ? profile : item);
    if (persist('report-profiles', next)) {
      setProfiles(next);
      setProfileId(id);
      setScope(sourceIds);
      persist('active-profile', id);
      persist('active-scope', sourceIds);
      message.success(t('profileSaved'));
    }
  }

  function removeProfile(id: string) {
    const next = profiles.filter(item => item.id !== id);
    if (!persist('report-profiles', next)) return false;
    setProfiles(next);
    if (profileId === id) activateProfile();
    if (workbenchDataset === id) {
      setWorkbenchDataset(undefined);
      persist('workbench-dataset', null);
    }
    if (datasetScans[id]) {
      const remainingScans = { ...datasetScans };
      delete remainingScans[id];
      if (persist('dataset-scans', remainingScans)) setDatasetScans(remainingScans);
    }
    void deleteKnowledgeIndex(id).catch(() => undefined);
    return true;
  }

  function saveDataset(name: string, sourceIds: string[], existing?: string) {
    const previous = profiles.find(profile => profile.id === existing);
    const ids = [...new Set(sourceIds)].filter(id => sources.some(source => source.id === id) || previous?.sourceIds.includes(id));
    const title = name.trim();
    if (locked || !title || !ids.length || (existing && !previous)) return false;
    const next: ReportProfile = {
      id: previous?.id ?? crypto.randomUUID(),
      name: title,
      sourceIds: ids,
      settings: previous ? { ...previous.settings, team: previous.settings.team === previous.name ? title : previous.settings.team }
        : { team: title, cadence: 'weekly', locale: i18n.language as Locale },
      excluded: previous?.excluded.filter(id => ids.some(sourceId => id.startsWith(`${sourceId}/`)
        || loaded.some(file => file.material.id === id && fromSource(file, sourceId)))) ?? [],
    };
    if (!persist('report-profiles', previous ? profiles.map(item => item.id === next.id ? next : item) : [...profiles, next])) return false;
    setProfiles(current => previous ? current.map(item => item.id === next.id ? next : item) : [...current, next]);
    if (!sample && profileId === next.id) activateProfile(next, { ...settings, team: next.settings.team });
    return next.id;
  }

  function openDatasetReports(id?: string) {
    if (id && locked) return;
    if (id) {
      activateProfile(profiles.find(profile => profile.id === id));
      setTab('review');
      if (sample) { setSample(false); void refresh(sources); }
    }
    setPage('current');
  }

  function chooseWorkbenchDataset(id: string) {
    setWorkbenchDataset(id);
    persist('workbench-dataset', id);
  }

  function openDatasetActivity(item: DatasetActivity) {
    if (pptLocked) return;
    if (item.kind === 'agent') {
      setAssistantReference(undefined);
      setOpenTaskId(item.id);
      setPage('assistant');
      return;
    }
    if (item.kind === 'report') {
      setHistoryFromDataset(true);
      setHistoryId(item.id);
      setPage('history');
      return;
    }
    if (realDraft?.report.id !== item.id) return;
    const profile = profiles.find(item => item.id === realDraft.dataset?.id);
    if (profile) activateProfile(profile, realDraft.report.settings);
    if (sample) { setSample(false); void refresh(sources); }
    setTab('preview');
    setPage('current');
  }

  function useDatasetExcerpts(id: string, pinned: Evidence[]) {
    if (pptLocked || !pinned.length) return;
    const profile = profiles.find(item => item.id === id);
    if (!profile) return;
    const excluded = new Set(profile.excluded);
    const files = loaded.filter(file => !excluded.has(file.material.id) && profile.sourceIds.some(sourceId => fromSource(file, sourceId)));
    const versions = new Map(files.map(file => [file.material.id, file.version]));
    const excerpts = pinned.filter(item => item.locations.length > 0 && item.locations.every(location =>
      location.materialId && location.version && versions.get(location.materialId) === location.version)).slice(0, 6);
    if (!excerpts.length) { message.warning(t('source_unavailable')); return; }
    useAssistant({ dataset: { id, name: profile.name, sourceIds: profile.sourceIds, materialIds: [...versions.keys()] }, pinned: excerpts });
  }

  async function scanDatasetSources(profile: ReportProfile) {
    if (sample) setSample(false);
    const scan = await refresh(sources, false, profile.sourceIds);
    if (!scan) return;
    const snapshot = scanDataset(profile, sources, scan.loaded, scan.issues, datasetScans[profile.id]);
    const next = { ...datasetScans, [profile.id]: snapshot };
    if (persist('dataset-scans', next)) setDatasetScans(next);
    return { ...scan, partial: Boolean(snapshot.changes.partial) };
  }

  async function refreshDatasetById(id: string) {
    const profile = profiles.find(item => item.id === id);
    if (!profile || pptLocked || datasetRun.current) return false;
    datasetRun.current = true;
    setDatasetStage('refresh');
    try { return Boolean(await scanDatasetSources(profile)); }
    finally { datasetRun.current = false; setDatasetStage(undefined); }
  }

  async function openDatasetAgent(id?: string, request?: string, format?: Format) {
    if (!id) { setPage('assistant'); return; }
    if (pptLocked || datasetRun.current) return;
    const profile = profiles.find(item => item.id === id);
    if (!profile) return;
    datasetRun.current = true;
    setDatasetStage('refresh');
    try {
      const scan = await scanDatasetSources(profile);
      if (!scan) { message.warning(t('datasetRefreshFailed')); return; }
      const missingSource = profile.sourceIds.some(sourceId => !sources.some(source => source.id === sourceId));
      if (missingSource || scan.issues.some(issue => !issue.sourceId || profile.sourceIds.includes(issue.sourceId))) {
        message.warning(t('datasetReadWarning'));
      }
      useAssistant({ dataset: assistantScope(profile, scan.loaded), request, format });
      return true;
    } finally {
      datasetRun.current = false;
      setDatasetStage(undefined);
    }
  }

  function toggleLanguage() {
    const locale: Locale = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN';
    localStorage.setItem('report-desk.language', locale);
    void i18n.changeLanguage(locale);
  }

  async function realSources(list: Source[]) {
    if (sample) { setSample(false); setLoaded([]); }
    else if (sources.some(source => !list.some(item => item.id === source.id))) {
      const kept = new Set(list.map(source => source.id));
      setLoaded(current => current.filter(item => kept.has(item.material.sourceId)));
    }
    setSources(list);
    return refresh(list);
  }

  async function acceptSources(selection: SourceSelection, target?: ImportTarget) {
    if (selection.skipped) message.warning(t('skippedImports', { count: selection.skipped }));
    const files = selection.added || (target && selection.selectedIds.length) || (sample && selection.sources.length)
      ? (await realSources(selection.sources))?.loaded : loaded;
    if (!target || !files) return;
    const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase();
    const materialIds = new Set<string>();
    for (const id of selection.selectedIds) {
      const source = selection.sources.find(source => source.id === id);
      const path = source && !source.directory ? normalize(source.path) : undefined;
      for (const { material, parsed } of files) {
        if (parsed && (material.sourceId === id || path === normalize(material.path))) materialIds.add(material.id);
      }
    }
    if (!materialIds.size) {
      if (selection.selectedIds.length) message.warning(t('sourceSelectionEmpty'));
      return;
    }
    if (target === 'assistant') useAssistant({ materialIds: [...materialIds] });
    else if (target === 'analysis') useAnalysis([...materialIds]);
    else if (target === 'creative') { setCreativeImported([...materialIds]); setPage('creative'); }
    else useTool(target, [...materialIds], true);
  }

  async function pick(directory: boolean, target?: ImportTarget) {
    if (!nativeDesktop) {
      importTarget.current = target;
      (directory ? folderInput : sourceInput).current?.click();
      return;
    }
    setPicking(true);
    try {
      await acceptSources(await pickSources(directory), target);
    } catch (error) { message.error(trError(error)); }
    finally { setPicking(false); }
  }

  async function browserPick(files: FileList | null, directory: boolean) {
    const target = importTarget.current;
    importTarget.current = undefined;
    if (!files?.length) return;
    const additions = addBrowserFiles(Array.from(files), directory);
    if (!additions.length) { message.warning(t('no_files')); return; }
    await acceptSources({ added: additions.length, skipped: 0, sources: [...sources, ...additions],
      selectedIds: additions.map(source => source.id) }, target);
  }

  async function detach(source: Source) {
    if (source.sample) { setSample(false); setLoaded([]); await refresh(sources); return; }
    setPicking(true);
    try {
      await removeSource(source);
      await realSources(sources.filter(item => item.id !== source.id));
    } catch (error) { message.error(trError(error)); }
    finally { setPicking(false); }
  }

  async function relocate(source: Source) {
    if (locked) return;
    setPicking(true);
    try {
      const list = await relinkSource(source.id);
      const relocated = list?.find(item => item.id === source.id);
      if (!list || !relocated) return;
      const rules = relinkFolderMappings(source, relocated, folderMappings);
      if (rules !== folderMappings && persist('folder-columns', rules)) setFolderMappings(rules);
      setLoaded(current => current.filter(item => item.material.sourceId !== source.id));
      setSources(list);
      await refresh(list, true);
      message.success(t('sourceRelinked', { name: relocated.name }));
    } catch (error) { message.error(trError(error)); }
    finally { setPicking(false); }
  }

  async function sampleClick() {
    if (sample) { await detach(demoSource()); return; }
    setExampleSettings({ ...sampleSettings, locale: i18n.language as Locale });
    setSample(true);
    setSampleDraft(null);
    setExampleExcluded(new Set());
    setExampleMappings({});
    setTab('review');
    await refresh([demoSource()]);
  }

  function toggleFile(id: string, enabled: boolean) {
    const entry = reportFiles.find(item => item.material.id === id);
    const file = entry?.material;
    const next = new Set(activeExcluded);
    if (!sample && enabled && scope && entry && file && !scope.some(sourceId => fromSource(entry, sourceId))) {
      for (const item of reportFiles) if (fromSource(item, file.sourceId) && item.material.id !== id) next.add(item.material.id);
      const expanded = [...scope, file.sourceId];
      setScope(expanded); persist('active-scope', expanded);
    }
    const date = docPeriods.get(id);
    const manual = date && date.state !== 'docInPeriod' && entry?.version;
    if (manual) {
      const updated = { ...docOverrides };
      if (enabled) updated[id] = manual;
      else delete updated[id];
      const all = { ...documentInclusions, [reviewKey]: updated };
      if (!sample && !persist('document-inclusions', Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith('["sample",'))))) return;
      setDocumentInclusions(all);
    }
    if (enabled) next.delete(id);
    else if (!manual) next.add(id);
    if (sample) setExampleExcluded(next);
    else if (persist('excluded', [...next])) setExcluded(next);
  }

  function toggleSource(id: string, enabled: boolean) {
    const current = scope ?? sources.map(source => source.id);
    const next = enabled ? [...new Set([...current, id])] : current.filter(source => source !== id);
    if (persist('active-scope', next)) setScope(next);
  }

  function saveMapping(file: Loaded, value: Mapping, reuse: boolean) {
    const id = file.material.id;
    const next = { ...activeMappings, [id]: value };
    if (sample) setExampleMappings(next);
    else {
      if (!persist('columns', next)) return;
      setMappings(next);
      const folder = mappingFolder(file.material);
      if (reuse && folder) {
        const rules = [...(folderMappings[folder] ?? []).filter(rule => !sameLayout(rule, value)), value];
        const nextRules = { ...folderMappings, [folder]: rules };
        if (!persist('folder-columns', nextRules)) return;
        setFolderMappings(nextRules);
      }
    }
    setMappingId(null);
  }

  function removeFolderMapping(file: Loaded, value: Mapping) {
    const folder = mappingFolder(file.material);
    if (!folder) return;
    const next = { ...folderMappings, [folder]: (folderMappings[folder] ?? []).filter(rule => !sameLayout(rule, value)) };
    if (persist('folder-columns', next)) setFolderMappings(next);
  }

  async function generate() {
    if (locked || !reportsReady) return;
    if (incompleteDataset) { message.warning(t('datasetSourceBlocked')); return; }
    if (!realSettings.team.trim()) { message.warning(t('invalidTeam')); return; }
    if (!validReportPeriod) {
      message.warning(t('invalidPeriod')); return;
    }
    if (!result.usable) { message.warning(t('noUsable')); return; }
    const profile = !sample && profiles.find(item => item.id === profileId);
    const dataset = profile && scope && scope.length === profile.sourceIds.length && scope.every(id => profile.sourceIds.includes(id))
      ? { id: profile.id, name: profile.name, sourceIds: [...scope] } : undefined;
    const next = { dataset, report: createReport(realSettings, result, sample), snapshot: { input, details: reportDetails(result) } };
    const previous = !sample && draft && !history.some(item => item.id === archiveKey(draft)) ? draft : undefined;
    if (await applyDraft(next, previous)) setTab('preview');
  }

  async function runDatasetReport(id: string, cadence: Cadence, instructions: string, withAgent: boolean, previousPeriod: boolean, outputs: ArtifactKind[] = []) {
    const profile = profiles.find(item => item.id === id);
    const reportSources = profile?.sourceIds;
    if (!profile || !reportSources?.length || pptLocked || !reportsReady || datasetRun.current) return false;
    const nextSettings = { ...profile.settings, ...quickPeriod(cadence, previousPeriod) };
    if (withAgent && !hasCodex) { message.warning(t('codexMissingDesktop', { engine: engineName })); return false; }
    const key = reportReviewKey(nextSettings, false, id);
    const legacy = legacyDatasetReviewKey(nextSettings, false, id);
    const currentDecisions = decisions[key] ?? (legacy ? decisions[legacy] : undefined);
    const currentOverrides = documentInclusions[key] ?? (legacy ? documentInclusions[legacy] : undefined);
    datasetRun.current = true;
    setDatasetStage('refresh');
    try {
      activateProfile(profile, nextSettings);
      const scanned = await scanDatasetSources(profile);
      if (!scanned) { message.warning(t('datasetRefreshFailed')); return false; }
      setDatasetStage('aggregate');
      const files = reportMaterials(scanned.loaded);
      const { mappingChecks, included, reportIssues } = reportScope(files, nextSettings, sources, reportSources,
        new Set(profile.excluded), scanned.issues, mappings, folderMappings, currentOverrides);
      const data = analyze(nextSettings, files, mappingChecks, included, reportIssues, currentDecisions);
      const unavailable = reportIssues.some(issue => incompleteSourceCodes.has(issue.code));
      if (unavailable || !data.usable || (!data.metrics.total && !data.metrics.documents)) {
        setTab('review');
        setPage('current');
        message.warning(t(unavailable ? 'datasetSourceBlocked' : data.usable ? 'reportNoPeriodRows' : 'noUsable'));
        return false;
      }
      const next = { dataset: { id, name: profile.name, sourceIds: reportSources }, report: createReport(nextSettings, data, false), snapshot: {
        input: reportInput(nextSettings, files, included, mappingChecks, reportIssues, currentDecisions ?? {}), details: reportDetails(data),
      } };
      const previous = realDraft && !history.some(item => item.id === archiveKey(realDraft)) ? realDraft : undefined;
      if (!await applyDraft(next, previous)) return false;
      if (data.issues.length) message.warning(t('datasetReviewWarning', { count: data.issues.length }));
      setTab('preview');
      if (!outputs.length) setPage('current');
      let finished: SavedReport = next;
      if (withAgent && hasCodex) {
        setDatasetStage('agent');
        const polished = await polishDraft(next, data, instructions);
        if (polished) finished = polished;
        else {
          message.info(t('datasetBaseSaved'));
          if (outputs.length) return false;
        }
      }
      if (outputs.length) return await generateCommandFiles(finished, outputs);
      return true;
    } finally {
      datasetRun.current = false;
      setDatasetStage(undefined);
    }
  }

  async function runOfficeCommand(id: string, request: string, plan: OfficeCommandPlan) {
    if (workspaceLocked) return false;
    const matches = matchingWorkflows(workflows, request);
    if (matches.length === 1) {
      setWorkflowIncoming({ workflow: matches[0]!, datasetId: id, request, token: crypto.randomUUID() });
      setPage('workflows');
      return true;
    }
    if (matches.length > 1) { setPage('workflows'); message.info(t('workflow_ambiguous')); return false; }
    if (plan.kind === 'clarify') return false;
    if (plan.kind === 'agent') return Boolean(await openDatasetAgent(id, request, plan.format));
    return runDatasetReport(id, plan.cadence, request, plan.withAgent, plan.previous, plan.outputs);
  }

  async function executeWorkflow(job: WorkflowRun, update: StepUpdate) {
    if (workspaceLocked || workflowAbort.current) return;
    if (!validWorkflows([job.workflow])) { message.error(t('workflow_failed')); return; }
    const controller = new AbortController();
    workflowAbort.current = controller;
    setWorkflowBusy(true);
    const group = 'workflow-' + job.token;
    const profile = profiles.find(item => item.id === job.datasetId);
    let draft: import('./office').OfficeDraft | undefined;
    let refs: Evidence[] = [];
    let deck: ReturnType<typeof newCreativeProject> | undefined;
    try {
      const scan = profile && await scanDatasetSources(profile);
      const files = scan && profile ? scan.loaded.filter(file => !profile.excluded.includes(file.material.id)
        && profile.sourceIds.some(id => fromSource(file, id))) : [];
      if (profile && !scan) throw 'source_unavailable';
      const locale = profile?.settings.locale ?? i18n.language as Locale;
      await runWorkflow(job, async (step, previous) => {
        const prompt = expandWorkflow(step.instructions || '{{input}}', job.request, previous).slice(0, 14000);
        if (step.kind === 'mcp') {
          if (!step.server || !step.tool) throw 'workflow_mcp';
          let argumentsObject: Record<string, unknown>;
          try { argumentsObject = workflowArguments(step.instructions, job.request, previous); } catch { throw 'workflow_mcp'; }
          const result = await mcpCall(step.server, step.tool, argumentsObject);
          if (result.isError) throw 'workflow_mcp';
          return { text: JSON.stringify(result.structuredContent ?? result.content ?? []).slice(0, 14000) };
        }
        if (step.kind === 'report') {
          if (!profile) throw 'workflow_dataset';
          const nextSettings = { ...profile.settings, ...quickPeriod(profile.settings.cadence, false) };
          const currentFiles = reportMaterials(files);
          const key = reportReviewKey(nextSettings, false, profile.id);
          const scope = reportScope(currentFiles, nextSettings, sources, profile.sourceIds, new Set(profile.excluded), scan ? scan.issues : [],
            mappings, folderMappings, documentInclusions[key]);
          const data = analyze(nextSettings, currentFiles, scope.mappingChecks, scope.included, scope.reportIssues, decisions[key]);
          if (!data.usable || scope.reportIssues.some(issue => incompleteSourceCodes.has(issue.code))) throw 'noUsable';
          const report = createReport(nextSettings, data, false);
          refs = report.evidence;
          draft = { title: reportTitle(nextSettings), sections: sections.map(key => ({ heading: dictionaries[locale][key], text: report.narrative[key] })) };
          deck = undefined;
          return { text: Object.values(report.narrative).join('\n\n') };
        }
        if (step.kind === 'draft') {
          if (!hasCodex) throw 'provider_missing';
          const input = assistantInput(prompt, 'answer', files, [], undefined);
          draft = await runOffice(input.payload, locale, agentEngine);
          refs = input.refs;
          deck = undefined;
          return { text: draft.sections.map(section => section.text).join('\n\n') };
        }
        let file: Blob;
        const kind = step.kind;
        if (isMedia(kind)) {
          const field = kind === 'png' ? 'imageModel' : kind === 'mp3' ? 'ttsModel' : 'videoModel';
          const provider = providerProfiles.find(item => 'provider:' + item.id === agentEngine && item[field])
            ?? providerProfiles.find(item => item[field]);
          if (!provider) throw 'provider_model';
          if (kind === 'mp4') {
            let video = await startVideo(provider.id, prompt, '720x1280', 4);
            const expires = Date.now() + 180000;
            while (!['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'expired'].includes(video.status)) {
              if (controller.signal.aborted || Date.now() >= expires) throw 'provider_timeout';
              await new Promise(resolve => window.setTimeout(resolve, 3000));
              video = await videoStatus(provider.id, video.id);
            }
            if (!['completed', 'succeeded'].includes(video.status)) throw 'provider_failed';
            file = await providerMedia(provider.id, 'mp4', video.id);
          } else file = await providerMedia(provider.id, kind, prompt);
        } else {
          const source = draft ?? { title: job.workflow.name, sections: [{ heading: job.workflow.name, text: previous || prompt }] };
          if (kind === 'docx') file = await makeWord(source, locale, refs);
          else {
            deck ??= { ...newCreativeProject(source.title, locale), refs, pages: pagesFromDraft(source) };
            const { creativeHtml, creativePdf, creativePptx } = await import('./creative-output');
            file = kind === 'pptx' ? await creativePptx(deck) : kind === 'html' ? creativeHtml(deck) : await creativePdf(deck);
          }
        }
        if (controller.signal.aborted) throw 'codex_cancelled';
        const [artifact] = await deliverArtifacts([{ title: draft?.title ?? job.workflow.name, kind, file, detail: job.workflow.name }], group, false, step.id);
        return { text: '', files: artifact ? [artifact.id] : [] };
      }, update, controller.signal);
    } catch (error) { message.error(trError(error, 'workflow_failed')); }
    finally { workflowAbort.current = undefined; setWorkflowBusy(false); }
  }

  async function runAssistantDatasetCommand(id: string, request: string, plan: OfficeCommandPlan) {
    if (plan.kind !== 'report') return false;
    const completed = await runOfficeCommand(id, request, plan);
    if (completed) {
      setReportSettingsOpen(false);
      setPage('current');
    }
    return completed;
  }

  async function applyDraft(next: SavedReport, previous?: SavedReport) {
    if (next.report.sample) { setSampleDraft(next); return true; }
    setReportSaving(true);
    try {
      const archived = await storeReportDraft(next, previous);
      setRealDraft(next);
      if (archived) setHistory(current => [archived, ...current.filter(item => item.id !== archived.id)]);
      return true;
    } catch { message.error(t('storage_error')); return false; }
    finally { setReportSaving(false); }
  }

  function decide(key: string, value?: ReviewDecision) {
    const current = { ...reportDecisions };
    if (value) current[key] = value;
    else delete current[key];
    const next = { ...decisions, [reviewKey]: current };
    if (!sample && !persist('review-decisions', Object.fromEntries(Object.entries(next).filter(([name]) => !name.startsWith('["sample",'))))) return;
    setDecisions(next);
    if (value) message.success(t('decisionSaved'));
  }

  async function runCodex() {
    if (!draft || stale || locked) return;
    await polishDraft(draft, result);
  }

  async function polishDraft(original: SavedReport, data: Analysis, instructions = '') {
    const { payload, evidence: items } = codexInput(original.report, data, instructions);
    setPolishing(true);
    try {
      const narrative = await polishReport(payload, original.report.settings.locale, agentEngine);
      const refs = new Set(items.map(item => item.id));
      const output = Object.values(narrative).join('\n');
      if (!output.trim() || Array.from(output.matchAll(/\[([TD]\d+)\]/g)).some(match => !refs.has(match[1]!))) throw 'codex_output';
      const next = { ...original, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(),
        report: { ...original.report, narrative, evidence: items, polished: true } };
      if (!await applyDraft(next)) return false;
      message.success(t('codexDone'));
      return next;
    } catch (error) {
      if (errorCode(error) === 'codex_cancelled') message.info(t('codexStopped'));
      else message.error(trError(error, 'codex_failed'));
      return false;
    } finally { setPolishing(false); }
  }

  async function saveWord(report: Report) {
    setExporting(true);
    try {
      const { renderDocx } = await import('./report-doc');
      const title = reportTitle(report.settings).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim().slice(0, 85);
      const location = await saveArtifact(`${title}-${report.settings.from}.docx`, await renderDocx(report));
      if (location) message.success(t('exported', { path: location }));
    } catch (error) { message.error(trError(error, 'export_failed')); }
    finally { setExporting(false); }
  }

  async function reportFile(report: Report, kind: 'docx' | 'pptx'): Promise<NewArtifact> {
    const title = `${reportTitle(report.settings)} ${report.settings.from}`;
    if (kind === 'docx') {
      const { renderDocx } = await import('./report-doc');
      return { title, kind, file: await renderDocx(report), detail: report.narrative.summary.slice(0, 140) };
    }
    const language = dictionaries[report.settings.locale];
    const m = report.metrics;
    const metrics = `${language.taskTotal} ${m.total}   ·   ${language.done} ${m.done}   ·   ${language.open} ${m.open}   ·   ${language.unverified} ${m.unverified}`;
    const parts = sections.map(key => ({ heading: language[key], text: report.narrative[key] }));
    const values = [{ label: language.taskTotal, value: m.total }, { label: language.done, value: m.done },
      { label: language.open, value: m.open }, { label: language.unverified, value: m.unverified }];
    return { title, kind, file: await makeSlides({ title, sections: parts }, report.evidence, report.settings.locale, { overview: { title: language.reportMetrics, values } }), detail: metrics };
  }

  async function reportArtifact(record: SavedReport, kind: 'docx' | 'pptx') {
    try {
      const group = reportGroup(record);
      await deliverArtifacts([await reportFile(record.report, kind)], group, !group);
    } catch (error) { message.error(trError(error, 'export_failed')); }
  }

  async function generateCommandFiles(record: SavedReport, outputs: ArtifactKind[]) {
    const { report, snapshot } = record;
    const title = `${reportTitle(report.settings)} ${report.settings.from}`;
    const language = dictionaries[report.settings.locale];
    const presentation = { ...newCreativeProject(title, report.settings.locale), refs: report.evidence,
      pages: pagesFromDraft({ title, sections: sections.map(section => ({ heading: language[section], text: report.narrative[section] })) }) };
    setDatasetStage('export');
    const results = await Promise.allSettled(outputs.map(async (kind): Promise<NewArtifact> => {
      if (kind === 'docx') return reportFile(report, kind);
      if (kind === 'xlsx') {
        if (!snapshot) throw 'export_failed';
        return detailFile(report.settings, snapshot.details);
      }
      const { creativeHtml, creativePdf, creativePptx } = await import('./creative-output');
      const file = kind === 'pptx' ? await creativePptx(presentation) : kind === 'html' ? creativeHtml(presentation) : await creativePdf(presentation);
      const detail = language.creativePageCount.replace('{{count}}', String(creativeExportPages(presentation).length));
      return { title, kind, file, detail };
    }));
    const files = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const group = reportGroup(record);
    try {
      if (files.length) {
        await deliverArtifacts(files, group);
        setCommandArtifactGroup(group);
      }
    }
    catch (error) { message.error(trError(error, 'export_failed')); return false; }
    const failed = outputs.filter((_, index) => results[index]?.status === 'rejected');
    if (failed.length) {
      message.warning(t('datasetCommandPartial', { formats: failed.map(kind => kind.toUpperCase()).join(', ') }));
      return false;
    }
    return true;
  }

  async function exportDetails() {
    try { await deliverArtifacts([await detailFile(realSettings, reportDetails(result))], undefined, true); }
    catch (error) { message.error(trError(error, 'export_failed')); }
  }

  async function makeReportPack(record: SavedReport, existing: Artifact[]) {
    const { report, snapshot } = record;
    const group = reportGroup(record);
    if (packing || reportSaving || !snapshot || !group) return;
    setPacking(true);
    try {
      const kinds = (['docx', 'xlsx', 'pptx'] as const).filter(kind => !existing.some(file => file.kind === kind));
      const files = await Promise.all(kinds.map(kind => kind === 'xlsx' ? detailFile(report.settings, snapshot.details) : reportFile(report, kind)));
      if (files.length) await deliverArtifacts(files, group, false);
    } catch (error) { message.error(trError(error, 'export_failed')); }
    finally { setPacking(false); }
  }

  async function saveReportPack(report: Report, files: Artifact[]) {
    await saveWorkFiles(reportTitle(report.settings) + ' ' + report.settings.from, files);
  }

  async function saveWorkFiles(title: string, files: Artifact[]) {
    if (exporting || !files.length) return;
    setExporting(true);
    try {
      const fileName = artifactName({ title, kind: 'docx' }).replace(/\.docx$/, '.zip');
      const zip = await packageFiles(files.map(item => ({ name: artifactName(item), file: item.file })));
      const path = await saveArtifact(fileName, zip);
      if (path) message.success(t('exported', { path }));
    } catch (error) { message.error(trError(error, 'export_failed')); }
    finally { setExporting(false); }
  }

  function packControls(record: SavedReport) {
    const group = reportGroup(record);
    if (!group) return;
    const files = artifacts.filter(item => item.group === group);
    return {
      files, busy: packing, preview: (id: string) => setPreview({ type: 'artifact', id }),
      create: () => void makeReportPack(record, files), save: () => void saveReportPack(record.report, files),
    };
  }

  async function archiveReport(record: SavedReport) {
    setReportSaving(true);
    try {
      const entry = await storeReportArchive(record);
      setHistory(current => [entry, ...current.filter(item => item.id !== entry.id)]);
      message.success(t('archived'));
      return entry.id;
    } catch { message.error(t('storage_error')); return undefined; }
    finally { setReportSaving(false); }
  }

  async function removeHistory(id: string) {
    setReportSaving(true);
    try {
      await deleteReportArchive(id);
      setHistory(current => current.filter(item => item.id !== id));
      setHistoryId(current => current === id ? null : current);
    } catch { message.error(t('storage_error')); }
    finally { setReportSaving(false); }
  }

  async function editReport(record: SavedReport, narrative: Narrative, archived: boolean) {
    if (sections.every(section => record.report.narrative[section] === narrative[section])) return true;
    const next = { ...record, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(),
      report: { ...record.report, narrative } };
    if (!archived) return applyDraft(next);
    const id = await archiveReport(next);
    if (id) setHistoryId(id);
    return Boolean(id);
  }

  async function addArtifact(title: string, kind: ArtifactKind, file: Blob, detail: string) {
    await deliverArtifacts([{ title, kind, file, detail }], undefined, true);
  }

  async function deliverArtifacts(files: NewArtifact[], group?: string, focus = false, stepId?: string) {
    if (files.some(item => item.file.size > FILE_LIMIT)) throw 'export_limit';
    const createdAt = new Date().toISOString();
    const items: Artifact[] = files.map(file => ({ ...file, group, createdAt, id: group ? [group, stepId, file.kind].filter(Boolean).join('-') : crypto.randomUUID() }));
    try { await storeArtifacts(items); }
    catch { throw 'storage_error'; }
    const ids = new Set(items.map(item => item.id));
    setArtifacts(current => [...items, ...current.filter(item => !ids.has(item.id))]);
    message.success(files.length > 1 ? t('filesDelivered', { count: files.length }) : t('draftSaved'));
    if (focus) setPage('artifacts');
    return items;
  }

  async function exportArtifact(artifact: Artifact) {
    setExporting(true);
    try {
      const path = await saveArtifact(artifactName(artifact), artifact.file);
      if (path) {
        if (nativeDesktop) await updateArtifact({ ...artifact, savedPath: path });
        message.success(t('exported', { path }));
      }
    } catch (error) { message.error(trError(error, 'export_failed')); }
    finally { setExporting(false); }
  }

  async function removeArtifact(id: string) {
    try { await deleteArtifact(id); setArtifacts(current => current.filter(item => item.id !== id)); }
    catch { message.error(t('storage_error')); }
  }

  async function updateArtifact(item: Artifact) {
    try { await storeArtifact(item); setArtifacts(current => current.map(previous => previous.id === item.id ? item : previous)); }
    catch { message.error(t('storage_error')); }
  }

  function locationFile(location: Location) {
    return loaded.find(file => (location.materialId ? file.material.id === location.materialId : file.material.path === location.path)
      && (!location.version || file.version === location.version));
  }

  function showLocation(location: Location) {
    const file = locationFile(location);
    if (!file) return;
    setEvidence(null);
    setPreview({ type: 'material', id: file.material.id, anchor: location.at });
  }

  function reportInputNotice() {
    if (busy || !reportsReady) return null;
    if (incompleteDataset) return <Alert type="warning" showIcon title={t('datasetSourceBlocked')}
      action={<Button size="small" onClick={() => setPage('data')}>{t('data')}</Button>} />;
    if (!activeSources.length) return null;
    if (!validReportPeriod) return <Alert type="warning" showIcon title={t('invalidPeriod')} />;
    if (result.usable && !realSettings.team.trim()) {
      return <Alert type="info" showIcon title={t('invalidTeam')}
        action={<Button size="small" onClick={() => document.getElementById('team')?.focus()}>{t('team')}</Button>} />;
    }
    if (result.usable) {
      return result.tasks.length || result.notes.length ? null : <Alert type="info" showIcon title={t('reportNoPeriodRows')} />;
    }
    const unmapped = reportFiles.find(item => included.has(item.material.id) && mappingChecks.has(item.material.id) && !mappingChecks.get(item.material.id)?.mapping);
    if (unmapped) return <Alert type="warning" showIcon title={t('reportMapNext', { name: unmapped.material.relative })}
      action={<Button size="small" disabled={locked} onClick={() => setMappingId(unmapped.material.id)}>{t('needsMapping')}</Button>} />;
    const reportDoc = reportFiles.find(item => item.parsed?.kind === 'docx' && !included.has(item.material.id)
      && (!selectedSources || selectedSources.some(id => fromSource(item, id))) && docPeriods.get(item.material.id)?.state !== 'docInPeriod');
    if (reportDoc) return <Alert type="info" showIcon title={t('reportCheckSourcePeriod', { name: reportDoc.material.relative })}
      action={<Button size="small" onClick={() => setPreview({ type: 'material', id: reportDoc.material.id })}>{t('filePreview')}</Button>} />;
    return <Alert type="info" showIcon title={t('noUsable')} />;
  }

  function sourcesPanel(report: boolean) {
    const files = report ? reportFiles : loaded;
    const groups = new Map<string, Loaded[]>();
    if (report) for (const file of files) {
      const id = selectedSources?.find(sourceId => fromSource(file, sourceId)) ?? file.material.sourceId;
      const items = groups.get(id);
      if (items) items.push(file);
      else groups.set(id, [file]);
    }
    return <section className="panel source-panel" aria-label={t(report ? 'inputTitle' : 'sourceFiles')}>
      <div className="panel-header"><h2>{t(report ? 'inputTitle' : 'sourceFiles')}</h2>{report && <p>{t('inputCaption')}</p>}</div>
      <div className="source-actions">
        <Button icon={<FolderOpenOutlined />} disabled={locked} onClick={() => void pick(true)}>{t('addFolder')}</Button>
        <Button icon={<PlusOutlined />} disabled={locked} onClick={() => void pick(false)}>{t('addFiles')}</Button>
      </div>
      {busy ? <div className="loading-sources" role="status"><Spin size="small" /> {t('readProgress', { count: progress })}
        <Button size="small" onClick={() => scanController.current?.abort('scan_cancelled')}>{t('cancel')}</Button></div> :
        activeSources.length === 0 ? <Blank kind="folder" title={t('sourceEmpty')} body={t('sourceEmptyBody')} /> :
          <div className="source-body">
            <div className="source-count">{report ? t('selected', { picked: included.size, total: files.length }) : t('folderCount', { count: files.length })}</div>
            {activeSources.map(source => {
              const items = report ? groups.get(source.id) ?? [] : files.filter(item => fromSource(item, source.id));
              const visible = report || expandedSources.has(source.id) ? items : items.slice(0, 6);
              const unavailable = scanIssues.find(issue => issue.sourceId === source.id
                && ['source_unavailable', 'file_access', 'source_timeout'].includes(issue.code));
              return <div className="source-group" key={source.id}>
                <div className="source-group-title">
                  {report && !sample && <Checkbox checked={scope === null || scope.includes(source.id)} disabled={locked}
                    aria-label={t('selectSource', { name: source.name })} title={t('selectSource', { name: source.name })}
                    onChange={event => toggleSource(source.id, event.target.checked)} />}
                  <span className="group-icon">{source.directory ? <FolderOpenOutlined /> : <FileTextOutlined />}</span>
                  <div className="min-w-0 flex-1"><strong title={source.path}>{source.name}</strong>
                    {unavailable ? <small className="error-text">{t(unavailable.code)}</small>
                      : source.directory && <small>{t('folderCount', { count: items.length })}</small>}</div>
                  <Button type="text" size="small" disabled={locked} aria-label={`${t('remove')} ${source.name}`} title={t('remove')} icon={<CloseOutlined />}
                    onClick={() => void detach(source)} />
                  {nativeDesktop && !source.sample && <Button type="text" size="small" disabled={locked} aria-label={t('chooseSourcePath', { name: source.name })}
                    title={t('relinkSource')} icon={<SwapOutlined />} onClick={() => void relocate(source)} />}
                </div>
                {visible.map(item => {
                  const { material } = item;
                  const Icon = fileIcons[material.kind];
                  const mapping = report ? mappingChecks.get(material.id) : undefined;
                  const date = report ? docPeriods.get(material.id) : undefined;
                  const periodText = date?.range && (date.range.from === date.range.to ? date.range.from : date.range.from + ' – ' + date.range.to);
                  const picked = included.has(material.id);
                  return <div className="source-file" key={material.id}>
                    {report && <Checkbox checked={included.has(material.id)} disabled={locked} aria-label={material.relative} onChange={event => toggleFile(material.id, event.target.checked)} />}
                    <span className={`file-kind ${material.kind}`}><Icon /></span>
                    <div className="file-caption" title={material.path}><span>{material.relative}</span>
                      {item.error && <small className="error-text">{t(item.error)}</small>}
                      {item.parsed && 'pageCount' in item.parsed && <small>{t('pageCount', { count: item.parsed.pageCount })}</small>}
                      {mapping && <small className={mapping.mapping ? '' : 'error-text'}>{t(mapping.state)}</small>}
                      {date && <small title={periodText || undefined}>{t(date.state)}{periodText && ' · ' + periodText}
                        {picked && date.state !== 'docInPeriod' && ' · ' + t('docManuallyIncluded')}</small>}</div>
                    {mapping && <Button size="small" type="text" className="map-action" disabled={locked} onClick={() => setMappingId(material.id)}>{t(mapping.mapping ? 'mapping' : 'needsMapping')}</Button>}
                    <Button size="small" type="text" icon={<EyeOutlined />} aria-label={`${t('filePreview')} ${material.relative}`} title={t('filePreview')}
                      onClick={() => setPreview({ type: 'material', id: material.id })} />
                    {!report && item.parsed && <Dropdown trigger={['click']} menu={materialMenu(item)}><Button size="small" type="text" disabled={locked || toolBusy || assistantWriting} icon={<MoreOutlined />}
                      aria-label={t('useThisFile', { name: material.relative })} title={t('materialActions')} /></Dropdown>}
                  </div>;
                })}
                {!report && items.length > 6 && <Button className="source-expand" size="small" type="link"
                  onClick={() => setExpandedSources(current => {
                    const next = new Set(current);
                    if (next.has(source.id)) next.delete(source.id); else next.add(source.id);
                    return next;
                  })}>{t(visible.length === items.length ? 'collapseFiles' : 'expandFiles', { count: items.length })}</Button>}
              </div>;
            })}
            {!report && scanIssues.map((issue, index) => <p className="error-text" key={index}>{issue.detail} · {t(issue.code)}</p>)}
          </div>}
      <div className="source-foot">{t(report && activeSources.length ? 'docHint' : 'fileTypes')}</div>
    </section>;
  }

  const settingsItems: MenuProps['items'] = [
    { key: 'agent', icon: <SettingOutlined />, label: t('agentSettings'), onClick: () => setAgentSettingsOpen(true) },
    { key: 'backup', icon: <HddOutlined />, label: t('workspaceBackup'), disabled: workspaceLocked, onClick: () => setBackupOpen(true) },
    { key: 'language', icon: <GlobalOutlined />, label: i18n.language === 'zh-CN' ? 'English' : '简体中文', onClick: toggleLanguage },
    { key: 'help', icon: <QuestionCircleOutlined />, label: t('help'), onClick: () => setHelp(true) },
  ];

  function navigate(item: Page) {
    if (item === 'artifacts') setArtifactFilter(undefined);
    setPage(item);
  }

  function navigationMenu(items: readonly NavItem[], label: string, icon: typeof AppstoreOutlined) {
    const current = items.find(([item]) => item === page);
    return <SidebarMenu label={label} icon={icon} current={current && t(current[0])} menu={{
      items: items.map(([item, ItemIcon]) => ({ key: item, icon: <ItemIcon />, label: t(item), onClick: () => navigate(item) })),
      selectable: true, selectedKeys: [page],
    }} />;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand" title={t('brand')}><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span></div>
      <Button className="sidebar-new-task" type="text" icon={<PlusOutlined />} disabled={workspaceLocked} aria-label={t('navNew')}
        title={t('navNew') + ' · Ctrl+N'} onClick={newAssistantTask} />
      <nav className="main-nav" aria-label={t('workspace')}>
        <div className="nav-primary">{primaryNavigation.map(([item, Icon, label = item]) => {
          const active = page === item || (item === 'artifacts' && page === 'history');
          return <button key={item} type="button" className={active ? 'nav-link active' : 'nav-link'} aria-label={t(item)} title={t(item)}
            aria-current={active ? 'page' : undefined} onClick={() => navigate(item)}><Icon /><span>{t(label)}</span></button>;
        })}</div>
        {navigationMenu(officeNavigation, t('navActions'), AppstoreOutlined)}
        {navigationMenu(extensionNavigation, t('navExtensions'), BlockOutlined)}
      </nav>
      <SidebarMenu label={t('navSettings')} icon={SettingOutlined} menu={{ items: settingsItems }} bottom />
    </aside>
    <div className="main-shell">
      <header className="top-bar">
        <div className="breadcrumb"><strong>{t(page)}</strong>{sample && <Tag color="gold">{t('sampleBadge')}</Tag>}</div>
        <WorkspaceSearch files={loaded} artifacts={artifacts} pages={navigation.map(([key]) => ({ key, label: t(key) }))} navigate={key => navigate(key as Page)} material={id => setPreview({ type: 'material', id })} artifact={id => setPreview({ type: 'artifact', id })} locate={showLocation} />
        <div className="top-actions">
          <Select<AgentEngine> aria-label={t('agentEngine')} variant="borderless" className="engine-select" value={agentEngine}
            disabled={workspaceLocked} options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' },
              ...providerProfiles.filter(item => item.textModel).map(item => ({ value: `provider:${item.id}` as const, label: item.name }))]}
            onChange={selectAgentEngine} />
          {assistantRunning && page !== 'assistant' && <Button type="text" icon={<ThunderboltOutlined />} onClick={() => setPage('assistant')}>{t('assistantReturnToTask')}</Button>}
        </div>
      </header>
      <main className={'main-content' + (page === 'assistant' ? ' assistant-main' : page === 'creative' ? ' creative-main' : '')}>
        {page === 'data' && <DataWorkbench profiles={profiles} sources={sources} files={sample ? [] : loaded} sourceIssues={sample ? [] : scanIssues}
          busy={workspaceLocked || !reportsReady} engineReady={hasCodex} modeLabel={t(engineStatus, { engine: engineName })} runStage={datasetStage} activeDatasetId={workbenchDataset ?? profileId}
          knowledgeModels={knowledgeModels} openKnowledgeSettings={() => setPage('models')}
          activity={datasetActivity} datasetRefreshes={datasetRefreshes} onSelectDataset={chooseWorkbenchDataset}
          onOpenActivity={openDatasetActivity} onRefreshDataset={refreshDatasetById} onRunCommand={runOfficeCommand}
          onUseExcerpts={useDatasetExcerpts}
          addSources={folder => { if (!pptLocked) void pick(folder); }} openLibrary={() => setPage('library')}
          openReports={openDatasetReports} openAnalysis={ids => { if (!pptLocked) useAnalysis(ids, Boolean(ids?.length)); }} openAgent={id => void openDatasetAgent(id)}
          openArtifacts={() => { setArtifactFilter(undefined); setPage('artifacts'); }}
          openCommandArtifacts={() => { setArtifactFilter(commandArtifactGroup); setPage('artifacts'); }}
          onPreviewFile={(id, anchor) => setPreview({ type: 'material', id, anchor })}
          createDataset={(name, ids) => saveDataset(name, ids)} editDataset={(id, name, ids) => Boolean(saveDataset(name, ids, id))}
          deleteDataset={removeProfile} runReport={runDatasetReport} />}
        {page === 'models' && <ModelWorkbench profiles={providerProfiles} changed={async () => {
          await refreshProviders();
          recheckEngine();
        }} deliver={deliverArtifacts} openArtifacts={() => { setArtifactFilter(undefined); setPage('artifacts'); }} />}
        <div hidden={page !== 'media'}><ModelWorkbench media profiles={providerProfiles} changed={refreshProviders} deliver={deliverArtifacts}
          openArtifacts={() => { setArtifactFilter(undefined); setPage('artifacts'); }} /></div>
        {page === 'browser' && <BrowserWorkbench incoming={browserIntake} deliver={deliverArtifacts}
          openArtifacts={() => { setArtifactFilter(undefined); setPage('artifacts'); }} />}
        {page === 'mcp' && <McpPanel />}
        <div hidden={page !== 'workflows'}>
          <WorkflowWorkbench active={page === 'workflows'} workflows={workflows} save={items => {
            if (!validWorkflows(items) || !persist('office-workflows', items)) return false;
            setWorkflows(items);
            return true;
          }} profiles={profiles} incoming={workflowIncoming} clearIncoming={() => setWorkflowIncoming(undefined)}
            run={executeWorkflow} running={workflowBusy} stop={() => {
              workflowAbort.current?.abort('codex_cancelled');
              void cancelPolish().catch(() => undefined);
            }} openArtifacts={() => { setArtifactFilter(undefined); setPage('artifacts'); }} />
        </div>
        <div hidden={page !== 'assistant'}>
          <OfficeAssistant files={loaded} hasCodex={hasCodex && !workflowBusy && !polishing && !creativeBusy && !datasetStage} running={assistantRunning} setRunning={setAssistantRunning} setWriting={setAssistantWriting}
            engine={agentEngine} engineName={engineName}
            openAgentSettings={() => setAgentSettingsOpen(true)} knowledgeModels={knowledgeModels}
            openKnowledge={(scope, attach) => setAssistantKnowledge({ scope, attach })}
            renderTaskContext={({ dataset, filenames, retrievalActive, locked, showScope }) => <TaskScopePicker profiles={profiles} dataset={dataset}
              filenames={filenames} showAttachments={!retrievalActive && filenames.length > 0}
              disabled={locked || workspaceLocked} onSelect={id => {
                if (!id) { showScope(); return; }
                const profile = profiles.find(item => item.id === id);
                if (!profile) return;
                if (sample) {
                  message.info(t('taskExitSample'));
                  return;
                }
                chooseWorkbenchDataset(id);
                showScope(assistantScope(profile, loaded));
              }} onManage={() => setPage('data')} />}
            runDatasetCommand={runAssistantDatasetCommand} datasetCommandBusy={pptLocked}
            openTaskId={openTaskId} clearOpenTask={() => setOpenTaskId(undefined)} onTasksChange={setAssistantTasks}
            reference={assistantReference} clearReference={() => setAssistantReference(undefined)} showSourcesLoading={busy || picking}
            engineStatus={engineStatus} checkEngine={recheckEngine}
            pick={folder => { if (!locked) void pick(folder, 'assistant'); }} previewMaterial={id => setPreview({ type: 'material', id })}
            artifacts={artifacts} deliver={deliverArtifacts} preview={id => setPreview({ type: 'artifact', id })}
            saveFile={exportArtifact} exporting={exporting} show={setEvidence}
            openCreative={useCreative} newTaskSignal={newTaskSignal} openLibrary={() => setPage('library')} openArtifacts={() => setPage('artifacts')} />
        </div>
        {page === 'library' && <>
          <div className="page-heading"><div><h1>{t('library')}</h1><p>{t('libraryIntro')}</p></div><div className="heading-actions">
            <Button icon={<ExperimentOutlined />} disabled={locked} onClick={() => void sampleClick()}>{t(sample ? 'sampleClear' : 'loadSample')}</Button>
            <Button icon={<ReloadOutlined />} disabled={!activeSources.length || locked} onClick={() => void refresh(activeSources, true)}>{t('refresh')}</Button>
          </div></div>
          <div className="workspace-grid">{sourcesPanel(false)}<MaterialsView files={loaded} sources={activeSources}
            preview={id => setPreview({ type: 'material', id })} locate={showLocation}
            attach={id => useAssistant({ materialIds: [id] })} useExcerpt={item => useAssistant({ evidence: item })}
            busy={locked || assistantWriting} /></div>
        </>}
        <div hidden={page !== 'analysis'}>
          <TableAnalysis files={loaded} incoming={analysisIntake} finishImport={() => setAnalysisIntake(undefined)}
            busy={busy || picking} locked={pptLocked} pick={folder => { if (!pptLocked) void pick(folder, 'analysis'); }}
            refresh={() => { if (!pptLocked) void refresh(activeSources, true); }} setBusy={setAnalysisBusy} locate={showLocation}
            writeReport={analysis => useAssistant({ analysis })} deliver={deliverArtifacts} save={exportArtifact} savePack={saveWorkFiles}
            compose={useCreative} />
        </div>
        <div hidden={page !== 'creative'}>
          <CreativeStudio active={page === 'creative'} files={loaded} intake={creativeIntake} clearIntake={() => setCreativeIntake(undefined)}
            engine={agentEngine} engineName={engineName}
            hasCodex={hasCodex && !polishing && !assistantRunning} locked={locked || exporting || toolBusy || assistantWriting}
            loading={busy || picking} setBusy={setCreativeBusy} setWriting={setCreativeWriting}
            pick={folder => { if (!locked) void pick(folder, 'creative'); }} imported={creativeImported} clearImported={() => setCreativeImported(undefined)}
            previewMaterial={id => setPreview({ type: 'material', id })} show={setEvidence} deliver={deliverArtifacts} save={exportArtifact} savePack={saveWorkFiles}
            artifacts={artifacts} previewArtifact={id => setPreview({ type: 'artifact', id })}
            openArtifactBatch={group => { setArtifactFilter(group); setPage('artifacts'); }} />
        </div>
        <div hidden={page !== 'tools'}>
          <div className="page-heading"><div><h1>{t('tools')}</h1><p>{t('toolsIntro')}</p></div></div>
          <OfficeTools files={loaded} sources={activeSources} artifacts={artifacts} add={addArtifact} setBusy={setToolBusy}
            compose={useCreative}
            intake={toolIntake} clearIntake={() => setToolIntake(undefined)} pick={target => { if (!locked) void pick(false, target); }}
            inspect={(type, id) => setPreview({ type, id, audit: true })} />
        </div>
        <div hidden={page !== 'slides'}>
          <PptWorkspace active={page === 'slides'} locked={pptLocked} loadingSources={busy || picking} files={loaded} sources={activeSources} artifacts={artifacts}
            focus={pptFocus} clearFocus={() => setPptFocus(undefined)}
            importDeck={() => { if (!pptLocked) void pick(false); }} importFolder={() => { if (!pptLocked) void pick(true); }}
            refresh={() => { if (!pptLocked) void refresh(activeSources, true); }}
            openPage={location => setPreview({ type: location.type, id: location.id, anchor: `# ${location.page}` })}
            deliver={(title, file, detail) => addArtifact(title, 'pptx', file, detail)} setBusy={setPptBusy} />
        </div>
        {page === 'artifacts' && <>
          <div className="page-heading"><div><h1>{t('artifacts')}</h1><p>{t('artifactsIntro')}</p></div>
            <div className="heading-actions">{artifactFilter && <Button onClick={() => setArtifactFilter(undefined)}>{t('datasetAllArtifacts')}</Button>}
              <Button icon={<HistoryOutlined />} onClick={() => { setHistoryFromDataset(false); setHistoryId(null); setPage('history'); }}>{t('history')}</Button></div></div>
          <ArtifactsView key={artifactFilter ?? 'all'} items={artifactFilter ? artifacts.filter(item => item.group === artifactFilter) : artifacts}
            exporting={exporting} preview={id => setPreview({ type: 'artifact', id })}
            open={nativeDesktop ? item => void openArtifact(artifactName(item), item.file).catch(error => message.error(trError(error, 'open_failed'))) : undefined}
            savePack={files => void saveWorkFiles(t('workFilesPack') + ' ' + dayjs().format('YYYY-MM-DD'), files)}
            save={artifact => void exportArtifact(artifact)} remove={id => void removeArtifact(id)} rename={(id, title) => {
              const item = artifacts.find(artifact => artifact.id === id);
              if (item) void updateArtifact({ ...item, title });
            }} />
        </>}
        {page === 'current' && <>
          <div className="page-heading">
            <div><h1>{t('hero')} {sample && <Tag color="gold">{t('sampleBadge')}</Tag>}</h1>{!reportReading && <p>{t('subtitle')}</p>}</div>
            <div className="heading-actions">
              {tab === 'preview' && draft && <Button icon={<SettingOutlined />} aria-expanded={reportSettingsOpen}
                onClick={() => setReportSettingsOpen(value => !value)}>{t(reportSettingsOpen ? 'hideReportSetup' : 'showReportSetup')}</Button>}
              {!reportReading && <>
              <Button icon={<ExperimentOutlined />} disabled={locked} onClick={() => void sampleClick()}>{t(sample ? 'sampleClear' : 'loadSample')}</Button>
              <Button icon={<ReloadOutlined />} disabled={!activeSources.length || locked} onClick={() => void refresh(activeSources, true)}>{t('refresh')}</Button>
              <Button type="primary" icon={<FileTextOutlined />} disabled={locked || !canGenerate} onClick={() => void generate()}>{t(draft ? 'regenerate' : 'generate')}</Button>
              </>}
            </div>
          </div>
          {!reportReading && <>
          <ReportControls profiles={sample ? [] : profiles} value={sample ? undefined : profileId} disabled={locked} canSave={!sample && sources.some(source => scope === null || scope.includes(source.id)) && Boolean(settings.team.trim())}
            previous={previous => changeSettings(quickPeriod(realSettings.cadence, previous, sample ? new Date(2026, 10, 20) : undefined))}
            choose={selectProfile} save={saveProfile} remove={removeProfile} history={() => { setHistoryFromDataset(false); setHistoryId(null); setPage('history'); }} />
          <div className="period-bar">
            <div className="field team-field"><label htmlFor="team">{t('team')}</label><Input id="team" maxLength={80} disabled={polishing} value={realSettings.team}
              placeholder={t('teamExample')} onChange={event => changeSettings({ team: event.target.value })} /></div>
            <div className="field"><label id="cadence-label">{t('cadence')}</label><Segmented<Cadence> aria-labelledby="cadence-label" value={realSettings.cadence} disabled={polishing}
              options={[{ value: 'weekly', label: t('weekly') }, { value: 'monthly', label: t('monthly') }]}
              onChange={cadence => changeSettings(period(cadence, dayjs(realSettings.to || undefined).toDate()))} /></div>
            <div className="field"><label htmlFor="period-from">{t('from')}</label><DatePicker id="period-from" disabled={polishing} value={realSettings.from ? dayjs(realSettings.from) : null}
              placeholder={t('datePlaceholder')} format="YYYY-MM-DD" onChange={date => changeSettings({ from: date?.format('YYYY-MM-DD') ?? '' })} /></div>
            <div className="field"><label htmlFor="period-to">{t('to')}</label><DatePicker id="period-to" disabled={polishing} value={realSettings.to ? dayjs(realSettings.to) : null}
              placeholder={t('datePlaceholder')} format="YYYY-MM-DD" onChange={date => changeSettings({ to: date?.format('YYYY-MM-DD') ?? '' })} /></div>
            <div className="field"><label htmlFor="document-lang">{t('reportLanguage')}</label><Select id="document-lang" disabled={polishing} value={realSettings.locale}
              options={[{ value: 'zh-CN', label: t('zh') }, { value: 'en-US', label: t('en') }]}
              onChange={(locale: Locale) => changeSettings({ locale })} /></div>
          </div>
          </>}
          <div className={reportReading ? 'report-reading-layout' : 'workspace-grid'}>
            {!reportReading && sourcesPanel(true)}
            <section className="panel work-panel" aria-label={t(tab)}>
              <div className="workspace-tabs" role="tablist" aria-label={t('current')}>
                <button id="review-tab" role="tab" aria-selected={tab === 'review'} aria-controls="work-tab-panel" onClick={() => setTab('review')}>{t('review')}</button>
                <button id="preview-tab" role="tab" aria-selected={tab === 'preview'} aria-controls="work-tab-panel" onClick={() => { setReportSettingsOpen(false); setTab('preview'); }}>{t('preview')}</button>
                <span className="tab-date numeric"><CalendarOutlined /> {(reportReading ? draft?.report.settings.from : realSettings.from) || '—'} <span>–</span> {(reportReading ? draft?.report.settings.to : realSettings.to) || '—'}</span>
              </div>
              <div id="work-tab-panel" role="tabpanel" aria-labelledby={`${tab}-tab`} className="work-body">
                {tab === 'review' ? <>
                  {reportInputNotice()}
                  <MetricStrip metrics={!busy && result.usable > 0 ? result.metrics : undefined} />
                  <Review result={result} active={!busy && (activeSources.length > 0 || reportIssues.length > 0)} show={setEvidence}
                    decide={decide} exportDetails={() => void exportDetails()} />
                </> : draft ? <>
                  {stale && <Alert type="warning" showIcon title={t(draft.snapshot ? 'stale' : 'legacyReport')}
                    description={changes && <ul className="report-input-changes">
                      {changes.added.length > 0 && <li>{t('sourcesAdded', { names: changes.added.join('、') })}</li>}
                      {changes.changed.length > 0 && <li>{t('sourcesChanged', { names: changes.changed.join('、') })}</li>}
                      {changes.removed.length > 0 && <li>{t('sourcesRemoved', { names: changes.removed.join('、') })}</li>}
                      {changes.other && <li>{t('otherInputsChanged')}</li>}
                    </ul>} />}
                  <div className="codex-line">
                    {polishing ? <><Spin size="small" /><span role="status">{t('codexWorking', { engine: engineName })}</span>
                      <Button size="small" onClick={() => void cancelPolish().catch(error => message.error(trError(error, 'codex_failed')))}>{t('codexCancel')}</Button></> : <>
                      <Tooltip title={t(hasCodex ? 'codexInfo' : nativeDesktop ? 'codexMissingDesktop' : 'codexBrowser', { engine: engineName })}>
                        <span><Button icon={<ThunderboltOutlined />} disabled={!hasCodex || stale || locked} onClick={() => void runCodex()}>{t('codex', { engine: engineName })}</Button></span>
                      </Tooltip>
                      {hasCodex && <span className="muted">{t('codexInfo', { engine: engineName })}</span>}
                    </>}
                  </div>
                  <ReportView key={draft.report.id} report={draft.report} show={setEvidence} exporting={exporting} busy={polishing || packing || reportSaving}
                    compose={() => reportPresentation(draft)}
                    saveText={narrative => editReport(draft, narrative, false)}
                    artifact={kind => void reportArtifact(draft, kind)}
                    pack={packControls(draft)}
                    archive={() => void archiveReport(draft)} onExport={() => void saveWord(draft.report)} />
                </> : !reportsReady ? <Spin /> : <Blank kind="review" title={t('draftEmpty')} body={t('draftEmptyBody')}
                  action={<Button type="primary" icon={<FileTextOutlined />} disabled={locked || !canGenerate} onClick={() => void generate()}>{t('generate')}</Button>} />}
              </div>
            </section>
          </div>
        </>}
        {page === 'history' && <>
          <div className="page-heading"><div><h1>{t('historyTitle')}</h1><p>{t('historyCaption')}</p></div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => historyFromDataset ? setPage('data') : selectedHistory ? setHistoryId(null) : setPage('artifacts')}>{t(historyFromDataset ? 'data' : selectedHistory ? 'history' : 'artifacts')}</Button>
          </div>
          <section className="panel history-panel">
            {selectedHistory ? <>
              {!selectedHistory.snapshot && <Alert type="info" showIcon title={t('legacyArchive')} />}
              <ReportView key={selectedHistory.id} report={selectedHistory.report} show={setEvidence} busy={packing || reportSaving} exporting={exporting}
                compose={() => reportPresentation(selectedHistory)}
                artifact={kind => void reportArtifact(selectedHistory, kind)} pack={packControls(selectedHistory)}
                saveText={narrative => editReport(selectedHistory, narrative, true)} onExport={() => void saveWord(selectedHistory.report)} />
            </> : !reportsReady ? <Spin /> :
              history.length === 0 ? <Blank kind="review" title={t('historyEmpty')} body="" /> : history.map(item => <div className="history-row" key={item.id}>
                <span className="history-icon"><FileWordOutlined /></span><div><h3>{reportTitle(item.report.settings)}</h3>
                  <p className="numeric">{item.report.settings.from} – {item.report.settings.to} · {t(item.updatedAt ? 'reportUpdated' : 'reportVersion',
                    { time: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.updatedAt ?? item.report.createdAt)) })}</p></div>
                <Button onClick={() => setHistoryId(item.id)}>{t('historyView')}</Button>
                <Popconfirm title={t('historyRemove')} okText={t('remove')} cancelText={t('cancel')} onConfirm={() => removeHistory(item.id)}>
                  <Button type="text" icon={<CloseOutlined />} disabled={reportSaving} aria-label={t('historyRemove')} />
                </Popconfirm>
              </div>)}
          </section>
        </>}
      </main>
    </div>
    {!nativeDesktop && <>
      <input ref={sourceInput} type="file" accept={supportedFiles} multiple hidden onChange={event => { void browserPick(event.target.files, false); event.target.value = ''; }} />
      <input ref={node => { folderInput.current = node; node?.setAttribute('webkitdirectory', ''); }} type="file" multiple hidden
        onChange={event => { void browserPick(event.target.files, true); event.target.value = ''; }} />
    </>}
    {selectedMapping?.parsed?.kind === 'xlsx' && <MappingDialog key={mappingId} file={selectedMapping.material.relative}
      sheets={selectedMapping.parsed.sheets} check={mappingChecks.get(selectedMapping.material.id)}
      previous={activeMappings[selectedMapping.material.id]} close={() => setMappingId(null)}
      rules={(() => {
        const folder = !sample && mappingFolder(selectedMapping.material);
        return folder ? folderMappings[folder] ?? [] : undefined;
      })()}
      removeRule={value => removeFolderMapping(selectedMapping, value)}
      save={(value, reuse) => saveMapping(selectedMapping, value, reuse)} />}
    <EvidenceDrawer key={evidence ? `${evidence.id}:${evidence.locations[0]?.at}` : 'closed'} item={evidence} close={() => setEvidence(null)}
      canPreview={location => Boolean(locationFile(location))} showLocation={showLocation} />
    {currentPreview && <FilePreview key={preview ? `${preview.type}:${preview.id}:${preview.anchor ?? ''}:${preview.audit ?? false}` : ''}
      file={currentPreview} close={() => { setPreview(undefined); setArtifactPreview(undefined); }} error={error => message.error(trError(error, 'open_failed'))} />}
    {dragging && <div className="drop-overlay" aria-hidden><FolderOpenOutlined /> <strong>{t('dropFiles')}</strong></div>}
    <Modal open={help} title={t('helpTitle')} onCancel={() => setHelp(false)} footer={<Button onClick={() => setHelp(false)}>{t('close')}</Button>}>
      <p>{t('helpContent')}</p><p>{t('helpPrivacy')}</p>
    </Modal>
    {backupOpen && <WorkspaceBackup close={() => setBackupOpen(false)} />}
    <AgentSettings open={agentSettingsOpen} engine={agentEngine} status={engineStatus} details={engineDetails}
      profiles={providerProfiles} locked={workspaceLocked} close={() => setAgentSettingsOpen(false)} changeEngine={selectAgentEngine}
      recheck={recheckEngine} manageProviders={() => { setAgentSettingsOpen(false); setPage('models'); }} />
    {assistantKnowledge && <DatasetSearch key={assistantKnowledge.scope.id} datasetId={assistantKnowledge.scope.id}
      name={assistantKnowledge.scope.name} files={loaded.filter(file => assistantKnowledge.scope.materialIds.includes(file.material.id))}
      copy={i18n.language === 'zh-CN' ? dataWorkbenchZh : dataWorkbenchEn} models={knowledgeModels}
      close={() => setAssistantKnowledge(undefined)} preview={(id, anchor) => setPreview({ type: 'material', id, anchor })}
      useExcerpts={items => { assistantKnowledge.attach(items); setAssistantKnowledge(undefined); }}
      openSettings={() => { setAssistantKnowledge(undefined); setPage('models'); }} />}
  </div>;
}
