import { EyeOutlined, LinkOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Pagination, Segmented, Select } from 'antd';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { evidenceSignature, fromSource, materialKinds } from './domain';
import type { Evidence, Loaded, Location, MaterialKind, Source } from './domain';
import { fileIcons } from './OfficeTools';
import { findExcerpts } from './office';
import { materialsLibraryEn, materialsLibraryZh } from './materials-library-i18n';
import './materials-library.css';

interface Props {
  files: Loaded[];
  sources?: readonly Source[];
  preview: (id: string) => void;
  locate: (location: Location) => void;
  attach: (id: string) => void;
  useExcerpt: (evidence: Evidence) => void;
  busy: boolean;
}

type Mode = 'filename' | 'content';
type ReadStatus = 'all' | 'ready' | 'failed';

function parentPath(path: string) {
  return path.replaceAll('\\', '/').split('/').slice(0, -1).join('/');
}

function filename(path: string) {
  return path.replaceAll('\\', '/').split('/').at(-1) || path;
}

function sourceChoices(sources: readonly Source[] | undefined, files: Loaded[]) {
  const items = new Map(sources?.map(source => [source.id, { name: source.name, path: source.path }]));
  for (const { material, sourceAliases } of files) {
    for (const id of [material.sourceId, ...(sourceAliases ?? [])]) {
      if (items.has(id)) continue;
      const folder = parentPath(material.path);
      items.set(id, { name: filename(folder), path: folder });
    }
  }
  return items;
}

export default function MaterialsView({ files, sources, preview, locate, attach, useExcerpt, busy }: Props) {
  const { t, i18n } = useTranslation();
  const copy = i18n.language.startsWith('zh') ? materialsLibraryZh : materialsLibraryEn;
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('filename');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState<MaterialKind | 'all'>('all');
  const [status, setStatus] = useState<ReadStatus>('all');
  const [page, setPage] = useState(1);
  const term = useDeferredValue(query.trim().normalize('NFKC').toLocaleLowerCase());
  const choices = useMemo(() => sourceChoices(sources, files), [sources, files]);
  const selectedSource = choices.has(source) ? source : '';
  const scoped = useMemo(() => files.filter(file => (!selectedSource || fromSource(file, selectedSource))
    && (kind === 'all' || file.material.kind === kind)), [files, kind, selectedSource]);
  const readyCount = scoped.filter(file => file.parsed).length;
  const named = mode === 'filename' ? scoped.filter(file => (status === 'all' || (status === 'ready' ? file.parsed : file.error))
    && filename(file.material.relative).normalize('NFKC').toLocaleLowerCase().includes(term)) : [];
  const matches = useMemo(() => mode === 'content' && term ? findExcerpts(scoped, term, 60, false) : [], [mode, scoped, term]);
  const pageSize = mode === 'filename' ? 12 : 8;
  const resultCount = mode === 'filename' ? named.length : matches.length;
  const current = Math.min(page, Math.max(1, Math.ceil(resultCount / pageSize)));
  const start = (current - 1) * pageSize;
  const filtered = Boolean(query || selectedSource || kind !== 'all' || status !== 'all' && mode === 'filename');
  const reset = () => { setQuery(''); setSource(''); setKind('all'); setStatus('all'); setPage(1); };
  const loading = busy && files.length === 0;
  const statusLabel = mode === 'filename' ? copy.results(resultCount) : copy.excerpts(resultCount);
  const lookupName = mode === 'filename' ? copy.filenamePrompt : copy.contentPrompt;

  return <section className="panel materials-library" aria-labelledby="materials-library-title" aria-busy={loading}>
    <header className="materials-library-header">
      <h2 id="materials-library-title">{copy.title}</h2>
      <Segmented<Mode> size="small" value={mode} aria-label={copy.title}
        options={[{ value: 'filename', label: copy.filename }, { value: 'content', label: copy.content }]}
        onChange={value => { setMode(value); setPage(1); }} />
    </header>
    <div className="materials-library-controls">
      <Input aria-label={lookupName} prefix={<SearchOutlined />} allowClear value={query}
        onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder={lookupName} />
      <div className="materials-library-filters" data-filename={mode === 'filename'}>
        <label>{copy.source}<Select aria-label={copy.source} value={selectedSource} onChange={value => { setSource(value); setPage(1); }}
          options={[{ value: '', label: copy.allSources }, ...[...choices.entries()].map(([id, group]) => ({ value: id, label: group.name || copy.missingSource, title: group.path }))]} /></label>
        <label>{t('formatFilter')}<Select aria-label={t('formatFilter')} value={kind} onChange={value => { setKind(value); setPage(1); }}
          options={(['all', ...materialKinds] as const).map(value => ({ value, label: value === 'all' ? t('allFormats') : value.toUpperCase() }))} /></label>
        {mode === 'filename' && <label>{copy.status}<Select aria-label={copy.status} value={status}
          onChange={value => { setStatus(value); setPage(1); }} options={[
            { value: 'all', label: copy.allStates }, { value: 'ready', label: copy.ready }, { value: 'failed', label: copy.failed },
          ]} /></label>}
      </div>
    </div>
    <div className="materials-library-summary">
      <span role="status">{loading ? t('loadingMaterials') : <><strong>{statusLabel}</strong>
        {mode === 'filename' && <small>{copy.totals(readyCount, scoped.length - readyCount)}</small>}</>}</span>
      {filtered && <Button type="link" size="small" onClick={reset}>{copy.clear}</Button>}
    </div>
    {mode === 'filename' && <ul className="materials-library-list">
      {named.slice(start, start + pageSize).map(({ material, error }) => {
        const Icon = fileIcons[material.kind];
        const group = choices.get(selectedSource || material.sourceId);
        return <li className="materials-library-row" key={material.id}>
          <span className={'file-kind ' + material.kind} aria-hidden="true"><Icon /></span>
          <div className="materials-library-file">
            <strong title={material.path}>{material.relative}</strong>
            <span className="materials-library-metadata">
              <small title={group?.path}>{group?.name || copy.missingSource}</small>
              <small>{material.kind.toUpperCase()}</small>
              {error ? <small className="materials-library-failed" title={t(error)}>{copy.failed}</small> : <small className="materials-library-ready">{copy.ready}</small>}
            </span>
            {error && <small className="materials-library-failed">{t(error)}</small>}
          </div>
          <div className="materials-library-actions">
            <Button size="small" icon={<EyeOutlined />} aria-label={`${t('filePreview')} ${material.relative}`}
              onClick={() => preview(material.id)}>{t('filePreview')}</Button>
            <Button size="small" type="text" icon={<PlusOutlined />} disabled={busy || Boolean(error)}
              title={t('attachFileToAssistant')} aria-label={t('assistantUseFile', { name: material.relative })} onClick={() => attach(material.id)} />
          </div>
        </li>;
      })}
    </ul>}
    {mode === 'content' && <ul className="materials-library-list materials-library-excerpts">
      {matches.slice(start, start + pageSize).map(item => {
        const location = item.locations[0]!;
        return <li className="materials-library-excerpt" key={evidenceSignature(item)}>
          <div className="materials-library-excerpt-top">
            <div className="materials-library-file"><strong title={location.path}>{location.file}</strong>
              <small className="materials-library-location" title={location.path}>{location.at}</small></div>
            <div className="materials-library-actions">
              <Button type="text" size="small" icon={<LinkOutlined />} onClick={() => locate(location)}>{t('jumpToSource')}</Button>
              <Button type="link" size="small" icon={<PlusOutlined />} disabled={busy} onClick={() => useExcerpt(item)}>{t('useExcerpt')}</Button>
            </div>
          </div>
          <p>{item.text}</p>
        </li>;
      })}
    </ul>}
    {resultCount > pageSize && <Pagination size="small" current={current} pageSize={pageSize} total={resultCount}
      onChange={setPage} showSizeChanger={false} />}
    {!resultCount && !loading && <p className="materials-library-empty">{files.length === 0 ? t('sourceEmptyBody')
      : mode === 'content' && !term ? copy.typeQuery : t('noMatches')}</p>}
  </section>;
}
