import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined, EditOutlined, EyeOutlined, FilePptOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Checkbox, Drawer, Input, Modal } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, parseArtifact } from './desktop';
import type { Locale } from './domain';
import { makeSlides } from './office-output';
import { createPresentation } from './presentation';
import type { ProjectSlide, SlideAsset, SlideProject } from './slide-library';
import SlideLayout from './SlideLayout';

interface Props {
  open: boolean;
  locked: boolean;
  close: () => void;
  project: SlideProject;
  change: (project: SlideProject) => boolean;
  assets: SlideAsset[];
  deliver: (title: string, file: Blob, detail: string) => Promise<void>;
  setBusy: (busy: boolean) => void;
}

export default function PptProject({ open, locked, close, project, change, assets, deliver, setBusy }: Props) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const [working, setWorking] = useState(false);
  const [pageForm, setPageForm] = useState<{ id: string; title: string; text: string }>();
  const [previewId, setPreviewId] = useState<string>();
  const available = new Map(assets.map(item => [item.id, item]));
  const missing = project.pages.some(page => 'assetId' in page && !available.has(page.assetId));
  const previewPage = project.pages.find(page => page.id === previewId);
  const previewAsset = previewPage && 'assetId' in previewPage ? available.get(previewPage.assetId) : undefined;

  function move(index: number, shift: number) {
    const pages = project.pages.slice();
    const next = index + shift;
    if (next < 0 || next >= pages.length) return;
    [pages[index], pages[next]] = [pages[next]!, pages[index]!];
    change({ ...project, pages });
  }

  function savePage(form: Extract<ProjectSlide, { title: string }>) {
    const pages = project.pages.slice();
    const index = pages.findIndex(item => item.id === form.id);
    const page = { ...form, title: form.title.trim(), text: form.text.trim() };
    if (index < 0) pages.push(page);
    else pages[index] = page;
    if (change({ ...project, pages })) setPageForm(undefined);
  }

  async function exportDeck() {
    const title = project.title.trim();
    if (!project.pages.length || missing || !title || working || locked) return;
    setWorking(true);
    setBusy(true);
    try {
      const locale = i18n.language as Locale;
      const blobs: Blob[] = [];
      const compiled: { source: number; page: number }[] = [];
      const citations: string[] = [];
      const assetIndices = new Map<string, number>();
      async function appendText(heading: string, text: string) {
        const file = await makeSlides({ title, sections: [{ heading, text }] }, [], locale, { cover: false, pageNumbers: false });
        const parsed = await parseArtifact(file, 'pptx');
        if (parsed.kind !== 'pptx' || !parsed.pages.length) throw 'ppt_no_pages';
        const source = blobs.length;
        blobs.push(file);
        compiled.push(...parsed.pages.map(({ index }) => ({ source, page: index })));
      }

      for (const item of project.pages) {
        if ('assetId' in item) {
          const asset = available.get(item.assetId);
          if (!asset) throw 'ppt_asset_missing';
          const stored = assetIndices.get(asset.id);
          const source = stored ?? blobs.length;
          if (stored === undefined) {
            assetIndices.set(asset.id, source);
            blobs.push(asset.file);
          }
          citations.push(t('pptCitationLine', { output: compiled.length + 1, name: asset.origin.name, page: asset.origin.page }));
          compiled.push({ source, page: 1 });
        } else await appendText(item.title, item.text);
      }
      if (project.includeSources && citations.length) await appendText(t('pptSourceAppendix'), citations.join('\n'));
      const result = await createPresentation(blobs, compiled, title);
      await deliver(title, result.file, t('pageCount', { count: result.count }));
      if (result.fitted) message.info(t('pptFittedPages', { count: result.fitted }));
      close();
    } catch (error) {
      message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') }));
    } finally {
      setWorking(false);
      setBusy(false);
    }
  }

  return <>
    <Drawer open={open} title={t('pptProject')} onClose={() => { if (!working) close(); }} size="min(550px, 96vw)"
      extra={<Button type="primary" icon={<FilePptOutlined />} loading={working} disabled={!project.pages.length || !project.title.trim() || missing || locked}
        onClick={() => void exportDeck()}>{t('pptExportProject')}</Button>}>
      <div className="ppt-project-content">
        <div className="field"><label htmlFor="ppt-project-title">{t('pptProjectTitle')}</label>
          <Input id="ppt-project-title" maxLength={100} value={project.title} disabled={locked} onChange={event => change({ ...project, title: event.target.value })} /></div>
        {project.pages.length ? <ol className="ppt-project-pages">
          {project.pages.map((page, index) => {
            const asset = 'assetId' in page ? available.get(page.assetId) : undefined;
            return <li key={page.id}>
              <div className="min-w-0">
                <strong>{'assetId' in page ? asset?.title ?? t('ppt_asset_missing') : page.title}</strong>
                <small>{asset ? t('pptSourcePage', { name: asset.origin.name, page: asset.origin.page }) : !('assetId' in page) ? t('pptNewTextPage') : ''}</small>
              </div>
              <div className="ppt-project-actions">
                <Button size="small" type="text" icon={<EyeOutlined />} disabled={locked || ('assetId' in page && !asset)}
                  aria-label={t('pptGoToPage', { page: index + 1 })} onClick={() => setPreviewId(page.id)} />
                {!('assetId' in page) && <Button size="small" type="text" icon={<EditOutlined />} disabled={locked} aria-label={t('editDraft')}
                  onClick={() => setPageForm(page)} />}
                <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={locked || index === 0} aria-label={t('pptMoveUp')} onClick={() => move(index, -1)} />
                <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={locked || index === project.pages.length - 1} aria-label={t('pptMoveDown')}
                  onClick={() => move(index, 1)} />
                <Button size="small" type="text" icon={<CloseOutlined />} disabled={locked} aria-label={t('pptRemovePage')}
                  onClick={() => change({ ...project, pages: project.pages.filter(item => item.id !== page.id) })} />
              </div>
            </li>;
          })}
        </ol> : <p className="muted">{t('pptProjectEmpty')}</p>}
        <div><Button icon={<PlusOutlined />} disabled={locked} onClick={() => setPageForm({ id: crypto.randomUUID(), title: '', text: '' })}>{t('pptAddTextPage')}</Button></div>
        {project.pages.some(page => 'assetId' in page) && <Checkbox checked={project.includeSources} disabled={locked}
          onChange={event => change({ ...project, includeSources: event.target.checked })}>{t('pptIncludeSources')}</Checkbox>}
      </div>
    </Drawer>
    <Modal open={open && Boolean(previewPage)} width={740} title={previewAsset?.title ?? (previewPage && 'title' in previewPage ? previewPage.title : t('filePreview'))}
      onCancel={() => setPreviewId(undefined)} footer={<Button onClick={() => setPreviewId(undefined)}>{t('close')}</Button>}>
      {previewAsset && <SlideLayout key={previewAsset.id} page={{ index: 1, title: previewAsset.title, text: previewAsset.text, notes: previewAsset.notes }}
        read={() => previewAsset.file.arrayBuffer()} />}
      {previewPage && 'text' in previewPage && <article className="file-paper preview-page-text"><p>{previewPage.text}</p></article>}
    </Modal>
    <Modal open={open && Boolean(pageForm)} title={t('pptNewTextPage')} okText={t('save')} cancelText={t('cancel')} onCancel={() => setPageForm(undefined)}
      okButtonProps={{ disabled: locked || !pageForm?.title.trim() || !pageForm?.text.trim() }} onOk={() => { if (!locked && pageForm) savePage(pageForm); }}>
      {pageForm && <div className="edit-sections">
        <div className="field"><label htmlFor="ppt-page-title">{t('contentTitle')}</label>
          <Input id="ppt-page-title" maxLength={100} value={pageForm.title} onChange={event => setPageForm({ ...pageForm, title: event.target.value })} /></div>
        <div className="field"><label htmlFor="ppt-page-body">{t('body')}</label>
          <Input.TextArea id="ppt-page-body" rows={6} maxLength={8000} value={pageForm.text} onChange={event => setPageForm({ ...pageForm, text: event.target.value })} /></div>
      </div>}
    </Modal>
  </>;
}
