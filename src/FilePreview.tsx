import { DownloadOutlined, ExportOutlined, GlobalOutlined, LeftOutlined, MoreOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button, Drawer, Dropdown, InputNumber, Pagination, Segmented, Select, Spin, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { columnName } from './domain';
import type { ArtifactKind, MaterialKind, Parsed, Sheet } from './domain';
import SlideLayout from './SlideLayout';
import SlideAudit from './SlideAudit';
import { pptxRules } from './pptx-audit';
import type { SlideFinding } from './pptx-audit';

export interface PreviewFile {
  title: string;
  kind: MaterialKind | ArtifactKind;
  media?: Blob;
  html?: string;
  parsed?: Parsed;
  error?: string;
  anchor?: string;
  location?: string;
  bytes?: () => Promise<ArrayBuffer>;
  open?: () => Promise<void>;
  browse?: () => Promise<void>;
  save?: () => Promise<void>;
  saving?: boolean;
  saveLabel?: string;
  attach?: () => void;
  actions?: MenuProps;
  audit?: boolean;
  copy?: boolean;
  reusePage?: (page: number) => void;
}

function parseAnchor(anchor?: string) {
  const split = anchor?.lastIndexOf('!') ?? -1;
  const row = split >= 0 ? /[A-Z]+(\d+)/.exec(anchor!.slice(split + 1)) : undefined;
  return { sheet: split >= 0 ? anchor!.slice(0, split) : undefined, row: row ? Number(row[1]) : undefined,
    number: Number(/^[#§]\s*(\d+)/.exec(anchor ?? '')?.[1] ?? 1) };
}

function DocumentText({ parsed, focus }: { parsed: Extract<Parsed, { kind: 'docx' }>; focus: number }) {
  const { t } = useTranslation();
  const focused = parsed.paragraphs.findIndex(part => part.paragraph === focus);
  const [page, setPage] = useState(Math.floor(Math.max(0, focused) / 24) + 1);
  return <>
    <article className="file-paper">
      {parsed.paragraphs.slice((page - 1) * 24, page * 24).map(part => <div key={part.paragraph} className={`preview-paragraph ${part.paragraph === focus && focused !== 0 ? 'focused-item' : ''}`}>
        <span className="preview-line-number">{part.paragraph}</span>
        {part.heading ? <h3>{part.text}</h3> : <p>{part.text}</p>}
      </div>)}
    </article>
    {parsed.paragraphs.length > 24 && <Pagination size="small" className="preview-pagination" current={page} pageSize={24} total={parsed.paragraphs.length}
      onChange={setPage} showSizeChanger={false} aria-label={t('pageNumber')} />}
  </>;
}

function TablePreview({ sheets, anchor }: { sheets: Sheet[]; anchor: ReturnType<typeof parseAnchor> }) {
  const { t } = useTranslation();
  const first = sheets.find(sheet => sheet.name === anchor.sheet) ?? sheets[0];
  const [name, setName] = useState(first?.name);
  const [page, setPage] = useState(Math.floor(Math.max(0, first?.rows.findIndex(row => row.number === anchor.row) ?? 0) / 30) + 1);
  const sheet = sheets.find(entry => entry.name === name);
  const numbers = useMemo(() => {
    const all = new Set<number>();
    for (const row of sheet?.rows ?? []) for (const index in row.cells) all.add(Number(index));
    return [...all].sort((a, b) => a - b);
  }, [sheet]);
  const [columnGroup, setColumnGroup] = useState(0);
  const activeColumns = numbers.slice(columnGroup * 32, (columnGroup + 1) * 32);
  return <>
    <div className="preview-toolbar">
      <Select aria-label={t('sheet')} value={name} options={sheets.map(item => ({ value: item.name, label: item.name }))}
        onChange={value => { setName(value); setPage(1); setColumnGroup(0); }} />
      <span className="muted">{t('dataRows', { count: sheet?.rows.length ?? 0 })}</span>
      {numbers.length > 32 && <Select aria-label={t('visibleColumns')} value={columnGroup} onChange={setColumnGroup}
        options={Array.from({ length: Math.ceil(numbers.length / 32) }, (_, group) => ({ value: group,
          label: `${columnName(numbers[group * 32]!)} – ${columnName(numbers[Math.min((group + 1) * 32 - 1, numbers.length - 1)]!)}` }))} />}
    </div>
    <div className="preview-table-wrap"><table className="preview-table"><thead><tr><th>#</th>{activeColumns.map(col => <th key={col}>{columnName(col)}</th>)}</tr></thead>
      <tbody>{sheet?.rows.slice((page - 1) * 30, page * 30).map(row => <tr key={row.number} className={row.number === anchor.row ? 'focused-item' : ''}>
        <th scope="row">{row.number}</th>{activeColumns.map(col => <td key={col} title={String(row.cells[col] ?? '')}>{row.cells[col]}</td>)}
      </tr>)}</tbody></table></div>
    {(sheet?.rows.length ?? 0) > 30 && <Pagination size="small" className="preview-pagination" current={page} pageSize={30} total={sheet?.rows.length} onChange={setPage} showSizeChanger={false} />}
  </>;
}

function PageNavigation({ page, last, change }: { page: number; last: number; change: (page: number) => void }) {
  const { t } = useTranslation();
  return <div className="preview-toolbar">
    <Button aria-label={t('previousPage')} icon={<LeftOutlined />} disabled={page <= 1} onClick={() => change(page - 1)} />
    <InputNumber aria-label={t('pageNumber')} value={page} min={1} max={last} precision={0} onChange={index => { if (index && index >= 1 && index <= last) change(index); }} />
    <span className="numeric muted">/ {last}</span>
    <Button aria-label={t('nextPage')} icon={<RightOutlined />} disabled={page >= last} onClick={() => change(page + 1)} />
  </div>;
}

function PdfPage({ read, page }: { read: () => Promise<ArrayBuffer>; page: number }) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [status, setStatus] = useState<'busy' | 'ready' | 'failed'>('busy');
  useEffect(() => {
    let active = true;
    let loading: ReturnType<typeof import('./pdf-reader').startPdf> | undefined;
    void (async () => {
      const { startPdf } = await import('./pdf-reader');
      const bytes = await read();
      if (!active) return;
      loading = startPdf(bytes);
      const next = await loading.promise;
      if (active) setDoc(next);
    })().catch(() => { if (active) setStatus('failed'); });
    return () => { active = false; void loading?.destroy().catch(() => {}); };
  }, [read]);
  useEffect(() => {
    if (!doc) return;
    let active = true;
    let task: RenderTask | undefined;
    setStatus('busy');
    void doc.getPage(page).then(current => {
      const target = canvas.current;
      const context = target?.getContext('2d');
      if (!active || !target || !context) return;
      const base = current.getViewport({ scale: 1 });
      const viewport = current.getViewport({ scale: Math.min(1150 / base.width, 1650 / base.height) });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      task = current.render({ canvasContext: context, viewport });
      return task.promise.then(() => { if (active) setStatus('ready'); });
    }).catch(() => { if (active) setStatus('failed'); });
    return () => { active = false; task?.cancel(); };
  }, [doc, page]);
  return <div className="pdf-page-view" aria-busy={status === 'busy'}>
    {status === 'busy' && <Spin />}
    {status === 'failed' && <Alert type="warning" message={t('pdfPreviewFailed')} showIcon />}
    <canvas ref={canvas} aria-label={t('pageNumber')} hidden={status !== 'ready'} />
  </div>;
}

function SlidesOrPdf({ parsed, file, focus }: { parsed: Extract<Parsed, { pageCount: number }>; file: PreviewFile; focus: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(Math.min(Math.max(focus, 1), Math.max(parsed.pageCount, 1)));
  const [mode, setMode] = useState<'content' | 'audit'>(file.audit ? 'audit' : 'content');
  const [finding, setFinding] = useState<SlideFinding>();
  const active = parsed.pages.find(item => item.index === page);
  return <>
    {parsed.kind === 'pptx' && <Segmented className="slide-mode" aria-label={t('filePreview')} value={mode} onChange={setMode}
      options={[{ value: 'content', label: t('slideContent') }, { value: 'audit', label: t('pptCheck') }]} />}
    {parsed.kind === 'pptx' && (mode === 'audit' || finding) && <div hidden={mode !== 'audit'}>
      <SlideAudit title={file.title} count={parsed.pageCount} findings={parsed.findings}
        viewPage={item => { setFinding(item); setPage(item.page); setMode('content'); }} />
    </div>}
    {mode === 'content' && <>
    {parsed.pageCount > 0 && <PageNavigation page={page} last={parsed.pageCount} change={setPage} />}
    {finding?.page === page && <Alert className="slide-finding-note" type="info" showIcon title={[t(finding.code), finding.object].filter(Boolean).join(' · ')}
      description={t(pptxRules[finding.code].fix)} action={<Button size="small" onClick={() => setMode('audit')}>{t('backToSlideCheck')}</Button>} />}
    {parsed.kind === 'pdf' && file.bytes && parsed.pageCount > 0 && <PdfPage read={file.bytes} page={page} />}
    {parsed.kind === 'pptx' && active ? <>
      {file.reusePage && <div className="preview-toolbar"><Button size="small" icon={<PlusOutlined />} onClick={() => file.reusePage!(page)}>{t('pptUsePage')}</Button></div>}
      <SlideLayout key={page} page={active} read={file.bytes} />
    </> : <article className="file-paper preview-page-text"><h3>{t(parsed.kind === 'pdf' ? 'pdfPageText' : 'slideTextPreview')}</h3>
        <p>{active?.text || t('noPageText')}</p></article>}
    </>}
  </>;
}

export default function FilePreview({ file, close, error }: { file: PreviewFile; close: () => void; error: (error: unknown) => void }) {
  const { t, i18n } = useTranslation();
  const anchor = parseAnchor(file.anchor);
  const [opening, setOpening] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  useEffect(() => {
    if (!file.media) return;
    const url = URL.createObjectURL(file.media);
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file.media]);
  return <Drawer open onClose={() => { if (!file.saving) close(); }} size="min(900px, 96vw)" title={<span className="preview-title">{file.title}</span>}
    extra={<div className="preview-header-actions">
      {file.browse && <Button icon={<GlobalOutlined />} loading={browsing} onClick={() => {
        setBrowsing(true);
        void file.browse!().catch(error).finally(() => setBrowsing(false));
      }}>{t('preview_in_browser')}</Button>}
      {file.open && <Button icon={<ExportOutlined />} loading={opening} onClick={() => {
        setOpening(true);
        void file.open!().catch(error).finally(() => setOpening(false));
      }}>{t(file.copy ? 'openCopy' : 'openOriginal')}</Button>}
      {file.save && <Button type="primary" icon={<DownloadOutlined />} loading={file.saving} onClick={() => void file.save!().catch(error)}>
        {file.saveLabel ?? t('saveAs')}</Button>}
    </div>}>
    <div className="preview-topline"><Tag>{file.kind.toUpperCase()}</Tag>{file.anchor && <Tag color="green">{file.anchor}</Tag>}
      {file.attach && <Button size="small" icon={<PlusOutlined />} onClick={file.attach}>{t('attachFileToAssistant')}</Button>}
      {file.actions && <Dropdown menu={file.actions} trigger={['click']}><Button size="small" icon={<MoreOutlined />}>{t('materialActions')}</Button></Dropdown>}
      {file.location && <button className="preview-path" title={t('copyPath')} onClick={() => void navigator.clipboard.writeText(file.location!).catch(error)}>{file.location}</button>}</div>
    <div lang={i18n.language} className="preview-content">
      {file.media ? <div className="media-file-preview">{mediaUrl && (file.kind === 'png' ? <img src={mediaUrl} alt={file.title} /> :
        file.kind === 'mp3' ? <audio controls src={mediaUrl} aria-label={file.title} /> : <video controls src={mediaUrl} aria-label={file.title} />)}</div>
        : file.error ? <Alert type="warning" message={t(file.error, { defaultValue: t('file_parse') })} showIcon /> : file.html !== undefined
        ? <iframe className="html-file-preview" srcDoc={file.html.replace('</head>', '<style>header{display:none!important}main{padding-top:12px}</style></head>')}
          sandbox="" title={file.title} /> : !file.parsed ? <Spin />
        : file.parsed.kind === 'docx' ? <DocumentText parsed={file.parsed} focus={anchor.number} />
        : file.parsed.kind === 'xlsx' ? <TablePreview sheets={file.parsed.sheets} anchor={anchor} />
        : <SlidesOrPdf parsed={file.parsed} file={file} focus={anchor.number} />}
    </div>
  </Drawer>;
}
