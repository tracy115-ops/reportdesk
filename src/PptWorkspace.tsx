import { AppstoreOutlined, EyeOutlined, FilePptOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Input, Modal, Pagination, Popconfirm, Segmented, Select, Spin, Tag } from 'antd';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, parseArtifactWithVersion, readMaterial } from './desktop';
import type { Loaded, PresentationPage, Source } from './domain';
import { deleteSlide, storedSlides, storeSlide } from './office';
import type { Artifact } from './office';
import PptProject from './PptProject';
import { Blank } from './Review';
import { deckVersion, readSlideProject, slideProjectKey, snapshotSlide } from './slide-library';
import type { SlideAsset, SlideOrigin, SlideProject } from './slide-library';
import SlideLayout from './SlideLayout';
import { writeLocal } from './storage';

export type PptPageLocation = Pick<SlideOrigin, 'type' | 'id' | 'page'>;

interface Props {
  active: boolean;
  locked: boolean;
  loadingSources: boolean;
  files: Loaded[];
  sources: Source[];
  artifacts: Artifact[];
  focus?: PptPageLocation;
  clearFocus: () => void;
  importDeck: () => void;
  importFolder: () => void;
  refresh: () => void;
  openPage: (page: PptPageLocation) => void;
  deliver: (title: string, file: Blob, detail: string) => Promise<void>;
  setBusy: (busy: boolean) => void;
}

interface Deck {
  type: SlideOrigin['type'];
  id: string;
  name: string;
  version?: string;
  pages: PresentationPage[];
  read: () => Promise<ArrayBuffer>;
}

interface Candidate {
  key: string;
  title: string;
  page: PresentationPage;
  name: string;
  number: number;
  read: () => Promise<ArrayBuffer>;
  deck?: Deck;
  asset?: SlideAsset;
}

const pageKey = (location: PptPageLocation) => [location.type, location.id, location.page].join(':');
const deckKey = (deck: Pick<Deck, 'type' | 'id'>) => deck.type + ':' + deck.id;
const searchText = (value: string) => value.normalize('NFKC').toLowerCase();

function queryScore(candidate: Candidate, query: string, words: string[]) {
  if (!words.length) return 0;
  const title = searchText(candidate.title);
  const named = searchText(candidate.name);
  const body = searchText(candidate.page.text);
  const notes = searchText(candidate.page.notes ?? '');
  const metadata = searchText([candidate.asset?.category ?? '', ...(candidate.asset?.tags ?? [])].join(' '));
  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += 10;
    else if (metadata.includes(word)) score += 7;
    else if (body.includes(word)) score += 5;
    else if (notes.includes(word)) score += 4;
    else if (named.includes(word)) score += 2;
    else return -1;
  }
  return score + (title.includes(query) ? 6 : 0);
}

function excerpt(text: string, query: string) {
  const word = query.split(/\s+/).find(word => word && searchText(text).includes(word));
  const at = word ? searchText(text).indexOf(word) : 0;
  const start = Math.max(0, at - 40);
  return (start ? '…' : '') + text.slice(start, start + 160).replace(/\s+/g, ' ');
}

export default function PptWorkspace({ active, locked, loadingSources, files, sources, artifacts, focus, clearFocus, importDeck, importFolder, refresh, openPage, deliver, setBusy }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [assets, setAssets] = useState<SlideAsset[]>([]);
  const [assetsReady, setAssetsReady] = useState(false);
  const [index, setIndex] = useState<Record<string, { file: Blob; pages: PresentationPage[]; version?: string }>>({});
  const [indexing, setIndexing] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | 'saved'>('all');
  const [category, setCategory] = useState<string>();
  const [deckFilter, setDeckFilter] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [pageNumber, setPageNumber] = useState(1);
  const [project, setProject] = useState(() => readSlideProject(t('pptNewDeck')));
  const [projectOpen, setProjectOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [edit, setEdit] = useState<{ item: Candidate; title: string; category: string; tags: string }>();
  const deferred = searchText(useDeferredValue(query).trim());

  useEffect(() => {
    if (!active || assetsReady) return;
    let present = true;
    void storedSlides().then(items => {
      if (present) { setAssets(items); setAssetsReady(true); }
    }).catch(() => { if (present) message.error(t('storage_error')); });
    return () => { present = false; };
  }, [active, assetsReady]);

  useEffect(() => {
    if (!active) return;
    const decks = artifacts.filter(file => file.kind === 'pptx' && index[file.id]?.file !== file.file);
    const live = new Set(artifacts.map(file => file.id));
    setIndex(current => Object.keys(current).some(id => !live.has(id))
      ? Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))) : current);
    if (!decks.length) { setIndexing(false); return; }
    const cancel = new AbortController();
    setIndexing(true);
    void (async () => {
      for (const deck of decks) {
        const data: (typeof index)[string] = { file: deck.file, pages: [] };
        try {
          const { parsed, version } = await parseArtifactWithVersion(deck.file, 'pptx', cancel.signal);
          if (parsed.kind === 'pptx') { data.pages = parsed.pages; data.version = version; }
        } catch { if (cancel.signal.aborted) return; }
        if (cancel.signal.aborted) return;
        setIndex(current => ({ ...current, [deck.id]: data }));
      }
      setIndexing(false);
    })();
    return () => cancel.abort();
  }, [active, artifacts]);

  useEffect(() => {
    if (!focus) return;
    setMode('all');
    setQuery('');
    setDeckFilter(undefined);
    setPageNumber(1);
    setSelected(pageKey(focus));
    clearFocus();
  }, [focus]);

  const decks = useMemo<Deck[]>(() => [
    ...files.flatMap(file => {
      const source = sources.find(item => item.id === file.material.sourceId);
      if (file.parsed?.kind !== 'pptx' || !source) return [];
      return [{ type: 'material' as const, id: file.material.id, name: file.material.relative, version: file.version, pages: file.parsed.pages,
        read: () => readMaterial(source, file.material) }];
    }),
    ...artifacts.flatMap(artifact => {
      const data = index[artifact.id];
      if (artifact.kind !== 'pptx' || !data?.pages.length || artifact.file !== data.file) return [];
      return [{ type: 'artifact' as const, id: artifact.id, name: artifact.title, version: data.version, pages: data.pages, read: () => artifact.file.arrayBuffer() }];
    }),
  ], [artifacts, files, index, sources]);

  const selectedDeck = deckFilter ? decks.find(deck => deckKey(deck) === deckFilter) : undefined;
  const candidates = useMemo<Candidate[]>(() => {
    if (mode === 'saved') return assets.filter(asset => !category || asset.category === category).map(asset => ({
      key: asset.id, title: asset.title, page: { index: 1, text: asset.text, title: asset.title, notes: asset.notes }, name: asset.origin.name,
      number: asset.origin.page, read: () => asset.file.arrayBuffer(), asset,
    }));
    return (selectedDeck ? [selectedDeck] : decks).flatMap(deck => deck.pages.map(page => ({
      key: pageKey({ type: deck.type, id: deck.id, page: page.index }), title: page.title || t('pptUntitledPage', { page: page.index }),
      page, name: deck.name, number: page.index, read: deck.read, deck,
    })));
  }, [assets, category, decks, selectedDeck, mode, t]);

  const results = useMemo(() => {
    const words = deferred.split(/\s+/).filter(Boolean);
    return candidates.map(item => ({ item, score: queryScore(item, deferred, words) })).filter(result => result.score >= 0)
      .sort((first, second) => second.score - first.score).map(result => result.item);
  }, [candidates, deferred]);
  const pageSize = 12;
  const selectedIndex = results.findIndex(item => item.key === selected);
  const currentPage = selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) + 1 : Math.min(pageNumber, Math.max(1, Math.ceil(results.length / pageSize)));
  const current = results[selectedIndex >= 0 ? selectedIndex : (currentPage - 1) * pageSize];
  const saved = current?.asset ?? (current?.deck && assets.find(asset => pageKey(asset.origin) === current.key && asset.origin.version === current.deck?.version));
  const origin = current?.asset?.origin;
  const original = current?.deck ?? (origin && decks.find(deck => deckKey(deck) === deckKey(origin) && deck.version === origin.version));
  const categories = [...new Set(assets.map(asset => asset.category).filter(Boolean))].sort();

  function updateProject(next: SlideProject) {
    try { writeLocal(slideProjectKey, next); setProject(next); return true; }
    catch { message.error(t('storage_error')); return false; }
  }

  async function preserve(item: Candidate, changes?: { title: string; category: string; tags: string[] }) {
    if (item.asset) {
      if (!changes) return item.asset;
      const asset = { ...item.asset, ...changes };
      await storeSlide(asset);
      setAssets(items => items.map(other => other.id === asset.id ? asset : other));
      return asset;
    }
    if (!item.deck) throw 'ppt_page_missing';
    const { deck } = item;
    const data = await deck.read();
    const version = await deckVersion(data);
    if (deck.version && version !== deck.version) throw 'ppt_source_changed';
    const existing = assets.find(asset => asset.origin.id === deck.id && asset.origin.type === deck.type
      && asset.origin.page === item.number && asset.origin.version === version);
    if (existing && !changes) return existing;
    const origin: SlideOrigin = { type: deck.type, id: deck.id, name: deck.name, page: item.number, version };
    const metadata = changes ?? { title: item.title, category: '', tags: [] };
    const asset = existing ? { ...existing, ...metadata } : await snapshotSlide(origin, data, metadata.title, item.page.text, item.page.notes ?? '', metadata);
    try { await storeSlide(asset); }
    catch { throw 'storage_error'; }
    setAssets(items => [asset, ...items.filter(other => other.id !== asset.id)]);
    return asset;
  }

  async function save(item: Candidate, insert: boolean) {
    if (writing || locked || !assetsReady) return;
    setWriting(true);
    setBusy(true);
    try {
      const changes = !insert && edit ? { title: edit.title.trim(), category: edit.category.trim(),
        tags: [...new Set(edit.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] } : undefined;
      const asset = await preserve(item, changes);
      if (insert) {
        if (updateProject({ ...project, pages: [...project.pages, { id: crypto.randomUUID(), assetId: asset.id }] })) {
          message.success(t('pptAddedToProject'));
        }
      } else {
        setEdit(undefined);
        message.success(t('pptSavedToLibrary'));
      }
    } catch (error) {
      message.error(t(errorCode(error, 'ppt_package_invalid'), { defaultValue: t('ppt_package_invalid') }));
    } finally { setWriting(false); setBusy(false); }
  }

  async function remove(asset: SlideAsset) {
    if (writing || locked) return;
    const pages = project.pages.filter(page => !('assetId' in page) || page.assetId !== asset.id);
    const used = pages.length !== project.pages.length;
    if (used && !updateProject({ ...project, pages })) return;
    setWriting(true);
    setBusy(true);
    try {
      await deleteSlide(asset.id);
      setAssets(items => items.filter(item => item.id !== asset.id));
    } catch {
      if (used) updateProject(project);
      message.error(t('storage_error'));
    } finally { setWriting(false); setBusy(false); }
  }

  function changeMode(value: 'all' | 'saved') {
    setMode(value);
    setCategory(undefined);
    setDeckFilter(undefined);
    setPageNumber(1);
    setSelected(undefined);
  }

  return <>
    <div className="page-heading"><div><h1>{t('slides')}</h1><p>{t('pptWorkspaceIntro')}</p></div>
      <div className="heading-actions">
        <Button icon={<FolderOpenOutlined />} disabled={locked} onClick={importFolder}>{t('addFolder')}</Button>
        <Button icon={<PlusOutlined />} disabled={locked} onClick={importDeck}>{t('addFiles')}</Button>
        <Button icon={<ReloadOutlined />} disabled={locked || !sources.length} aria-label={t('refresh')} onClick={refresh} />
        <Button type="primary" icon={<AppstoreOutlined />} disabled={!assetsReady || locked} onClick={() => setProjectOpen(true)}>{t('pptProjectWithCount', { count: project.pages.length })}</Button>
      </div>
    </div>
    <div className="ppt-workspace-grid">
      <section className="panel ppt-search-panel" aria-label={t('pptSearchPages')}>
        <div className="ppt-search-controls">
          <Segmented block value={mode} onChange={changeMode} options={[{ value: 'all', label: t('pptSearchPages') }, { value: 'saved', label: t('pptSavedSlides') }]} />
          <Input prefix={<SearchOutlined />} allowClear placeholder={t('pptSearchPlaceholder')} aria-label={t('pptSearchPages')} value={query}
            onChange={event => { setQuery(event.target.value); setSelected(undefined); setPageNumber(1); }} />
          {mode === 'all' && decks.length > 1 && <Select allowClear aria-label={t('pickPresentation')} value={selectedDeck ? deckKey(selectedDeck) : undefined} placeholder={t('pptAllDecks')}
            options={decks.map(deck => ({ label: deck.name, value: deckKey(deck) }))}
            onChange={value => { setDeckFilter(value); setSelected(undefined); setPageNumber(1); }} />}
          {mode === 'saved' && categories.length > 0 && <Select allowClear aria-label={t('pptCategory')} value={category} placeholder={t('pptAllCategories')}
            options={categories.map(value => ({ label: value, value }))} onChange={value => { setCategory(value); setSelected(undefined); setPageNumber(1); }} />}
        </div>
        {mode === 'all' && (loadingSources || indexing) && <div className="ppt-search-status" role="status"><Spin size="small" /> {t(loadingSources ? 'loadingMaterials' : 'pptIndexing')}</div>}
        <div className="ppt-result-list">
          {results.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(item => <button key={item.key} className="ppt-result"
            aria-pressed={current?.key === item.key} onClick={() => setSelected(item.key)}>
            <FilePptOutlined />
            <span className="ppt-result-copy"><strong>{item.title}</strong>
              <small>{t('pptSourcePage', { name: item.name, page: item.number })}</small>
              <span>{excerpt(item.page.notes && deferred && searchText(item.page.notes).includes(deferred) ? item.page.notes : item.page.text, deferred)}</span>
            </span>
          </button>)}
          {!results.length && !(mode === 'all' && (loadingSources || indexing)) && <Blank kind="folder"
            title={t(deferred ? 'noMatches' : mode === 'saved' ? 'pptSavedEmpty' : 'pptNoDecks')} body="" />}
        </div>
        {results.length > pageSize && <Pagination className="ppt-pagination" size="small" current={currentPage} pageSize={pageSize} total={results.length}
          onChange={value => { setSelected(undefined); setPageNumber(value); }} showSizeChanger={false} />}
      </section>
      <section className="panel ppt-detail-panel" aria-label={t('filePreview')}>
        {current ? <>
          <div className="ppt-detail-heading">
            <div><h2>{current.title}</h2><p>{t('pptSourcePage', { name: current.name, page: current.number })}</p></div>
            {original && <Button type="text" icon={<EyeOutlined />} onClick={() => openPage({ type: original.type, id: original.id, page: current.number })}>
              {t('pptOpenSourcePage')}</Button>}
          </div>
          {saved && (saved.category || saved.tags.length > 0) && <div className="ppt-category-row">
            {saved.category && <Tag color="green">{saved.category}</Tag>}{saved.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
          </div>}
          <div className="ppt-slide-stage">{active && <SlideLayout key={current.key} page={current.page} read={current.read} />}</div>
          <div className="ppt-detail-actions">
            <Button type="primary" icon={<PlusOutlined />} disabled={locked || writing || !assetsReady} onClick={() => void save(current, true)}>{t('pptAddToProject')}</Button>
            <Button icon={<StarOutlined />} disabled={locked || writing || !assetsReady} onClick={() => setEdit({ item: saved ? { ...current, asset: saved } : current, title: saved?.title ?? current.title,
              category: saved?.category ?? '', tags: saved?.tags.join(', ') ?? '' })}>{t(saved ? 'pptEditSaved' : 'pptSaveSlide')}</Button>
            {current.asset && <Popconfirm title={t('pptDeleteSaved')} okText={t('pptRemoveSaved')} cancelText={t('cancel')} onConfirm={() => void remove(current.asset!)}>
              <Button type="text" danger disabled={locked || writing}>{t('pptRemoveSaved')}</Button>
            </Popconfirm>}
          </div>
          {current.page.notes && <details className="ppt-speaker-notes"><summary>{t('pptSpeakerNotes')}</summary><p>{current.page.notes}</p></details>}
        </> : <Blank kind="review" title={t('pptChoosePage')} body="" />}
      </section>
    </div>
    <Modal open={active && Boolean(edit)} title={t(edit?.item.asset ? 'pptEditSaved' : 'pptSaveSlide')} width={520}
      onCancel={() => { if (!writing) setEdit(undefined); }} maskClosable={!writing}
      okText={t('save')} cancelText={t('cancel')} confirmLoading={writing} okButtonProps={{ disabled: locked || !edit?.title.trim() }}
      onOk={() => { if (edit) void save(edit.item, false); }}>
      {edit && <div className="edit-sections">
        <div className="field"><label htmlFor="ppt-asset-title">{t('contentTitle')}</label>
          <Input id="ppt-asset-title" maxLength={120} value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} /></div>
        <div className="field"><label htmlFor="ppt-asset-category">{t('pptCategory')}</label>
          <Input id="ppt-asset-category" maxLength={64} value={edit.category} onChange={event => setEdit({ ...edit, category: event.target.value })} /></div>
        <div className="field"><label htmlFor="ppt-asset-tags">{t('pptTags')}</label>
          <Input id="ppt-asset-tags" maxLength={240} value={edit.tags} placeholder={t('pptTagsPlaceholder')} onChange={event => setEdit({ ...edit, tags: event.target.value })} /></div>
      </div>}
    </Modal>
    <PptProject open={active && projectOpen} locked={locked} close={() => setProjectOpen(false)} project={project} change={updateProject} assets={assets} deliver={deliver} setBusy={setBusy} />
  </>;
}
