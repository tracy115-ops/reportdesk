import { useState } from 'react';
import { Alert, Button, Checkbox, Dropdown, Input, Modal, Segmented, Spin, Switch } from 'antd';
import {
  ArrowRightOutlined, CalendarOutlined, DatabaseOutlined, DeleteOutlined,
  EditOutlined, EllipsisOutlined, FileAddOutlined, FileOutlined, FileTextOutlined, FolderAddOutlined, FolderOpenOutlined,
  HistoryOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, SettingOutlined, TableOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { fromSource, quickPeriod } from './domain';
import type { Cadence, Evidence, Issue, Loaded, ReportProfile, Source } from './domain';
import { dataWorkbenchEn, dataWorkbenchZh } from './data-workbench-i18n';
import DatasetCommand from './DatasetCommand';
import type { RunDatasetCommand } from './DatasetCommand';
import DatasetSearch from './DatasetSearch';
import type { KnowledgeModel } from './knowledge-index';
import './data-workbench.css';

export interface DatasetActivity {
  id: string;
  datasetId: string;
  kind: 'draft' | 'report' | 'agent';
  title: string;
  at: string;
  detail?: string;
}

export interface DatasetRefresh {
  at: string;
  added: string[];
  changed: string[];
  removed: string[];
  first?: boolean;
  partial?: boolean;
}

export interface DataWorkbenchProps {
  profiles: ReportProfile[];
  sources: Source[];
  files: Loaded[];
  sourceIssues?: Issue[];
  busy: boolean;
  engineReady: boolean;
  modeLabel?: string;
  runStage?: 'refresh' | 'aggregate' | 'agent' | 'export';
  activeDatasetId?: string;
  activity?: ReadonlyArray<DatasetActivity>;
  datasetRefreshes?: Readonly<Record<string, DatasetRefresh>>;
  addSources: (folder: boolean) => void;
  openLibrary: () => void;
  openReports: (profileId?: string) => void;
  openAnalysis: (ids?: string[]) => void;
  openAgent: (profileId?: string) => void;
  openArtifacts: () => void;
  openCommandArtifacts?: () => void;
  onPreviewFile?: (id: string, at?: string) => void;
  onUseExcerpts?: (id: string, excerpts: Evidence[]) => void;
  knowledgeModels?: ReadonlyArray<KnowledgeModel>;
  openKnowledgeSettings?: () => void;
  onSelectDataset?: (id: string) => void;
  onOpenActivity?: (item: DatasetActivity) => void;
  onRefreshDataset?: (id: string) => Promise<boolean | void>;
  onRunCommand?: RunDatasetCommand;
  createDataset: (name: string, sourceIds: string[]) => string | false;
  editDataset: (profileId: string, name: string, sourceIds: string[]) => boolean;
  deleteDataset: (profileId: string) => boolean;
  runReport: (profileId: string, cadence: Cadence, instructions: string, withAgent: boolean, previous: boolean) => Promise<boolean | void>;
}

interface DatasetEditor {
  id?: string;
  name: string;
  sourceIds: string[];
}

type Copy = typeof dataWorkbenchZh;

function countLabel(copy: string, count: number, singular?: string) {
  return count === 1 && singular ? singular : copy.replace('{{count}}', String(count));
}

function datasetFiles(files: Loaded[], { sourceIds, excluded }: ReportProfile) {
  const exclusions = new Set(excluded);
  return files.filter(file => !exclusions.has(file.material.id)
    && sourceIds.some(id => fromSource(file, id)));
}

function displayTime(at: string, formatter: Intl.DateTimeFormat) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : formatter.format(date);
}

function DatasetRefreshStatus({ copy, formatter, scan, busy, refresh }: {
  copy: Copy;
  formatter: Intl.DateTimeFormat;
  scan?: DatasetRefresh;
  busy: boolean;
  refresh: () => Promise<boolean | void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const time = scan && displayTime(scan.at, formatter);
  const changes = scan ? [
    { kind: 'added', label: copy.refreshAdded, files: scan.added },
    { kind: 'changed', label: copy.refreshChanged, files: scan.changed },
    { kind: 'removed', label: copy.refreshRemoved, files: scan.removed },
  ].filter(change => change.files.length) : [];

  async function run() {
    if (busy || refreshing) return;
    setRefreshing(true);
    setFailed(false);
    try { setFailed(await refresh() === false); }
    catch { setFailed(true); }
    finally { setRefreshing(false); }
  }

  return <div className="data-refresh">
    <div className="data-refresh-row">
      <div className="data-refresh-time" aria-live="polite">
        {time && scan ? <><span>{copy.refreshLast}</span><time dateTime={scan.at}>{time}</time></>
          : <span>{refreshing ? copy.refreshPending : copy.refreshNever}</span>}
      </div>
      <Button size="small" icon={<ReloadOutlined />} disabled={busy} loading={refreshing} onClick={() => void run()}>{copy.refreshDataset}</Button>
    </div>
    {scan?.partial ? <p className="data-refresh-warning" role="status">{copy.refreshPartial}</p> :
      failed ? <p className="data-refresh-warning" role="alert">{copy.refreshFailed}</p> :
      scan && (scan.first || !changes.length) && <p className="data-refresh-note" role="status">{scan.first ? copy.refreshFirst : copy.refreshUnchanged}</p>}
    {!scan?.partial && !failed && !scan?.first && changes.length > 0 && <details className="data-change-details" key={scan?.at}>
      <summary><span>{copy.refreshChanges}</span><span>{changes.map(change => countLabel(change.label, change.files.length)).join(' · ')}</span></summary>
      <div className="data-change-list">
        {changes.map(change => <section className="data-change-group" key={change.kind} data-change={change.kind}>
          <h4>{countLabel(change.label, change.files.length)}</h4><ul>
            {change.files.map((name, index) => <li key={name + index} title={name}>{name}</li>)}
          </ul>
        </section>)}
      </div>
    </details>}
  </div>;
}

function RecentActivity({ activity, copy, formatter, onOpenActivity, busy }: {
  activity: DatasetActivity[];
  copy: Copy;
  formatter: Intl.DateTimeFormat;
  onOpenActivity: (item: DatasetActivity) => void;
  busy: boolean;
}) {
  const labels = { draft: copy.activityDraft, report: copy.activityReport, agent: copy.activityAgent };
  return <section className="data-panel data-activity" aria-labelledby="workbench-activity-title">
    <header className="data-panel-heading"><h2 id="workbench-activity-title"><HistoryOutlined />{copy.recentActivity}</h2></header>
    {activity.length ? <ul className="data-activity-list">{activity.map(item => {
      const time = displayTime(item.at, formatter);
      return <li key={item.kind + ':' + item.id}>
        <button type="button" className="data-activity-row" data-kind={item.kind} disabled={busy} onClick={() => onOpenActivity(item)}>
          <span className="data-activity-icon" aria-hidden="true">{item.kind === 'agent' ? <RobotOutlined /> : <FileTextOutlined />}</span>
          <span className="data-activity-label"><strong title={item.title}>{item.title}</strong><span title={item.detail}>
            {labels[item.kind]}{item.detail && ' · ' + item.detail}</span></span>
          {time && <time dateTime={item.at}>{time}</time>}
          <ArrowRightOutlined aria-hidden="true" className="data-activity-arrow" />
        </button>
      </li>;
    })}</ul> : <p className="data-activity-empty">{copy.emptyActivity}</p>}
  </section>;
}

function ReportTask({ copy, profile, busy, engineReady, runStage, runReport, openReports, openAgent }: {
  copy: Copy;
  profile?: ReportProfile;
} & Pick<DataWorkbenchProps, 'busy' | 'engineReady' | 'runStage' | 'runReport' | 'openReports' | 'openAgent'>) {
  const [reportCadence, setCadence] = useState<Cadence>();
  const [previous, setPrevious] = useState(false);
  const [agentDraft, setAgentDraft] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const cadence = reportCadence ?? profile?.settings.cadence ?? 'weekly';
  const { from, to } = quickPeriod(cadence, previous);
  const withAgent = agentDraft && engineReady;
  const locked = busy || submitting;

  async function submit() {
    if (!profile || locked) return;
    setFailed(false);
    setSubmitting(true);
    try { await runReport(profile.id, cadence, withAgent ? instructions.trim() : '', withAgent, previous); }
    catch { setFailed(true); }
    finally { setSubmitting(false); }
  }

  return <section className="data-panel data-report" aria-labelledby="workbench-report-title">
    <header className="data-panel-heading">
      <h2 id="workbench-report-title"><CalendarOutlined />{copy.reportTitle}</h2>
      {profile && <Button type="text" size="small" icon={<SettingOutlined />} disabled={locked}
        onClick={() => openReports(profile.id)}>{copy.reportSettings}</Button>}
    </header>
    {profile ? <div className="data-report-body">
      <div className="data-report-context">
        <span>{copy.reportDataset}</span><strong title={profile.name}>{profile.name}</strong>
      </div>
      <div className="data-report-fields">
        <div className="data-field" role="group" aria-label={copy.reportCadence}>
          <span>{copy.reportCadence}</span>
          <Segmented<Cadence> block disabled={locked} value={cadence} onChange={setCadence}
            options={[{ value: 'weekly', label: copy.weekly }, { value: 'monthly', label: copy.monthly }]} />
        </div>
        <div className="data-field" role="group" aria-label={copy.reportPeriod}>
          <span>{copy.reportPeriod}</span>
          <Segmented<'current' | 'previous'> block disabled={locked} value={previous ? 'previous' : 'current'}
            onChange={choice => setPrevious(choice === 'previous')} options={[
              { value: 'current', label: cadence === 'weekly' ? copy.thisWeek : copy.thisMonth },
              { value: 'previous', label: cadence === 'weekly' ? copy.lastWeek : copy.lastMonth },
            ]} />
        </div>
      </div>
      <p className="data-period"><time>{from}</time><span>–</span><time>{to}</time></p>
      <div className="data-agent-option">
        <div><label htmlFor="workbench-agent-draft">{copy.agentDraft}</label>
          <small id="workbench-agent-note">{engineReady ? copy.agentDraftHelp : copy.offlineDraftHelp}</small></div>
        <Switch id="workbench-agent-draft" aria-describedby="workbench-agent-note" checked={withAgent}
          onChange={setAgentDraft} disabled={locked || !engineReady} />
      </div>
      {withAgent && <div className="data-field data-instructions">
        <label htmlFor="workbench-instructions">{copy.instructions}</label>
        <Input.TextArea id="workbench-instructions" value={instructions} disabled={locked} onChange={event => setInstructions(event.target.value)}
          rows={2} maxLength={1200} placeholder={copy.instructionsPlaceholder} />
      </div>}
      {failed && <Alert type="error" showIcon title={copy.unexpectedRunFailure} />}
      <div className="data-report-submit">
        <Button type="primary" icon={<ArrowRightOutlined />} iconPlacement="end" loading={submitting || !!runStage} disabled={busy}
          onClick={() => void submit()}>{copy.runReport}</Button>
        {runStage && <small role="status">{copy[runStage]}</small>}
      </div>
      <Button className="data-agent-launch" type="text" icon={<RobotOutlined />} disabled={locked}
        onClick={() => openAgent(profile.id)}>{copy.useDataset}</Button>
    </div> : <div className="data-report-blank"><p>{copy.reportWhenEmpty}</p></div>}
  </section>;
}

export default function DataWorkbench({ profiles, sources, files, sourceIssues = [], busy, engineReady, modeLabel, runStage, activeDatasetId,
  activity = [], datasetRefreshes, onSelectDataset, onOpenActivity, onRefreshDataset, onRunCommand,
  addSources, openLibrary, openReports, openAnalysis, openAgent, openArtifacts, openCommandArtifacts, onPreviewFile, onUseExcerpts, knowledgeModels,
  openKnowledgeSettings, createDataset, editDataset, deleteDataset,
  runReport }: DataWorkbenchProps) {
  const { i18n } = useTranslation();
  const copy = i18n.language === 'zh-CN' ? dataWorkbenchZh : dataWorkbenchEn;
  const formatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<DatasetEditor>();
  const [removing, setRemoving] = useState<ReportProfile>();
  const [searching, setSearching] = useState(false);
  const registered = sources.filter(source => !source.sample);
  const sourceNames = new Map(registered.map(source => [source.id, source]));
  const issueCodes = ['source_unavailable', 'file_access', 'source_removed', 'source_timeout', 'folder_limit', 'workspace_limit'];
  const sourcesWithIssues = new Set(sourceIssues.filter(issue => issueCodes.includes(issue.code)).map(issue => issue.sourceId));
  const selected = profiles.find(profile => profile.id === (selectedId ?? activeDatasetId)) ?? profiles[0];
  const recent = selected ? activity.filter(item => item.datasetId === selected.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5) : [];
  const sourceCounts = new Map<string, number>();
  for (const { material, sourceAliases } of files) {
    for (const id of new Set([material.sourceId, ...(sourceAliases ?? [])])) sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
  }
  const selectedFiles = selected ? datasetFiles(files, selected).filter(file => file.parsed) : [];
  const datasetTables = selectedFiles.filter(file => file.parsed?.kind === 'xlsx').map(file => file.material.id);
  const missingEditorSources = profiles.find(profile => profile.id === editor?.id)?.sourceIds.filter(id => !sourceNames.has(id)) ?? [];
  const keptMissing = missingEditorSources.some(id => editor?.sourceIds.includes(id));
  const canSave = !!editor?.name.trim() && editor.sourceIds.length > 0;

  function select(id: string) {
    setSelectedId(id);
    onSelectDataset?.(id);
  }

  function saveDataset() {
    if (!editor || !canSave || busy) return;
    const name = editor.name.trim();
    if (editor.id) {
      if (!editDataset(editor.id, name, editor.sourceIds)) return;
      select(editor.id);
    } else {
      const created = createDataset(name, editor.sourceIds);
      if (!created) return;
      select(created);
    }
    setEditor(undefined);
  }

  return <div className="data-workbench">
    <header className="data-overview">
      <div>
        <h1>{copy.title}</h1>
        <p>{copy.introduction}</p>
      </div>
      <div className="data-overview-actions">
        <Button type="primary" icon={<RobotOutlined />} disabled={!!runStage} onClick={() => openAgent()}>{copy.newAgentTask}</Button>
        <span className="data-engine-status" data-connected={engineReady} title={modeLabel}>{engineReady ? (modeLabel || copy.agentReady) : copy.agentOffline}</span>
      </div>
    </header>

    {selected && onRunCommand && <DatasetCommand key={selected.id} dataset={selected} copy={copy} busy={busy} engineReady={engineReady}
      stageText={runStage && copy[runStage]} onRun={onRunCommand} openArtifacts={openCommandArtifacts ?? openArtifacts} />}

    <div className="data-workbench-main">
      <section className="data-panel data-datasets" aria-labelledby="workbench-datasets-title">
        <header className="data-panel-heading">
          <h2 id="workbench-datasets-title"><DatabaseOutlined />{copy.datasets}</h2>
          <Button size="small" disabled={busy || !registered.length} icon={<PlusOutlined />}
            onClick={() => setEditor({ name: '', sourceIds: registered.length === 1 ? registered.map(source => source.id) : [] })}>{copy.newDataset}</Button>
        </header>

        {profiles.length ? <ul className="data-dataset-list">
          {profiles.map(profile => {
            const unavailable = profile.sourceIds.filter(id => !sourceNames.has(id) || sourcesWithIssues.has(id)).length;
            const linkedFiles = datasetFiles(files, profile);
            const unreadable = linkedFiles.filter(file => !!file.error).length;
            const names = profile.sourceIds.flatMap(id => sourceNames.get(id)?.name ?? []);
            return <li key={profile.id} className="data-dataset-row" data-active={selected?.id === profile.id}>
              <button type="button" className="data-dataset-select" aria-pressed={selected?.id === profile.id} disabled={!!runStage}
                onClick={() => select(profile.id)}>
                <span className="data-dataset-icon"><DatabaseOutlined /></span>
                <span className="data-dataset-summary">
                  <strong title={profile.name}>{profile.name}</strong>
                  <span>{countLabel(copy.knownSources, profile.sourceIds.length, copy.knownSource)} <span aria-hidden="true">·</span> {countLabel(copy.knownFiles, linkedFiles.length, copy.knownFile)}</span>
                  {!!names.length && <small title={names.join(' · ')}>{names.join(' · ')}</small>}
                  {(unavailable > 0 || unreadable > 0) && <small className="data-status-warning">
                    {[unavailable && countLabel(copy.unavailableSources, unavailable, copy.unavailableSource),
                      unreadable && countLabel(copy.unreadableFiles, unreadable, copy.unreadableFile)].filter(Boolean).join(' · ')}
                  </small>}
                </span>
              </button>
              <Dropdown trigger={['click']} menu={{ items: [
                { key: 'edit', label: copy.editDataset, icon: <EditOutlined /> },
                { key: 'delete', label: copy.deleteDataset, icon: <DeleteOutlined />, danger: true },
              ], onClick: ({ key }) => key === 'edit'
                ? setEditor({ id: profile.id, name: profile.name, sourceIds: profile.sourceIds })
                : setRemoving(profile) }}>
                <Button type="text" size="small" className="data-dataset-menu" icon={<EllipsisOutlined />} disabled={busy}
                  aria-label={copy.editDataset + ' · ' + profile.name} />
              </Dropdown>
            </li>;
          })}
        </ul> : <div className="data-dataset-empty">
          <div className="data-empty-icon"><DatabaseOutlined /></div>
          <div><h3>{copy.emptyDatasets}</h3><p>{copy.emptyDatasetHint}</p></div>
        </div>}
        {selected && onRefreshDataset && <DatasetRefreshStatus key={selected.id} copy={copy} formatter={formatter}
          scan={datasetRefreshes?.[selected.id]} busy={busy} refresh={() => onRefreshDataset(selected.id)} />}
        {selectedFiles.length > 0 && <div className="data-dataset-tools">
          {onPreviewFile && <details key={selected?.id} className="data-dataset-files">
            <summary>{copy.previewFiles}<small>{selectedFiles.length}</small></summary>
            <ul>{selectedFiles.map(({ material }) => <li key={material.id}>
              <Button type="text" icon={<FileOutlined />} onClick={() => onPreviewFile(material.id)} title={material.path}
                aria-label={material.relative}>{material.relative}</Button>
            </li>)}</ul>
          </details>}
          {datasetTables.length > 0 && <Button type="text" size="small" icon={<TableOutlined />} disabled={busy}
            onClick={() => openAnalysis(datasetTables)}>{copy.analyzeDataset}</Button>}
          <Button type="text" size="small" icon={<SearchOutlined />} disabled={busy}
            onClick={() => setSearching(true)}>{copy.searchDataset}</Button>
        </div>}
        <div className="data-source-area">
          <div className="data-source-heading">
            <h3>{copy.importedSources}{registered.length > 0 && <small>{registered.length}</small>}</h3>
            {!!registered.length && <Button type="text" size="small" icon={<ArrowRightOutlined />} iconPlacement="end"
              onClick={openLibrary}>{copy.viewLibrary}</Button>}
          </div>
          {registered.length ? <ul className="data-source-list">
            {registered.slice(0, 3).map(source => <li key={source.id}>
              {source.directory ? <FolderOpenOutlined /> : <FileOutlined />}
              <span title={source.path}>{source.name}</span>
              {busy ? <Spin size="small" /> : <small className={sourcesWithIssues.has(source.id) ? 'data-status-warning' : undefined}>
                {sourcesWithIssues.has(source.id) ? copy.unavailableSource : countLabel(copy.knownFiles, sourceCounts.get(source.id) ?? 0, copy.knownFile)}
              </small>}
            </li>)}
          </ul> : <p>{copy.noSources}</p>}
          <div className="data-source-actions">
            <Button icon={<FolderAddOutlined />} disabled={busy} onClick={() => addSources(true)}>{copy.addFolder}</Button>
            <Button icon={<FileAddOutlined />} disabled={busy} onClick={() => addSources(false)}>{copy.addFiles}</Button>
          </div>
        </div>
      </section>

      <div className="data-task-column">
        <ReportTask key={selected?.id} copy={copy} profile={selected} busy={busy} engineReady={engineReady}
          runStage={runStage} runReport={runReport} openReports={openReports} openAgent={openAgent} />
        {selected && onOpenActivity && <RecentActivity activity={recent} copy={copy} formatter={formatter}
          onOpenActivity={onOpenActivity} busy={busy} />}
      </div>
    </div>

    <footer className="data-workbench-links">
      <Button type="text" icon={<TableOutlined />} onClick={() => openAnalysis()}>{copy.analyze}</Button>
      <Button type="text" icon={<FolderOpenOutlined />} onClick={openArtifacts}>{copy.artifacts}</Button>
    </footer>

    {searching && selected && <DatasetSearch key={selected.id} datasetId={selected.id} name={selected.name} files={selectedFiles} copy={copy}
      models={knowledgeModels} openSettings={openKnowledgeSettings && (() => { setSearching(false); openKnowledgeSettings(); })}
      close={() => setSearching(false)} preview={onPreviewFile} useExcerpts={onUseExcerpts && (items => {
        setSearching(false);
        onUseExcerpts(selected.id, items);
      })} />}

    <Modal className="data-dataset-modal" open={!!editor} title={editor?.id ? copy.editDataset : copy.newDataset}
      okText={copy.saveDataset} cancelText={copy.cancel} okButtonProps={{ disabled: !canSave || busy }}
      onOk={saveDataset} onCancel={() => setEditor(undefined)} destroyOnHidden>
      {editor && <div className="data-dataset-editor">
        <div className="data-field">
          <label htmlFor="workbench-dataset-name">{copy.datasetName}</label>
          <Input id="workbench-dataset-name" autoFocus maxLength={100} placeholder={copy.datasetNamePlaceholder}
            value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} onPressEnter={saveDataset} />
        </div>
        <div className="data-dataset-source-picker" role="group" aria-label={copy.importedSources}>
          <p>{copy.datasetSourceHint}</p>
          {registered.map(source => <Checkbox key={source.id} checked={editor.sourceIds.includes(source.id)}
            onChange={event => setEditor({ ...editor, sourceIds: event.target.checked ? [...editor.sourceIds, source.id]
              : editor.sourceIds.filter(id => id !== source.id) })}>
            <span className="data-picker-source"><strong>{source.name}</strong><small title={source.path}>{source.path}</small></span>
          </Checkbox>)}
          {missingEditorSources.length > 0 && <Checkbox checked={keptMissing}
            onChange={event => setEditor({ ...editor, sourceIds: event.target.checked ? [...editor.sourceIds, ...missingEditorSources]
              : editor.sourceIds.filter(id => !missingEditorSources.includes(id)) })}>
            {countLabel(copy.keepUnavailable, missingEditorSources.length)}
          </Checkbox>}
        </div>
      </div>}
    </Modal>

    <Modal open={!!removing} title={copy.removeDatasetTitle.replace('{{name}}', removing?.name ?? '')}
      okText={copy.deleteDataset} cancelText={copy.cancel} okButtonProps={{ danger: true, disabled: busy }}
      onCancel={() => setRemoving(undefined)} onOk={() => {
        if (removing && deleteDataset(removing.id)) setRemoving(undefined);
      }}>
      <p>{copy.removeDatasetDetail}</p>
    </Modal>
  </div>;
}
