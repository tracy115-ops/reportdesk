import { ThunderboltOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Drawer, Input, InputNumber, Modal, Select } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AssistantMaterials from './AssistantMaterials';
import { cancelPolish, errorCode, FILE_LIMIT, nativeDesktop, runOffice } from './desktop';
import type { AgentEngine } from './desktop';
import type { Evidence, Loaded, Locale } from './domain';
import { assistantInput, deleteCreativeProject, storedCreativeProjects, storeCreativeProject } from './office';
import type { Artifact, NewArtifact } from './office';
import { creativeExportPages, creativeFindings, creativeLayouts, newCreativeProject, pagesFromDraft, reviseCreativeProject } from './creative-project';
import type { CreativeIntake, CreativePage, CreativeProject } from './creative-project';
import { creativeHtml, creativePdf, creativePptx, providePdfTypeface } from './creative-output';
import type { CreativeOutput } from './creative-output';
import { creativeScene } from './creative-scene';
import SlidePreview from './SlidePreview';
import CreativeWorkbench from './CreativeWorkbench';
import CreativeChartDialog from './CreativeChartDialog';
import { sampleCreativeProject, splitCreativePage, workflowProject } from './creative-workflows';
import type { CreativeWorkflow } from './creative-workflows';
import type { SlideData } from './slide-data';
import { readLocal, writeLocal } from './storage';

interface Props {
  active: boolean;
  files: Loaded[];
  intake?: CreativeIntake;
  clearIntake: () => void;
  hasCodex: boolean;
  engine?: AgentEngine;
  engineName?: string;
  locked: boolean;
  loading: boolean;
  setBusy: (busy: boolean) => void;
  setWriting: (busy: boolean) => void;
  pick: (folder: boolean) => void;
  imported?: string[];
  clearImported: () => void;
  previewMaterial: (id: string) => void;
  show: (evidence: Evidence) => void;
  deliver: (files: NewArtifact[], group: string) => Promise<Artifact[]>;
  save: (artifact: Artifact) => Promise<void>;
  savePack: (title: string, artifacts: Artifact[]) => Promise<void>;
  artifacts: Artifact[];
  previewArtifact: (id: string) => void;
  openArtifactBatch: (group: string) => void;
}

function deliveryPrefix(project: CreativeProject) {
  return `presentation-${project.id}-`;
}

function deliveryGroup(project: CreativeProject) {
  return deliveryPrefix(project) + project.updatedAt;
}

export default function CreativeStudio({ active, files, intake, clearIntake, hasCodex, engine = 'codex',
  engineName = engine === 'claude' ? 'Claude Code' : 'Codex', locked, loading, setBusy, setWriting,
  pick, imported, clearImported, previewMaterial, show, deliver, save, savePack, artifacts, previewArtifact, openArtifactBatch }: Props) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [project, setProject] = useState<CreativeProject>();
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'outline' | 'design'>('outline');
  const [briefOpen, setBriefOpen] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<CreativePage>();
  const [polish, setPolish] = useState('');
  const [job, setJob] = useState<'outline' | 'rewrite' | CreativeOutput | 'bundle'>();
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inputReview, setInputReview] = useState<Evidence[]>();
  const [chartOpen, setChartOpen] = useState(false);
  const [chartTarget, setChartTarget] = useState<string>();
  const [exportResult, setExportResult] = useState<{ group: string; requested: CreativeOutput | 'bundle'; failed: CreativeOutput[] }>();
  const exportLock = useRef(false);
  const lastEdited = useRef<string | undefined>(undefined);
  const fontInput = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const disabled = locked || Boolean(job) || !ready;
  const importedFiles = useMemo(() => files.filter(file => project?.attachments.includes(file.material.id)), [files, project?.attachments]);
  const findings = useMemo(() => project ? creativeFindings(project) : [], [project]);
  const current = project?.pages.find(page => page.id === selected) ?? project?.pages[0];
  const currentIndex = project?.pages.findIndex(page => page.id === current?.id) ?? 0;
  const missing = (project?.attachments.length ?? 0) - importedFiles.length;
  const latestDelivery = useMemo(() => {
    if (!project) return;
    const prefix = deliveryPrefix(project);
    const currentGroup = deliveryGroup(project);
    const group = (exportResult?.group === currentGroup ? currentGroup : undefined)
      ?? artifacts.find(file => file.group === currentGroup)?.group
      ?? artifacts.filter(file => file.group?.startsWith(prefix)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.group;
    if (!group) return;
    const files = artifacts.filter(file => file.group === group).sort((a, b) => a.kind.localeCompare(b.kind));
    const result = exportResult?.group === group ? exportResult : undefined;
    const first = files[0]?.kind;
    const requested = result?.requested ?? (files.length === 1 && (first === 'html' || first === 'pdf' || first === 'pptx') ? first : 'bundle');
    return { group, files, requested, failed: result?.failed, stale: group !== currentGroup };
  }, [artifacts, exportResult, project]);

  useEffect(() => {
    let mounted = true;
    void storedCreativeProjects().then(items => {
      if (!mounted) return;
      setProjects(items);
      const selected = items.find(item => item.id === readLocal<string>('creative-active', '')) ?? items[0];
      setProject(selected);
      setMode(selected?.pages.length ? 'design' : 'outline');
      setBriefOpen(!selected?.pages.length);
      setReady(true);
    }).catch(() => { if (mounted) { setError('storage_error'); setReady(true); } });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!project || !ready) return;
    const revision = ++version.current;
    setSaved(false);
    setWriting(true);
    const timer = window.setTimeout(() => {
      saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
        await storeCreativeProject(project);
        writeLocal('creative-active', project.id);
        setProjects(items => [project, ...items.filter(item => item.id !== project.id)]);
      }).then(() => {
        if (revision === version.current) { setSaved(true); setWriting(false); }
      }).catch(() => {
        if (revision === version.current) { setError('storage_error'); setWriting(false); }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [project, ready, setWriting]);

  useEffect(() => {
    if (!active || !ready || !saved || !intake || job) return;
    const existing = intake.sourceReport && projects.find(candidate => candidate.sourceReport === intake.sourceReport);
    if (existing) {
      choose(existing.id);
      clearIntake();
      return;
    }
    const base = newCreativeProject(intake.draft.title, intake.locale);
    try {
      const pages = pagesFromDraft(intake.draft, intake.chart);
      if (intake.sourceReport && intake.brief) pages[0]!.body = intake.brief;
      setProject({ ...base, pages, pageCount: Math.max(3, Math.min(12, pages.length)), refs: structuredClone(intake.refs),
        brief: intake.brief || intake.draft.title, sourceReport: intake.sourceReport });
      setMode('design');
      setBriefOpen(false);
      setSelected(pages[0]?.id);
    } catch (error) { setError(errorCode(error, 'export_failed')); }
    clearIntake();
  }, [active, ready, saved, intake, job, projects]);

  useEffect(() => {
    if (!imported || !project || loading || job) return;
    const incoming = imported.filter(id => files.some(file => file.material.id === id && file.parsed));
    const combined = [...new Set([...project.attachments, ...incoming])];
    update({ attachments: combined.slice(0, 12) });
    if (combined.length > 12) message.warning(t('assistantFileLimit'));
    clearImported();
  }, [imported, project?.id, loading, job]);

  function update(patch: Partial<CreativeProject>, revision = false) {
    if (!project) return;
    setProject(revision ? reviseCreativeProject(project, patch) : { ...project, ...patch, updatedAt: new Date().toISOString() });
    setError(undefined);
  }

  function create() {
    if (!saved) return;
    setProject(newCreativeProject(t('creativeUntitled'), i18n.language as Locale));
    setSelected(undefined);
    setMode('outline');
    setBriefOpen(true);
    setError(undefined);
  }

  function choose(id: string) {
    const next = projects.find(project => project.id === id);
    if (next) { setProject(next); setSelected(undefined); setMode(next.pages.length ? 'design' : 'outline'); setBriefOpen(!next.pages.length); setError(undefined); }
  }

  function template(kind: CreativeWorkflow) {
    if (!saved || disabled) return;
    const next = workflowProject(kind, project?.locale ?? i18n.language as Locale);
    if (project && !project.pages.length) {
      next.id = project.id; next.createdAt = project.createdAt;
      next.brief = project.brief; next.audience = project.audience; next.attachments = project.attachments; next.refs = project.refs;
      if (project.title.trim() && project.title !== t('creativeUntitled')) { next.title = project.title; next.pages[0]!.title = project.title; }
    }
    setProject(next);
    setSelected(undefined); setMode('outline'); setBriefOpen(true); setError(undefined);
  }

  function changePage(patch: Partial<CreativePage>) {
    if (!current || disabled) return;
    const id = current.id;
    const checkpoint = lastEdited.current !== id;
    lastEdited.current = id;
    setProject(previous => {
      if (!previous) return previous;
      const pages = previous.pages.map(page => page.id === id ? { ...page, ...patch } : page);
      return checkpoint ? reviseCreativeProject(previous, { pages }) : { ...previous, pages, updatedAt: new Date().toISOString() };
    });
    setError(undefined);
  }

  function addPage() {
    if (!project || disabled || project.pages.length >= 300) return;
    const page: CreativePage = { id: crypto.randomUUID(), title: t('studioNoContent'), body: '', notes: '', layout: project.pages.length ? 'content' : 'cover' };
    update({ pages: [...project.pages, page] }, true);
    setSelected(page.id); setMode('design'); setBriefOpen(false); lastEdited.current = undefined;
  }

  function duplicate() {
    if (!project || !current || disabled || project.pages.length >= 300) return;
    const copy = { ...structuredClone(current), id: crypto.randomUUID() };
    update({ pages: [...project.pages.slice(0, currentIndex + 1), copy, ...project.pages.slice(currentIndex + 1)] }, true);
    setSelected(copy.id);
  }

  function split() {
    if (!project || !current || disabled || project.pages.length >= 300) return;
    try {
      const parts = splitCreativePage(current, project.locale);
      update({ pages: [...project.pages.slice(0, currentIndex), ...parts, ...project.pages.slice(currentIndex + 1)] }, true);
    } catch (error) { setError(errorCode(error, 'studio_split_empty')); }
  }

  function insertChart(chart: SlideData) {
    if (!project || disabled) return;
    const existing = project.pages.find(page => page.id === chartTarget);
    if (!existing && project.pages.length >= 300) { setError('creative_page_limit'); return; }
    const page: CreativePage = { ...(existing ?? { id: crypto.randomUUID(), notes: '' }), title: chart.title, body: chart.source, chart, layout: 'chart' };
    update({ pages: existing ? project.pages.map(item => item.id === existing.id ? page : item) : [...project.pages, page] }, true);
    setSelected(page.id); setMode('design'); setBriefOpen(false);
  }

  function input() {
    if (!project || missing || loading) throw Error('source_unavailable');
    const structure = project.pages.filter(page => page.layout !== 'cover' && !page.chart).map(page => page.title).join(' → ');
    const structureHint = structure ? (project.locale === 'zh-CN' ? '参考当前大纲的论述顺序：' : 'Follow the narrative order of this outline: ') + structure : '';
    const metricHint = project.pages.some(page => page.layout === 'metrics') ? (project.locale === 'zh-CN'
      ? '指标卡页每行使用“指标名称 | 已确认的数值 | 口径说明”；缺少数据时写待补充，不能猜测。'
      : 'For metric cards use one “metric label | confirmed value | scope” per line. Mark missing values as to be provided; never guess.') : '';
    const instruction = [project.brief, t('creativeAudiencePrompt', { audience: project.audience || t('creativeGeneralAudience'), count: project.pageCount - 1 }), structureHint, metricHint].filter(Boolean).join('\n');
    const prior = project.pages.length ? {
      value: { title: project.title, sections: project.pages.filter(page => page.layout !== 'cover').map(page => ({ heading: page.title,
        text: page.body + (page.chart ? '\n' + page.chart.labels.map((label, index) => label + ': ' + page.chart!.values[index]).join('\n') : '') })) },
      language: project.locale, refs: project.refs, format: 'pptx' as const,
    } : undefined;
    return assistantInput(instruction, 'pptx', importedFiles, project.refs, prior);
  }

  async function generate() {
    if (!project?.brief.trim() || disabled || !hasCodex) return;
    let request: ReturnType<typeof input>;
    try {
      request = input();
      if (request.unread.length) throw Error('sourceSelectionEmpty');
    } catch (error) { setError(errorCode(error, 'assistant_input_too_large')); return; }
    setJob('outline');
    setBusy(true);
    setError(undefined);
    try {
      const draft = await runOffice(request.payload, project.locale, engine);
      const allowed = new Set(request.refs.map(ref => ref.id));
      const clean = (text: string) => text.replace(/\[([SDTA]\d+)\]/g, (match, id: string) => allowed.has(id) ? match : '');
      const title = project.title.trim() && project.title !== t('creativeUntitled') ? project.title.trim() : clean(draft.title);
      const value = { title, sections: draft.sections.map(part => ({ heading: clean(part.heading), text: clean(part.text) })) };
      const generated = pagesFromDraft(value);
      generated[0]!.body = project.pages.find(page => page.layout === 'cover')?.body || project.audience;
      const previousContent = project.pages.filter(page => page.layout !== 'cover' && !page.chart);
      const content = generated.slice(1);
      if (previousContent.length === content.length) content.forEach((page, index) => { page.layout = previousContent[index]!.layout; });
      const charts = project.pages.filter(page => page.chart).map(page => structuredClone(page));
      if (generated.length + charts.length > 300) throw Error('creative_page_limit');
      update({ title: value.title, pages: [generated[0]!, ...charts, ...content], refs: request.refs }, true);
      setSelected(undefined);
      setMode('outline');
      setBriefOpen(false);
    } catch (error) { setError(errorCode(error, 'codex_failed')); }
    finally { setJob(undefined); setBusy(false); }
  }

  async function rewrite(inline = false) {
    const target = inline ? current : editing;
    if (!project || !target || !polish.trim() || disabled || !hasCodex) return;
    setJob('rewrite');
    setBusy(true);
    try {
      const payload = JSON.stringify({ request: t('creativeRewritePrompt', { request: polish }), outputKind: 'pptx',
        priorDraft: { title: target.title, sections: [{ heading: target.title, text: target.body }] },
        evidence: project.refs.map(ref => ({ ref: ref.id, text: ref.text })) });
      const draft = await runOffice(payload, project.locale, engine);
      const text = draft.sections.map(section => section.text).join('\n');
      const allowed = new Set(project.refs.map(ref => ref.id));
      const clean = (value: string) => value.replace(/\[([SDTA]\d+)\]/g, (match, id: string) => allowed.has(id) ? match : '');
      const revised = { ...target, title: clean(draft.title), body: clean(text) };
      if (inline) update({ pages: project.pages.map(page => page.id === target.id ? revised : page) }, true);
      else setEditing(revised);
      setPolish('');
    } catch (error) { setError(errorCode(error, 'codex_failed')); }
    finally { setJob(undefined); setBusy(false); }
  }

  function move(index: number, delta: number) {
    if (!project) return;
    const pages = project.pages.slice();
    [pages[index], pages[index + delta]] = [pages[index + delta]!, pages[index]!];
    update({ pages }, true);
  }

  function savePage() {
    if (!project || !editing) return;
    const existing = project.pages.some(page => page.id === editing.id);
    const pages = existing ? project.pages.map(page => page.id === editing.id ? editing : page) : [...project.pages, editing];
    update({ pages }, true);
    setSelected(editing.id);
    setEditing(undefined);
  }

  async function exportProject(kind: CreativeOutput | 'bundle') {
    if (!project?.pages.length || !saved || disabled || exportLock.current || !project.title.trim()
      || findings.some(finding => ['creativeEmptyPage', 'creativeMissingChart'].includes(finding.code))) return;
    exportLock.current = true;
    setJob(kind);
    setBusy(true);
    setError(undefined);
    try {
      const kinds: CreativeOutput[] = kind === 'bundle' ? ['pptx', 'html', 'pdf'] : [kind];
      const group = deliveryGroup(project);
      const alreadyStored = artifacts.filter(file => file.group === group && kinds.some(kind => kind === file.kind));
      const pending = kinds.filter(output => !alreadyStored.some(file => file.kind === output));
      const detail = t('creativePageCount', { count: creativeExportPages(project).length });
      const results = await Promise.allSettled(pending.map(async output => {
        const file = output === 'pptx' ? await creativePptx(project) : output === 'html' ? creativeHtml(project) : await creativePdf(project);
        if (file.size > FILE_LIMIT) throw Error('export_limit');
        return { kind: output, title: project.title, file, detail };
      }));
      const files = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const failed = pending.filter((_, index) => results[index]?.status === 'rejected');
      const stored = files.length ? await deliver(files, group) : [];
      setExportResult({ group, requested: kind, failed });
      if (failed.length) {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) setError(errorCode(failure.reason, 'export_failed'));
        return;
      }
      const selection = [...alreadyStored, ...stored];
      if (kind === 'bundle') await savePack(project.title, selection);
      else if (selection[0]) await save(selection[0]);
    } catch (error) { setError(errorCode(error, 'export_failed')); }
    finally { exportLock.current = false; setJob(undefined); setBusy(false); }
  }

  const brief = project && <section className="creative-brief">
    <div className="creative-brief-heading"><strong>{t('creativeSourceStep')}</strong><span className="muted">{t(saved ? 'creativeSaved' : 'creativeSaving')}</span></div>
    <div className="field"><label htmlFor="creative-title">{t('contentTitle')}</label><Input id="creative-title" value={project.title} maxLength={120} disabled={disabled} onChange={event => update({ title: event.target.value })} /></div>
    <div className="field"><label htmlFor="creative-brief">{t('creativeBrief')}</label><Input.TextArea id="creative-brief" rows={5} value={project.brief} maxLength={2500} disabled={disabled} placeholder={t('creativeBriefExample')} onChange={event => update({ brief: event.target.value })} /></div>
    <div className="creative-brief-options">
      <div className="field"><label htmlFor="creative-audience">{t('creativeAudience')}</label><Input id="creative-audience" value={project.audience} disabled={disabled} placeholder={t('creativeAudienceExample')} onChange={event => update({ audience: event.target.value })} /></div>
      <div className="field"><label htmlFor="creative-page-count">{t('creativeTargetPages')}</label><InputNumber id="creative-page-count" min={3} max={12} precision={0} value={project.pageCount} disabled={disabled} onChange={value => { if (value) update({ pageCount: value }); }} /></div>
      <div className="field"><label htmlFor="creative-locale">{t('outputLanguage')}</label><Select id="creative-locale" value={project.locale} disabled={disabled} options={[{ value: 'zh-CN', label: t('zh') }, { value: 'en-US', label: t('en') }]} onChange={locale => update({ locale })} /></div>
    </div>
    <AssistantMaterials files={files} attachments={project.attachments} pinned={project.refs} locked={disabled} loading={loading} change={attachments => update({ attachments })} pick={pick} preview={previewMaterial} show={show}
      removeExcerpt={index => update({ refs: project.refs.filter((_, position) => position !== index) })}
      review={() => { try { setInputReview(input().refs); } catch (error) { setError(errorCode(error, 'assistant_input_too_large')); } }} />
    <div className="creative-brief-actions"><Button disabled={disabled} onClick={addPage}>{t('creativeAddManual')}</Button>
      {job === 'outline' && <Button onClick={() => void cancelPolish().catch(() => setError('codex_failed'))}>{t('stopTask')}</Button>}
      <Button type="primary" icon={<ThunderboltOutlined />} loading={job === 'outline'} disabled={!hasCodex || !project.brief.trim() || Boolean(missing) || loading || disabled && job !== 'outline'}
        title={hasCodex ? t('studioDraftWithEngine', { engine: engineName }) : undefined} onClick={() => void generate()}>{t(project.pages.length ? 'creativeRebuildOutline' : 'creativeGenerateOutline')}</Button></div>
    {!hasCodex && <p className="muted">{t('assistantLocalDraftHint')}</p>}
  </section>;
  return <>
    {error && <Alert className="creative-alert" showIcon type="error" title={t(error, { engine: engineName, defaultValue: t('export_failed') })} closable onClose={() => setError(undefined)}
      action={error === 'creative_pdf_font' && !nativeDesktop ? <Button size="small" onClick={() => fontInput.current?.click()}>{t('creativeChooseFont')}</Button> : undefined} />}
    <CreativeWorkbench active={active} project={project} projects={projects} ready={ready} saved={saved} disabled={disabled} job={job} mode={mode} setMode={setMode} briefOpen={briefOpen} setBriefOpen={setBriefOpen} brief={brief} selected={selected}
      select={id => { setSelected(id); setPolish(''); lastEdited.current = undefined; }} create={create}
      sample={() => { if (!saved || disabled) return; const next = sampleCreativeProject(project?.locale ?? i18n.language as Locale); setProject(next); setSelected(next.pages[2]!.id); setMode('design'); setBriefOpen(false); }}
      template={template} choose={choose} update={update} changePage={changePage} add={addPage}
      chart={replace => { setChartTarget(replace ? current?.id : undefined); setChartOpen(true); }} move={move} split={split} duplicate={duplicate}
      remove={() => { if (project && current && project.pages.length > 1) { update({ pages: project.pages.filter(page => page.id !== current.id) }, true); setSelected(project.pages[Math.max(0, currentIndex - 1)]?.id); } }}
      deleteProject={async () => { if (!project || !saved || disabled) return; try { await saveQueue.current; await deleteCreativeProject(project.id); setProjects(items => items.filter(item => item.id !== project.id)); setProject(undefined); } catch { setError('storage_error'); } }}
      history={() => setHistoryOpen(true)} show={show} exportProject={kind => void exportProject(kind)} hasCodex={hasCodex} polish={polish} setPolish={setPolish}
      rewrite={() => void rewrite(true)} stop={() => void cancelPolish().catch(() => setError('codex_failed'))}
      deliveryResult={latestDelivery} previewDelivery={file => previewArtifact(file.id)} saveDelivery={file => void save(file)}
      openDeliveryFiles={latestDelivery?.files.length ? () => openArtifactBatch(latestDelivery.group) : undefined} />
    <CreativeChartDialog open={active && chartOpen} initial={project?.pages.find(page => page.id === chartTarget)?.chart} files={files} busy={disabled || loading} pick={() => pick(false)} close={() => setChartOpen(false)} save={insertChart} />
    <Modal open={active && Boolean(editing)} width={740} title={t('creativeEditPage')} okText={t('save')} cancelText={t('cancel')}
      confirmLoading={job === 'rewrite'} okButtonProps={{ disabled: disabled || !editing?.title.trim() }} onOk={savePage} onCancel={() => { if (!job) setEditing(undefined); }}>
      {editing && <div className="edit-sections">
        <div className="field"><label htmlFor="creative-page-title">{t('contentTitle')}</label>
          <Input id="creative-page-title" value={editing.title} maxLength={120} disabled={Boolean(job)} onChange={event => setEditing({ ...editing, title: event.target.value })} /></div>
        <div className="field"><label htmlFor="creative-page-layout">{t('creativeLayout')}</label>
          <Select id="creative-page-layout" value={editing.layout} disabled={Boolean(job)}
            options={creativeLayouts.filter(layout => layout !== 'chart' || editing.chart).map(value => ({ value, label: t('creativeLayout_' + value) }))}
            onChange={layout => setEditing({ ...editing, layout })} /></div>
        <div className="field"><label htmlFor="creative-page-body">{t('body')}</label>
          <Input.TextArea id="creative-page-body" rows={5} value={editing.body} maxLength={1600} disabled={Boolean(job)} onChange={event => setEditing({ ...editing, body: event.target.value })} /></div>
        <div className="field"><label htmlFor="creative-page-notes">{t('pptSpeakerNotes')}</label>
          <Input.TextArea id="creative-page-notes" rows={2} value={editing.notes} maxLength={3000} disabled={Boolean(job)} onChange={event => setEditing({ ...editing, notes: event.target.value })} /></div>
        <div className="creative-edit-preview">{project && <SlidePreview page={creativeScene(editing, project.theme, currentIndex, project.pages.length)} label={editing.title} />}</div>
        {hasCodex && <div className="creative-rewrite"><Input value={polish} maxLength={1200} placeholder={t('creativeRewriteExample')} disabled={Boolean(job)} onChange={event => setPolish(event.target.value)} />
          <Button icon={<ThunderboltOutlined />} disabled={disabled || !polish.trim()} loading={job === 'rewrite'} onClick={() => void rewrite()}>{t('creativeRewritePage')}</Button></div>}
      </div>}
    </Modal>
    <Drawer open={active && historyOpen} size={480} title={t('creativeRevisions')} onClose={() => setHistoryOpen(false)}>
      {!project?.revisions.length ? <p className="muted">{t('creativeNoRevisions')}</p> : project.revisions.map(revision => <div className="assistant-history-row" key={revision.id}>
        <div className="min-w-0"><strong>{revision.title}</strong><small>{new Date(revision.savedAt).toLocaleString(i18n.language)}</small></div>
        <Button disabled={disabled} onClick={() => { update({ title: revision.title, pages: revision.pages, theme: revision.theme, refs: revision.refs ?? project.refs, attachments: revision.attachments ?? project.attachments }, true); setHistoryOpen(false); }}>{t('restoreVersion')}</Button>
      </div>)}
    </Drawer>
    <Modal open={active && Boolean(inputReview)} title={t('previewAssistantInput')} footer={<Button onClick={() => setInputReview(undefined)}>{t('close')}</Button>} onCancel={() => setInputReview(undefined)}>
      {inputReview?.map(ref => <div className="review-original" key={ref.id}><strong>{ref.id} · {ref.locations[0]?.file}</strong><p>{ref.text}</p></div>)}
    </Modal>
    <input type="file" accept=".ttf,.otf" hidden ref={fontInput} onChange={event => {
      const font = event.target.files?.[0];
      event.target.value = '';
      if (font) void font.arrayBuffer().then(providePdfTypeface).then(() => setError(undefined)).catch(() => setError('creative_pdf_font'));
    }} />
  </>;
}
