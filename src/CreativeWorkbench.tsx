import { ArrowDownOutlined, ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined, BarChartOutlined, CheckOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, EyeOutlined, FilePptOutlined, HistoryOutlined, MoreOutlined, PlusOutlined, ScissorOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Drawer, Dropdown, Input, InputNumber, Popconfirm, Segmented, Select, Spin, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreativePage, CreativeProject } from './creative-project';
import { creativeFindings, creativeLayouts, creativeThemes } from './creative-project';
import { creativeScene } from './creative-scene';
import type { CreativeWorkflow } from './creative-workflows';
import { creativeWorkflows } from './creative-workflows';
import type { CreativeOutput } from './creative-output';
import type { Evidence } from './domain';
import { artifactName } from './office';
import type { Artifact } from './office';
import SlidePreview from './SlidePreview';
import './creative-editor.css';

type Inspector = 'content' | 'layout' | 'notes' | 'sources';

interface Props {
  active: boolean;
  project?: CreativeProject; projects: CreativeProject[]; ready: boolean; saved: boolean; disabled: boolean;
  job?: string; mode: 'outline' | 'design'; setMode: (value: 'outline' | 'design') => void;
  briefOpen: boolean; setBriefOpen: (open: boolean) => void; brief: ReactNode; selected?: string; select: (id: string) => void;
  create: () => void; sample: () => void; template: (kind: CreativeWorkflow) => void; choose: (id: string) => void;
  update: (patch: Partial<CreativeProject>, revision?: boolean) => void; changePage: (patch: Partial<CreativePage>) => void;
  add: () => void; chart: (replace?: boolean) => void; move: (index: number, delta: number) => void; split: () => void; duplicate: () => void; remove: () => void; deleteProject: () => Promise<void>;
  history: () => void; show: (ref: Evidence) => void; exportProject: (kind: CreativeOutput | 'bundle') => void;
  deliveryResult?: { files: Artifact[]; requested: CreativeOutput | 'bundle'; failed?: CreativeOutput[]; stale?: boolean };
  previewDelivery?: (file: Artifact) => void;
  saveDelivery?: (file: Artifact) => void;
  openDeliveryFiles?: () => void;
  hasCodex: boolean; polish: string; setPolish: (value: string) => void; rewrite: () => void;
  stop: () => void;
}

export default function CreativeWorkbench(props: Props) {
  const { t } = useTranslation();
  const { project, projects, ready, saved, disabled, job, mode, selected, update, changePage, deliveryResult } = props;
  const [inspector, setInspector] = useState<Inspector>('content');
  const [rewriting, setRewriting] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const thumbnails = useRef<HTMLDivElement>(null);
  const pages = project?.pages ?? [];
  const current = pages.find(page => page.id === selected) ?? pages[0];
  const scenes = useMemo(() => project ? pages.map((page, index) => creativeScene(page, project.theme, index, pages.length)) : [], [pages, project?.theme]);
  const index = current ? pages.findIndex(page => page.id === current.id) : 0;
  const findings = project ? creativeFindings(project) : [];
  const exportable = Boolean(pages.length && project?.title.trim() && !findings.some(finding => ['creativeEmptyPage', 'creativeMissingChart'].includes(finding.code)));
  const select = props.select;
  useEffect(() => { thumbnails.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [current?.id]);
  useEffect(() => {
    if (!props.active || mode !== 'design') return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"], .ant-select, [role="dialog"], [role="menu"]')) return;
      const step = ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 0;
      if (step && pages[index + step]) { event.preventDefault(); props.select(pages[index + step]!.id); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [props.active, mode, current?.id, pages]);
  const templateCards = <div className="studio-template-grid">
    {creativeWorkflows.map(kind => <button type="button" className={'studio-template-card template-' + kind} key={kind} disabled={disabled || !saved} onClick={() => props.template(kind)}>
      <span className="studio-template-art" aria-hidden><i /><i /><i /></span>
      <strong>{t('studio' + kind[0]!.toUpperCase() + kind.slice(1))}</strong><small>{t('studio' + kind[0]!.toUpperCase() + kind.slice(1) + 'Help')}</small><ArrowRightOutlined />
    </button>)}
  </div>;
  return <div className={'creative-studio ' + (pages.length ? 'has-pages' : 'is-new')}>
    <header className="studio-header">
      <div className="studio-heading">
        {project && <span className="studio-project-mark" aria-hidden><FilePptOutlined /></span>}
        <div>
          <h1 title={project?.title}>{project?.title || t('creative')}</h1>
          {project && <span className="studio-save-state" role="status"><i className={saved ? 'is-saved' : ''} />{ready ? t(saved ? 'creativeSaved' : 'creativeSaving') : t('loadingMaterials')}</span>}
        </div>
      </div>
      <div className="heading-actions">
        {projects.length > 0 && <Select className="creative-project-select" aria-label={t('creativeProjects')} placeholder={t('creativeProjects')} value={project?.id} disabled={!saved || disabled} onChange={props.choose}
          options={projects.map(item => ({ value: item.id, label: item.title }))} />}
        <Tooltip title={t('creativeNew')}><Button icon={<PlusOutlined />} aria-label={t('creativeNew')} disabled={!ready || !saved || disabled} onClick={props.create} /></Tooltip>
        {pages.length > 0 && <Button type="primary" icon={<DownloadOutlined />} onClick={() => setDelivery(true)}>{t('creativeReviewExport')}</Button>}
      </div>
    </header>
    {!ready ? <div className="studio-loading"><Spin /></div> : !project ? <div className="studio-welcome">
      <div className="studio-welcome-copy"><h2>{t('studioNewTitle')}</h2><p>{t('studioNewHelp')}</p>
        <div className="heading-actions"><Button type="primary" icon={<PlusOutlined />} onClick={props.create}>{t('studioBlank')}</Button><Button onClick={props.sample}>{t('studioSample')}</Button></div></div>
      <h3>{t('studioTemplates')}</h3>{templateCards}
    </div> : !pages.length ? <div className="studio-create-grid"><div>{props.brief}</div><aside className="studio-create-preview">
      <SlidePreview page={creativeScene({ id: 'preview', title: project.title, body: project.audience, layout: 'cover', notes: '' }, project.theme, 0, 1)} label={project.title} />
      <h3>{t('studioTemplates')}</h3>{templateCards}
      <Button type="link" disabled={disabled || !saved} onClick={props.sample}>{t('studioSample')} <ArrowRightOutlined /></Button>
    </aside></div> : <>
      <div className="creative-stage-toolbar">
        <div className="studio-mode-actions">
          <Segmented value={mode} options={[{ value: 'outline', label: t('creativeOutline') }, { value: 'design', label: t('creativeDesign') }]} onChange={props.setMode} />
          <Button type="text" icon={<EditOutlined />} onClick={() => props.setBriefOpen(true)}>{t('studioBrief')}</Button>
        </div>
        <div className="heading-actions">
          {mode === 'design' && <Button type="text" icon={<BarChartOutlined />} disabled={disabled || pages.length >= 300} onClick={() => props.chart()}>{t('studioAddChart')}</Button>}
          <Select aria-label={t('slideTheme')} value={project.theme} disabled={disabled} onChange={theme => update({ theme }, true)}
          options={creativeThemes.map(value => ({ value, label: t('slide' + value[0]!.toUpperCase() + value.slice(1)) }))} />
          <Tooltip title={t('creativeRevisions')}><Button type="text" icon={<HistoryOutlined />} aria-label={t('creativeRevisions')} onClick={props.history} /></Tooltip></div>
      </div>
      {mode === 'outline' ? <section className="creative-outline studio-outline">
        <div className="studio-outline-head"><div><h2>{t('creativeOutline')}</h2><p>{t('creativeOutlineHint')}</p></div><Button type="primary" onClick={() => props.setMode('design')}>{t('creativePreviewPages')} <ArrowRightOutlined /></Button></div>
        {pages.map((page, position) => <div className="creative-outline-row" key={page.id}>
          <span className="creative-page-number">{String(position + 1).padStart(2, '0')}</span>
          <button type="button" onClick={() => { select(page.id); props.setMode('design'); }}><strong>{page.title}</strong><small>{page.body || t('studioNoContent')}</small></button>
          <div className="creative-page-actions"><Tooltip title={t('pptMoveUp')}><Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={disabled || !position} aria-label={t('pptMoveUp')} onClick={() => props.move(position, -1)} /></Tooltip>
            <Tooltip title={t('pptMoveDown')}><Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={disabled || position === pages.length - 1} aria-label={t('pptMoveDown')} onClick={() => props.move(position, 1)} /></Tooltip></div>
        </div>)}
        <Button className="studio-outline-add" icon={<PlusOutlined />} disabled={disabled || pages.length >= 300} onClick={props.add}>{t('studioAddPage')}</Button>
      </section> : current && <div className="creative-design-grid">
        <aside className="creative-page-list" aria-label={t('studioPages')}>
          <div className="studio-panel-title"><span>{t('studioPages')} <b>{pages.length}</b></span></div>
          <div className="studio-page-scroll" ref={thumbnails}>{pages.map((page, position) => <button type="button" key={page.id} aria-pressed={current.id === page.id} aria-label={t('creativePageNamed', { number: position + 1, title: page.title })} onClick={() => select(page.id)}>
            <span className="studio-thumb-number">{position + 1}</span><SlidePreview page={scenes[position]!} label={page.title} /><span className="studio-thumb-title">{page.title || t('studioNoContent')}</span>
          </button>)}</div>
          <div className="studio-list-footer"><Button size="small" type="text" icon={<PlusOutlined />} disabled={disabled || pages.length >= 300} onClick={props.add}>{t('studioAddPage')}</Button></div>
        </aside>
        <section className="creative-canvas">
          <div className="creative-canvas-head"><span className="studio-page-location">{t('creativePagePosition', { number: index + 1, count: pages.length })}</span><div className="heading-actions">
            <Tooltip title={t('studioPrevious')}><Button type="text" size="small" icon={<ArrowLeftOutlined />} aria-label={t('studioPrevious')} disabled={!index} onClick={() => select(pages[index - 1]!.id)} /></Tooltip>
            <Tooltip title={t('studioNext')}><Button type="text" size="small" icon={<ArrowRightOutlined />} aria-label={t('studioNext')} disabled={index === pages.length - 1} onClick={() => select(pages[index + 1]!.id)} /></Tooltip>
            <Tooltip title={t('creativeDuplicate')}><Button type="text" size="small" icon={<CopyOutlined />} aria-label={t('creativeDuplicate')} disabled={disabled || pages.length >= 300} onClick={props.duplicate} /></Tooltip>
            <Dropdown trigger={['click']} menu={{ items: [
              { key: 'up', label: t('pptMoveUp'), icon: <ArrowUpOutlined />, disabled: !index }, { key: 'down', label: t('pptMoveDown'), icon: <ArrowDownOutlined />, disabled: index === pages.length - 1 },
              { key: 'split', label: t('studioSplit'), icon: <ScissorOutlined />, disabled: pages.length >= 300 },
              { key: 'remove', label: t('studioRemovePage'), icon: <DeleteOutlined />, danger: true, disabled: pages.length < 2 },
            ], onClick: ({ key }) => { if (disabled) return; if (key === 'up') props.move(index, -1); if (key === 'down') props.move(index, 1); if (key === 'split') props.split(); if (key === 'remove') props.remove(); } }}>
              <Button type="text" size="small" icon={<MoreOutlined />} aria-label={t('studioPageActions')} disabled={disabled} /></Dropdown>
          </div></div>
          <div className="creative-slide-stage"><SlidePreview page={scenes[index]!} label={current.title} /></div>
          <div className="studio-canvas-caption"><span title={current.title}>{current.title || t('studioNoContent')}</span><Button type="text" size="small" onClick={() => setInspector('layout')}>{t('creativeLayout_' + current.layout)}</Button></div>
        </section>
        <aside className="creative-inspector">
          <Segmented<Inspector> block value={inspector} onChange={setInspector} options={[
            { value: 'content', label: t('studioContent') }, { value: 'layout', label: t('studioLayout') },
            { value: 'notes', label: t('creativeNotesTab') }, { value: 'sources', label: t('studioSources') },
          ]} />
          <div className="studio-inspector-body">
            {inspector === 'content' && <>
              <div className="field"><label htmlFor="creative-inline-title">{t('contentTitle')}</label><Input.TextArea id="creative-inline-title" autoSize={{ minRows: 1, maxRows: 3 }} value={current.title} maxLength={120} disabled={disabled} onChange={event => changePage({ title: event.target.value })} /></div>
              <div className="field"><label htmlFor="creative-inline-body">{t('body')}</label><Input.TextArea id="creative-inline-body" rows={7} value={current.body} maxLength={1600} disabled={disabled} onChange={event => changePage({ body: event.target.value })} /><small>{t('studioBodyHelp')}</small></div>
              {current.chart && <section className="studio-chart-inline"><div className="studio-section-cap"><strong>{t('studioChartTitle')}</strong><Button size="small" type="link" disabled={disabled} onClick={() => props.chart(true)}>{t('studioChartReplace')}</Button></div>
                {current.chart.labels.map((label, row) => <div className="studio-chart-data-row" key={row}>
                  <Input size="small" aria-label={t('studioChartLabel') + ' ' + (row + 1)} value={label} maxLength={100} disabled={disabled} onChange={event => changePage({ chart: { ...current.chart!, labels: current.chart!.labels.map((value, i) => i === row ? event.target.value : value) } })} />
                  <InputNumber size="small" aria-label={t('studioChartValue') + ' ' + (row + 1)} value={current.chart!.values[row]} disabled={disabled} onChange={value => { if (typeof value === 'number' && Number.isFinite(value)) changePage({ chart: { ...current.chart!, values: current.chart!.values.map((number, i) => i === row ? value : number) } }); }} />
                </div>)}
              </section>}
              <Button className="studio-split-button" icon={<ScissorOutlined />} disabled={disabled || pages.length >= 300} onClick={props.split}>{t('studioSplit')}</Button>
            </>}
            {inspector === 'notes' && <div className="field">
              <label htmlFor="creative-inline-notes">{t('pptSpeakerNotes')}</label>
              <Input.TextArea id="creative-inline-notes" value={current.notes} maxLength={3000} rows={7} disabled={disabled}
                placeholder={t('pptSpeakerNotes')} onChange={event => changePage({ notes: event.target.value })} />
            </div>}
            {inspector === 'layout' && <div className="studio-layout-grid">{creativeLayouts.filter(layout => layout !== 'chart' || current.chart).map(layout => <button type="button" key={layout} aria-pressed={layout === current.layout} disabled={disabled}
              onClick={() => changePage({ layout })}><SlidePreview page={creativeScene({ ...current, layout, body: current.body || t('studioNoContent') }, project.theme, index, pages.length)} label={t('creativeLayout_' + layout)} /><span>{t('creativeLayout_' + layout)}{layout === current.layout && <CheckOutlined />}</span></button>)}</div>}
            {inspector === 'sources' && <div className="studio-source-list">{project.refs.length ? project.refs.map(ref => <button type="button" key={ref.id} onClick={() => props.show(ref)}><b>[{ref.id}] {ref.locations[0]?.file}</b><span>{ref.text}</span></button>) : <p>{t('studioEmptySources')}</p>}</div>}
          </div>
          {(props.hasCodex || job === 'rewrite') && <div className="studio-ai-editor">
            <Button type="text" icon={<ThunderboltOutlined />} block aria-expanded={rewriting || job === 'rewrite'} onClick={() => setRewriting(value => !value)}>{t('creativeRewritePage')}</Button>
            {(rewriting || job === 'rewrite') && <>
              <Input.TextArea aria-label={t('revisionRequest')} value={props.polish} maxLength={1200} rows={2} placeholder={t('creativeRewriteExample')} disabled={Boolean(job)} onChange={event => props.setPolish(event.target.value)} />
              {job === 'rewrite' ? <Button block onClick={props.stop}>{t('stopTask')}</Button> : <Button block type="primary" disabled={disabled || !props.polish.trim()} onClick={props.rewrite}>{t('creativeRewritePage')}</Button>}
            </>}
          </div>}
        </aside>
      </div>}
      <Drawer open={props.active && props.briefOpen} title={t('studioBrief')} size={600} onClose={() => { if (!job) props.setBriefOpen(false); }}>{props.brief}</Drawer>
    </>}
    <Drawer open={props.active && delivery} title={t('creativeDelivery')} size="min(495px, 96vw)" onClose={() => setDelivery(false)}>
      {project && <section className="creative-export">
        {deliveryResult && <section className="creative-delivery-result" aria-label={t('creativeDeliveryFiles', { count: deliveryResult.files.length })}>
          {deliveryResult.stale && <Alert showIcon type="info" title={t('creativeDeliveryStale')} />}
          {!!deliveryResult.failed?.length && <Alert showIcon type="warning"
            title={t('creativeDeliveryFailed', { formats: deliveryResult.failed.map(kind => kind.toUpperCase()).join(' / ') })} />}
          {deliveryResult.files.length > 0 && <>
            <header>
              <strong role="status">{t(deliveryResult.stale ? 'creativeDeliveryPreviousFiles' : 'creativeDeliveryFiles', { count: deliveryResult.files.length })}</strong>
              {props.openDeliveryFiles && <Button type="link" size="small" onClick={() => { setDelivery(false); props.openDeliveryFiles?.(); }}>{t('artifacts')}</Button>}
            </header>
            <ul>
              {deliveryResult.files.map(file => <li key={file.id}>
                <span className="creative-file-format">{file.kind.toUpperCase()}</span>
                <span className="creative-file-name" title={artifactName(file)}>{artifactName(file)}</span>
                {props.previewDelivery && <Tooltip title={t('filePreview')}><Button type="text" size="small" icon={<EyeOutlined />}
                  aria-label={t('filePreview') + ' ' + artifactName(file)} onClick={() => props.previewDelivery?.(file)} /></Tooltip>}
                {props.saveDelivery && <Tooltip title={t('saveAs')}><Button type="text" size="small" icon={<DownloadOutlined />}
                  aria-label={t('saveAs') + ' ' + artifactName(file)} onClick={() => props.saveDelivery?.(file)} /></Tooltip>}
              </li>)}
            </ul>
          </>}
        </section>}
        <Checkbox checked={project.includeSources} disabled={disabled} onChange={event => update({ includeSources: event.target.checked })}>{t('creativeIncludeSources')}</Checkbox>
        {findings.length ? <ul className="creative-findings">{findings.map((finding, position) => <li key={position}><Button type="link" size="small" onClick={() => { select(pages[finding.page - 1]!.id); props.setMode('design'); setDelivery(false); }}>{t('pptUntitledPage', { page: finding.page })}</Button>{t(finding.code)}</li>)}</ul> : <Alert type="success" showIcon title={t('creativeChecksPassed')} />}
        <div className="studio-format-options">{(['pptx', 'html', 'pdf'] as const).map(kind => <Button key={kind} icon={<DownloadOutlined />} disabled={disabled || !saved || !exportable} loading={job === kind} onClick={() => props.exportProject(kind)}>{kind.toUpperCase()}</Button>)}</div>
        <Button type="primary" icon={<DownloadOutlined />} disabled={disabled || !saved || !exportable} loading={job === 'bundle'} onClick={() => props.exportProject('bundle')}>{t('creativeExportAll')}</Button>
      </section>}
      {project && <Popconfirm title={t('creativeDelete')} okText={t('artifactRemove')} cancelText={t('cancel')} onConfirm={props.deleteProject}>
      <Button className="creative-delete" type="text" danger disabled={!saved || disabled}>{t('creativeDelete')}</Button></Popconfirm>}
    </Drawer>
  </div>;
}
