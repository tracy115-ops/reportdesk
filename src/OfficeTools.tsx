import { ArrowDownOutlined, ArrowUpOutlined, AudioOutlined, CloseOutlined, CodeOutlined, EyeOutlined, FileExcelOutlined, FilePdfOutlined, FilePptOutlined, FileSearchOutlined, FileWordOutlined, PictureOutlined, PlusOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Checkbox, Input, InputNumber, Select } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, parseArtifact, readMaterial } from './desktop';
import FilePreview from './FilePreview';
import SlideDataFields from './SlideDataFields';
import { chartData, chartSelection as prepareChartSelection } from './slide-data';
import { columnName, guessMapping } from './domain';
import type { ArtifactKind, Loaded, Locale, Parsed, Source } from './domain';
import { excerpts } from './office';
import type { Artifact, NewArtifact } from './office';
import { cleanRows, makePdf, makeSlides, makeWord, makeWorkbook, pageNumbers } from './office-output';
import type { SlideTheme } from './office-output';
import { readToolDraft } from './tool-draft';
import type { ToolDraft, ToolIntake } from './tool-draft';
import { writeLocal } from './storage';
import type { CreativeIntake } from './creative-project';

interface Props {
  files: Loaded[];
  sources: Source[];
  artifacts: Artifact[];
  pick: (target: ToolIntake['kind']) => void;
  intake?: ToolIntake;
  clearIntake: () => void;
  inspect: (type: 'material' | 'artifact', id: string) => void;
  add: (title: string, kind: ArtifactKind, file: Blob, detail: string) => Promise<void>;
  setBusy: (busy: boolean) => void;
  compose: (intake: CreativeIntake) => void;
}

export const fileIcons = { docx: FileWordOutlined, xlsx: FileExcelOutlined, pptx: FilePptOutlined, pdf: FilePdfOutlined,
  csv: FileExcelOutlined, txt: FileWordOutlined, md: FileWordOutlined, html: CodeOutlined, png: PictureOutlined, mp3: AudioOutlined, mp4: VideoCameraOutlined };
const kinds = ['docx', 'xlsx', 'pptx', 'audit', 'pdf'] as const;
const tools = { docx: 'wordTool', xlsx: 'cleanTool', pptx: 'slidesTool', audit: 'pptCheck', pdf: 'pdfTool' } as const;
const hints = { docx: 'wordHint', xlsx: 'cleanHint', pptx: 'slidesHint', audit: 'pptCheckHint', pdf: 'pdfHint' } as const;

export default function OfficeTools({ files, sources, artifacts, pick, add, inspect, setBusy, intake, clearIntake, compose }: Props) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [form, setForm] = useState(() => readToolDraft(i18n.language as Locale));
  const { kind, titles, body, outline, locale, tableId, sheetName, header, dedupe, pdfIds, pages, theme, chartEnabled, chartSelection, auditId } = form;
  const title = titles[kind] ?? '';
  const [filePreview, setFilePreview] = useState<NewArtifact & { parsed: Parsed }>();
  const [job, setJob] = useState<'save' | 'preview'>();
  const busy = job !== undefined;

  const workbooks = files.filter(file => file.parsed?.kind === 'xlsx');
  const table = workbooks.find(file => file.material.id === tableId)?.parsed;
  const sheets = table?.kind === 'xlsx' ? table.sheets : [];
  const sheet = sheets.find(item => item.name === sheetName);
  const validHeader = Boolean(sheet?.rows.some(row => row.number === header));
  const cleaned = useMemo(() => kind === 'xlsx' && sheet && validHeader ? cleanRows(sheet, header, dedupe) : undefined, [kind, sheet, validHeader, header, dedupe]);
  const preview = sheet?.rows.filter(row => row.number >= header).slice(0, 6) ?? [];
  const previewCols = [...new Set(preview.flatMap(row => Object.keys(row.cells).map(Number)))].sort((a, b) => a - b).slice(0, 12);
  const pdfs = files.filter(file => file.parsed?.kind === 'pdf');
  const pdfSelection = pdfIds.flatMap(id => pdfs.find(file => file.material.id === id) ?? []);
  const onlyPdf = pdfSelection.length === 1 && pdfSelection[0]?.parsed?.kind === 'pdf' ? pdfSelection[0].parsed : undefined;
  let selectedPages: number[] | undefined;
  let pdfError = false;
  if (onlyPdf && pages.trim()) {
    try { selectedPages = pageNumbers(pages, onlyPdf.pageCount); }
    catch { pdfError = true; }
  }
  const pdfPageCount = selectedPages?.length ?? pdfSelection.reduce((total, file) => total + (file.parsed?.kind === 'pdf' ? file.parsed.pageCount : 0), 0);
  const presentations = [
    ...files.filter(file => file.parsed?.kind === 'pptx').map(file => ({ type: 'material' as const, id: file.material.id, label: file.material.relative })),
    ...artifacts.filter(file => file.kind === 'pptx').map(file => ({ type: 'artifact' as const, id: file.id, label: file.title })),
  ];
  const selectedAudit = presentations.find(file => file.id === auditId);
  const slideParts = outline.trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map(section => {
    const [heading, ...lines] = section.split(/\r?\n/);
    return { heading: heading?.trim() ?? '', text: lines.map(line => line.trim()).filter(Boolean).join('\n') };
  });
  const validOutline = slideParts.length > 0 && slideParts.length <= 12 && slideParts.every(part => part.heading && part.text && part.text.split('\n').length <= 7);
  const chart = chartEnabled ? chartData(workbooks.find(file => file.material.id === chartSelection?.fileId), chartSelection).data : undefined;
  const validPresentation = title.trim() && (chartEnabled ? chart && (validOutline || !outline.trim()) : validOutline);
  const enabled = kind === 'docx' ? title.trim() && body.trim() : kind === 'pptx' ? validPresentation
    : kind === 'xlsx' ? cleaned : !pdfError && pdfPageCount > 0 && pdfSelection.length === pdfIds.length;

  useEffect(() => {
    if (!intake || busy) return;
    const ids = new Set(intake.ids);
    if (intake.kind === 'docx') {
      const incoming = files.filter(item => ids.has(item.material.id) && item.parsed && item.parsed.kind !== 'xlsx');
      if (incoming.length) insertText(incoming);
      else message.warning(t('noCompatible'));
    } else if (intake.kind === 'pdf') {
      const incoming = intake.ids.filter(id => pdfs.some(file => file.material.id === id));
      if (incoming.length) {
        const selected = [...new Set(intake.append && kind === 'pdf' ? [...pdfIds, ...incoming] : incoming)].slice(0, 12);
        update({ kind: 'pdf', pdfIds: selected, pages: selected.length === 1 && selected[0] === pdfIds[0] ? pages : '' });
      } else message.warning(t('noCompatible'));
    } else if (intake.kind === 'audit') {
      const file = presentations.find(file => file.type === 'material' && ids.has(file.id));
      if (file) { update({ kind: 'audit', auditId: file.id }); inspect('material', file.id); }
      else message.warning(t('noCompatible'));
    } else {
      const file = workbooks.find(file => ids.has(file.material.id));
      if (file?.parsed?.kind === 'xlsx') {
        const first = file.parsed.sheets.find(sheet => sheet.rows.length);
        if (intake.kind === 'chart' && first) update({ kind: 'pptx', chartEnabled: true, chartSelection: prepareChartSelection(file.material.id, first) });
        else selectWorkbook(file.material.id);
      } else message.warning(t('noCompatible'));
    }
    clearIntake();
  }, [intake, busy]);

  function update(patch: Partial<ToolDraft>) {
    const next = { ...form, ...patch };
    setForm(next);
    try { writeLocal('tool-draft', next); }
    catch { message.error(t('storage_error')); }
  }

  function selectWorkbook(id: string) {
    const entry = workbooks.find(file => file.material.id === id)?.parsed;
    if (entry?.kind !== 'xlsx') return;
    const suggestion = guessMapping(entry.sheets);
    const first = entry.sheets.find(item => item.rows.length);
    update({ kind: 'xlsx', tableId: id, sheetName: suggestion?.sheet ?? first?.name ?? '', header: suggestion?.headerRow ?? first?.rows[0]?.number ?? 1 });
  }

  function insertText(incoming: Loaded[]) {
    const snippets: string[] = [];
    let length = body.length;
    for (const file of incoming) {
      for (const piece of excerpts(file)) {
        if (snippets.length >= 70 || length >= 24_000) break;
        snippets.push(piece.text);
        length += piece.text.length + 1;
      }
    }
    const file = incoming[0];
    if (!file || !snippets.length) { message.warning(t('noCompatible')); return; }
    update({
      kind: 'docx',
      body: [body, ...snippets].filter(Boolean).join('\n').slice(0, 24_000),
      titles: titles.docx?.trim() ? titles : { ...titles, docx: file.material.relative.replace(/\.[^.]+$/, '').slice(0, 100) },
    });
  }

  function movePdf(index: number, delta: number) {
    const next = pdfIds.slice();
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    update({ pdfIds: next });
  }

  async function build(action: 'save' | 'preview') {
    if (!enabled || busy) return;
    setJob(action);
    setBusy(true);
    try {
      let output: NewArtifact & { kind: 'docx' | 'xlsx' | 'pptx' | 'pdf' };
      if (kind === 'docx') {
        const name = title.trim();
        output = { title: name, kind, file: await makeWord({ title: name, sections: [{ heading: '', text: body.trim() }] }, locale), detail: body.trim().slice(0, 160) };
      } else if (kind === 'pptx') {
        const name = title.trim();
        output = { title: name, kind, file: await makeSlides({ title: name, sections: slideParts }, [], i18n.language as Locale, { theme, chart }),
          detail: chart?.title ?? slideParts[0]?.heading ?? '' };
      } else if (kind === 'xlsx' && sheet && cleaned) {
        const { rows, removed } = cleaned;
        output = { title: title.trim() || sheet.name, kind, file: await makeWorkbook(sheet.name, rows), detail: t('tableRows', { count: rows.length - 1, removed }) };
      } else if (kind === 'pdf') {
        const documents = [];
        for (const file of pdfSelection) {
          const source = sources.find(item => item.id === file.material.sourceId);
          if (!source || file.parsed?.kind !== 'pdf') throw 'source_unavailable';
          documents.push({ bytes: await readMaterial(source, file.material), pages: selectedPages });
        }
        const pdf = await makePdf(documents);
        output = { title: title.trim() || pdfSelection[0]!.material.relative.replace(/\.pdf$/i, ''), kind, file: pdf.file, detail: t('pageCount', { count: pdf.count }) };
      } else return;
      if (action === 'preview') setFilePreview({ ...output, parsed: await parseArtifact(output.file, output.kind) });
      else await add(output.title, output.kind, output.file, output.detail);
    } catch (error) { message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') })); }
    finally { setJob(undefined); setBusy(false); }
  }

  async function savePreview() {
    if (!filePreview || busy) return;
    setJob('save');
    setBusy(true);
    try {
      await add(filePreview.title, filePreview.kind, filePreview.file, filePreview.detail);
      setFilePreview(undefined);
    } finally { setJob(undefined); setBusy(false); }
  }

  return <>
    <div className="tool-tiles">
      {kinds.map(item => {
        const Icon = item === 'audit' ? FileSearchOutlined : fileIcons[item];
        return <button className={`tool-tile ${item}`} key={item} aria-pressed={kind === item} disabled={busy} onClick={() => update({ kind: item })}>
          <Icon /><strong>{t(tools[item])}</strong>
        </button>;
      })}
    </div>
    <section className="panel local-tool-panel" aria-label={t(tools[kind])}>
      <div className="local-tool-header"><div><h2>{t(tools[kind])}</h2><p className="muted">{t(hints[kind])}</p></div>
        {kind !== 'pptx' && <Button onClick={() => pick(kind)} icon={<PlusOutlined />} disabled={busy}>{t('fileChoose')}</Button>}</div>
      {kind === 'audit' ? <>
        <div className="field"><label htmlFor="tool-audit">{t('pickPresentation')}</label>
          <Select id="tool-audit" showSearch={{ optionFilterProp: 'label' }} value={selectedAudit?.id} options={presentations.map(file => ({ value: file.id, label: file.label }))}
            placeholder={t(presentations.length ? 'pickAvailable' : 'noCompatible')} onChange={auditId => update({ auditId })} /></div>
        <div><Button type="primary" icon={<FileSearchOutlined />} disabled={!selectedAudit} onClick={() => {
          if (selectedAudit) inspect(selectedAudit.type, selectedAudit.id);
        }}>{t('pptCheck')}</Button></div>
      </> : <>
      <div className="field"><label htmlFor="tool-title">{t('contentTitle')}</label>
        <Input id="tool-title" value={title} maxLength={100} disabled={busy}
          onChange={event => update({ titles: { ...titles, [kind]: event.target.value } })} placeholder={kind === 'pdf' || kind === 'xlsx' ? t('optional') : undefined} /></div>
      {kind === 'docx' && <>
        <div className="tool-grid">
          <div className="field"><label htmlFor="tool-word-language">{t('reportLanguage')}</label><Select id="tool-word-language" value={locale} onChange={locale => update({ locale })} disabled={busy}
            options={[{ value: 'zh-CN', label: t('zh') }, { value: 'en-US', label: t('en') }]} /></div>
          {files.some(item => item.parsed && item.material.kind !== 'xlsx') && <div className="field"><label htmlFor="tool-word-source">{t('takeText')}</label>
            <Select id="tool-word-source" value={undefined} showSearch={{ optionFilterProp: 'label' }} placeholder={t('pickAvailable')}
              onChange={id => insertText(files.filter(item => item.material.id === id))} disabled={busy}
              options={files.filter(item => item.parsed && item.material.kind !== 'xlsx').map(item => ({ value: item.material.id, label: item.material.relative }))} /></div>}
        </div>
        <div className="field"><label htmlFor="tool-body">{t('body')}</label><Input.TextArea id="tool-body" rows={8} maxLength={24_000} value={body} disabled={busy} placeholder={t('wordExample')}
          onChange={event => update({ body: event.target.value })} /></div>
        {!body.trim() && <div><Button size="small" onClick={() => update({ body: t('wordStarterText'), titles: { ...titles, docx: title.trim() || t('wordStarterTitle') } })}>{t('assistantLoadExample')}</Button></div>}
      </>}
      {kind === 'pptx' && <>
        <div className="field slide-theme-select"><label htmlFor="tool-slide-theme">{t('slideTheme')}</label>
          <Select id="tool-slide-theme" value={theme} onChange={(theme: SlideTheme) => update({ theme })} disabled={busy}
            options={[{ value: 'forest', label: t('slideForest') }, { value: 'blue', label: t('slideBlue') }, { value: 'ink', label: t('slideInk') }]} /></div>
        <div className="field"><label htmlFor="tool-outline">{t('outline')}</label><Input.TextArea id="tool-outline" rows={9} maxLength={6000} value={outline} disabled={busy}
          status={outline.trim() && !validOutline ? 'error' : undefined} onChange={event => update({ outline: event.target.value })} placeholder={t('outlineExample')} /></div>
        <div className="tool-inline-info">
          <p className="muted">{t(validOutline ? 'toolSlideCount' : 'formatLimits', { count: slideParts.length + 1 + Number(Boolean(chart)) })}</p>
          {!outline.trim() && <Button size="small" disabled={busy} onClick={() => update({ outline: t('outlineExample'), titles: { ...titles, pptx: title.trim() || t('examplePresentationTitle') } })}>{t('loadSlideExample')}</Button>}
        </div>
        <Checkbox checked={chartEnabled} disabled={busy} onChange={event => update({ chartEnabled: event.target.checked })}>{t('includeChart')}</Checkbox>
        {chartEnabled && <SlideDataFields workbooks={workbooks} selection={chartSelection} change={chartSelection => update({ chartSelection })} disabled={busy} add={() => pick('chart')} />}
      </>}
      {kind === 'xlsx' && <>
        <div className="tool-grid triple">
          <div className="field"><label htmlFor="tool-xlsx">{t('selectWorkbook')}</label><Select id="tool-xlsx" value={tableId} disabled={busy} onChange={selectWorkbook}
            placeholder={t(workbooks.length ? 'pickAvailable' : 'noCompatible')} options={workbooks.map(item => ({ value: item.material.id, label: item.material.relative }))} /></div>
          <div className="field"><label htmlFor="tool-sheet">{t('sheet')}</label><Select id="tool-sheet" value={sheetName || undefined} disabled={!sheets.length || busy}
            options={sheets.map(item => ({ value: item.name, label: item.name, disabled: !item.rows.length }))}
            onChange={sheetName => update({ sheetName, header: sheets.find(item => item.name === sheetName)?.rows[0]?.number ?? 1 })} /></div>
          <div className="field"><label htmlFor="tool-header">{t('headerRow')}</label><InputNumber id="tool-header" value={header} min={1} max={1048576} precision={0} disabled={!sheet || busy}
            onChange={header => { if (header) update({ header }); }} /></div>
        </div>
        <Checkbox checked={dedupe} disabled={busy} onChange={event => update({ dedupe: event.target.checked })}>{t('duplicateRows')}</Checkbox>
        {cleaned && <p className="tool-result-info">{t('tableRows', { count: cleaned.rows.length - 1, removed: cleaned.removed })}</p>}
        {sheet && !validHeader && <Alert type="warning" showIcon title={t('toolHeaderMissing')} />}
        {preview.length > 0 && <div className="mapping-peek"><h4>{t('previewRows')}</h4><div className="table-scroll"><table className="data-table">
          <thead><tr>{previewCols.map(col => <th key={col}>{preview[0]?.cells[col] ?? columnName(col)}</th>)}</tr></thead>
          <tbody>{preview.slice(1).map(row => <tr key={row.number}>{previewCols.map(col => <td key={col}>{String(row.cells[col] ?? '').slice(0, 100)}</td>)}</tr>)}</tbody>
        </table></div></div>}
      </>}
      {kind === 'pdf' && <>
        <div className="field"><label htmlFor="tool-pdfs">{t('selectPdf')}</label><Select id="tool-pdfs" mode="multiple" showSearch={{ optionFilterProp: 'label' }} value={pdfSelection.map(item => item.material.id)} disabled={busy} onChange={pdfIds => update({ pdfIds })} maxCount={12}
          placeholder={t(pdfs.length ? 'pickAvailable' : 'noCompatible')} options={pdfs.map(item => ({ value: item.material.id, label: item.material.relative }))} /></div>
        {pdfIds.length > 1 && pdfSelection.length === pdfIds.length && <div className="field">
          <label id="pdf-order-heading">{t('pdfMergeOrder')}</label>
          <ol className="pdf-order-list" aria-labelledby="pdf-order-heading">
            {pdfSelection.map((item, index) => <li key={item.material.id}>
              <span title={item.material.path}>{item.material.relative}</span>
              <small>{t('pageCount', { count: item.parsed?.kind === 'pdf' ? item.parsed.pageCount : 0 })}</small>
              <Button type="text" size="small" aria-label={t('pptMoveUp')} icon={<ArrowUpOutlined />} disabled={busy || index === 0} onClick={() => movePdf(index, -1)} />
              <Button type="text" size="small" aria-label={t('pptMoveDown')} icon={<ArrowDownOutlined />} disabled={busy || index === pdfSelection.length - 1} onClick={() => movePdf(index, 1)} />
              <Button type="text" size="small" aria-label={t('toolRemoveFile')} icon={<CloseOutlined />} disabled={busy}
                onClick={() => update({ pdfIds: pdfIds.filter(id => id !== item.material.id) })} />
            </li>)}
          </ol>
        </div>}
        {onlyPdf && <div className="field"><label htmlFor="tool-pages">{t('pages')}</label><Input id="tool-pages" value={pages} maxLength={90}
          status={pdfError ? 'error' : undefined} disabled={busy} placeholder={t('pagesExample')} onChange={event => update({ pages: event.target.value })} />
          {pdfError && <span className="error-text">{t('invalid_pages')}</span>}</div>}
        {pdfPageCount > 0 && !pdfError && pdfSelection.length === pdfIds.length && <p className="tool-result-info">{t('pdfOutputPages', { count: pdfPageCount })}</p>}
        {pdfSelection.length !== pdfIds.length && <Button size="small" disabled={busy}
          onClick={() => update({ pdfIds: pdfSelection.map(item => item.material.id) })}>{t('removeMissing')}</Button>}
      </>}
      <div className="artifact-actions">
        {kind === 'pptx' && <Button disabled={!enabled || busy} onClick={() =>
          compose({ draft: { title: title.trim(), sections: slideParts }, refs: [], locale: i18n.language as Locale, chart })}>{t('creativeFromOutline')}</Button>}
        <Button type="primary" loading={job === 'save'} disabled={!enabled || job === 'preview'} onClick={() => void build('save')}>{t('buildFile')}</Button>
        <Button icon={<EyeOutlined />} loading={job === 'preview'} disabled={!enabled || job === 'save'} onClick={() => void build('preview')}>
          {t(kind === 'pptx' ? 'previewSlideLayout' : 'previewToolOutput')}</Button>
      </div>
      </>}
    </section>
    {filePreview && <FilePreview file={{ ...filePreview, bytes: () => filePreview.file.arrayBuffer(), save: savePreview, saving: busy, saveLabel: t('storePreview') }}
      close={() => setFilePreview(undefined)} error={error => message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') }))} />}
  </>;
}
