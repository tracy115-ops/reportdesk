import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Popconfirm, Segmented, Select, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { evidenceSignature } from './domain';
import type { Evidence, Loaded, MaterialKind } from './domain';
import type { dataWorkbenchZh } from './data-workbench-i18n';
import { findExcerpts } from './office';
import { buildKnowledgeIndex, deleteKnowledgeIndex, hybridKnowledgeSearch, knowledgeSegmentLimit, knowledgeStatus, loadKnowledgeIndex } from './knowledge-index';
import type { KnowledgeIndex, KnowledgeModel, KnowledgeProgress } from './knowledge-index';
import { knowledgeEn, knowledgeZh } from './knowledge-i18n';
import './knowledge-search.css';

interface Props {
  datasetId: string;
  name: string;
  files: Loaded[];
  copy: typeof dataWorkbenchZh;
  close: () => void;
  preview?: (id: string, at?: string) => void;
  useExcerpts?: (excerpts: Evidence[]) => void;
  models?: ReadonlyArray<KnowledgeModel>;
  openSettings?: () => void;
}

const selectionLimit = 6;
const resultLimit = 60;

export default function DatasetSearch({ datasetId, name, files, copy, close, preview, useExcerpts, models = [], openSettings }: Props) {
  const { i18n } = useTranslation();
  const labels = i18n.language === 'zh-CN' ? knowledgeZh : knowledgeEn;
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<MaterialKind | 'all'>('all');
  const [selected, setSelected] = useState<Evidence[]>([]);
  const [mode, setMode] = useState<'keyword' | 'hybrid'>('keyword');
  const [modelId, setModelId] = useState<string>();
  const [index, setIndex] = useState<KnowledgeIndex>();
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<KnowledgeProgress>();
  const [operation, setOperation] = useState<'build' | 'search' | 'clear'>();
  const [error, setError] = useState<'buildFailed' | 'searchFailed' | 'loadFailed'>();
  const [ranked, setRanked] = useState<Evidence[]>();
  const pending = useRef<AbortController>(undefined);
  const model = models.find(option => option.id === modelId) ?? models[0];
  const activeIndex = index?.model === model?.fingerprint ? index : undefined;
  const coverage = knowledgeStatus(activeIndex, files);
  const formats = Array.from(new Set(files.map(file => file.material.kind))).sort();
  const scope = useMemo(() => files.filter(file => format === 'all' || file.material.kind === format), [files, format]);
  const currentFiles = new Map(files.map(file => [file.material.id, file.version]));
  const isCurrent = (item: Evidence) => item.locations.every(location => location.materialId && currentFiles.has(location.materialId)
    && currentFiles.get(location.materialId) === location.version);
  const usableSelected = selected.filter(isCurrent);
  const matching = useMemo(() => {
    if (!query) return { names: [], excerpts: [] };
    const words = query.split(/\s+/);
    const names = scope.filter(({ material }) => words.every(word => material.relative.normalize('NFKC').toLowerCase().includes(word)));
    return { names: names.slice(0, resultLimit), excerpts: findExcerpts(scope, query, resultLimit, false) };
  }, [scope, query]);
  const results = (mode === 'hybrid' && ranked ? ranked : matching.excerpts).filter(isCurrent);
  const signatures = new Set(usableSelected.map(evidenceSignature));

  useEffect(() => {
    let current = true;
    void loadKnowledgeIndex(datasetId).then(value => { if (current) setIndex(value); })
      .catch(() => { if (current) setError('loadFailed'); }).finally(() => { if (current) setLoaded(true); });
    return () => { current = false; pending.current?.abort(); };
  }, [datasetId]);

  function cancel() {
    pending.current?.abort();
    pending.current = undefined;
    setOperation(undefined);
  }

  function begin(next: 'build' | 'search' | 'clear') {
    const work = new AbortController();
    pending.current = work;
    setOperation(next);
    setError(undefined);
    return work;
  }

  function finish(work: AbortController) {
    if (pending.current === work) {
      pending.current = undefined;
      setOperation(undefined);
    }
  }

  async function search(value: string) {
    const text = value.trim().normalize('NFKC');
    setQuery(text.toLowerCase());
    setRanked(undefined);
    setError(undefined);
    if (!text || mode !== 'hybrid' || !activeIndex || !model || !coverage.segments || pending.current) return;
    const work = begin('search');
    try {
      setRanked(await hybridKnowledgeSearch(activeIndex, model, scope, text, findExcerpts(scope, text, resultLimit, false), work.signal));
    } catch { if (!work.signal.aborted) setError('searchFailed'); }
    finally { finish(work); }
  }

  async function build() {
    if (!model || pending.current) return;
    setProgress(undefined);
    setRanked(undefined);
    const work = begin('build');
    try { setIndex(await buildKnowledgeIndex(datasetId, model, files, work.signal, setProgress)); }
    catch { if (!work.signal.aborted) setError('buildFailed'); }
    finally { finish(work); }
  }

  async function clear() {
    if (pending.current) return;
    const work = begin('clear');
    try {
      await deleteKnowledgeIndex(datasetId, work.signal);
      if (!work.signal.aborted) { setIndex(undefined); setRanked(undefined); }
    } catch { if (!work.signal.aborted) setError('loadFailed'); }
    finally { finish(work); }
  }

  function remove(signature: string) {
    setSelected(current => current.filter(item => evidenceSignature(item) !== signature));
  }

  const clearIndex = index && <Popconfirm title={labels.clearTitle} okText={labels.clear} cancelText={copy.cancel} onConfirm={clear}>
    <Button size="small" type="text" disabled={!!operation}>{labels.clear}</Button>
  </Popconfirm>;

  return <Modal className="data-search-modal" open title={copy.searchDataset} width={680} onCancel={close}
    footer={<div className="data-search-footer">
      {useExcerpts && <span>{copy.searchSelected.replace('{{count}}', String(usableSelected.length)).replace('{{limit}}', String(selectionLimit))}</span>}
      <Button onClick={close}>{copy.cancel}</Button>
      {useExcerpts && <Button type="primary" disabled={!usableSelected.length} onClick={() => useExcerpts(usableSelected)}>{copy.searchUseExcerpts}</Button>}
    </div>}>
    <p className="data-search-scope" title={name}>{name}</p>
    <div className="knowledge-mode">
      <Segmented<'keyword' | 'hybrid'> size="small" value={mode} disabled={operation === 'build' || operation === 'clear'} onChange={value => {
        cancel(); setMode(value); setRanked(undefined); setError(undefined);
      }} options={[{ value: 'keyword', label: labels.keyword }, { value: 'hybrid', label: labels.hybrid }]} />
    </div>
    {mode === 'hybrid' && <section className="knowledge-settings" aria-label={labels.hybrid}>
      {model ? <>
        <div className="knowledge-actions">
          <Select size="small" aria-label={labels.model} value={model.id} disabled={!!operation} onChange={value => {
            setModelId(value); setRanked(undefined); setError(undefined);
          }} options={models.map(option => ({ value: option.id, label: option.label }))} />
          <Button size="small" disabled={!loaded || operation === 'search' || operation === 'clear' || !files.length}
            loading={operation === 'build'} onClick={() => void build()}>{activeIndex ? labels.update : labels.build}</Button>
          {operation === 'build' && <Button size="small" onClick={cancel}>{labels.cancelBuild}</Button>}
          {clearIndex}
        </div>
        {loaded && <p>{activeIndex ? labels.coverage.replace('{{files}}', String(coverage.covered)).replace('{{total}}', String(coverage.total))
          .replace('{{segments}}', String(coverage.segments)) : index ? labels.otherModel : labels.first}</p>}
        {coverage.stale && <p className="knowledge-warning">{labels.stale}</p>}
        {coverage.limited && <p className="knowledge-warning">{labels.limited.replace('{{limit}}', String(knowledgeSegmentLimit))}</p>}
        <p>{labels.privacy}</p>
      </> : <div className="knowledge-actions">
        <p>{labels.noModel}</p>{openSettings && <Button type="link" size="small" onClick={openSettings}>{labels.configure}</Button>}{clearIndex}
      </div>}
      {operation === 'build' && <p role="status">{labels.building.replace('{{done}}', String(progress?.done ?? 0)).replace('{{total}}', String(progress?.total ?? 0))}</p>}
      {error && <p className="knowledge-warning" role="alert">{labels[error]}</p>}
    </section>}
    <div className="data-search-fields">
      <Input.Search autoFocus allowClear aria-label={mode === 'hybrid' ? labels.searchLabel : copy.searchPrompt}
        placeholder={mode === 'hybrid' ? labels.searchLabel : copy.searchPrompt} value={input} disabled={operation === 'build' || operation === 'clear'}
        loading={operation === 'search'} onChange={event => {
          if (operation === 'search') cancel();
          setInput(event.target.value);
          if (!event.target.value) { setQuery(''); setRanked(undefined); }
        }} onSearch={value => void search(value)} enterButton={<SearchOutlined />} maxLength={180} />
      <Select aria-label={copy.searchFormat} value={format} disabled={!!operation} onChange={value => { setFormat(value); setRanked(undefined); }}
        options={[{ value: 'all', label: copy.searchAllFormats }, ...formats.map(value => ({ value, label: value.toUpperCase() }))]} />
    </div>
    {!!usableSelected.length && <div className="data-search-selection">
      {usableSelected.map(item => {
        const signature = evidenceSignature(item);
        const source = item.locations[0];
        return <Tag key={signature} closable onClose={event => { event.preventDefault(); remove(signature); }}
          title={item.text}>{source?.file} · {source?.at}</Tag>;
      })}
    </div>}
    <div className="data-search-results" aria-live="polite">
      {!query && <p>{copy.searchStart}</p>}
      {operation === 'search' && <p role="status">{labels.searching}</p>}
      {query && operation !== 'search' && !matching.names.length && !results.length && <p>{copy.searchEmpty}</p>}
      {!!matching.names.length && <section className="data-search-matches">
        <h3>{copy.searchFiles}</h3>
        <ul>{matching.names.map(({ material }) => <li key={material.id} title={material.path} className="data-search-file">
          <span>{material.relative}</span>
          {preview && <Button type="link" size="small" onClick={() => preview(material.id)}>{copy.searchPreview}</Button>}
        </li>)}</ul>
      </section>}
      {!!results.length && <section className="data-search-matches">
        <h3>{ranked ? labels.results : copy.searchExcerpts}</h3>
        <ul>{results.map(item => {
          const source = item.locations[0];
          if (!source) return null;
          const signature = evidenceSignature(item);
          const picked = signatures.has(signature);
          return <li key={signature} className="data-search-excerpt">
            <div className="data-search-excerpt-top">
              {useExcerpts ? <Checkbox checked={picked} disabled={!picked && usableSelected.length >= selectionLimit}
                onChange={event => event.target.checked ? setSelected(current => [...current.filter(isCurrent), item].slice(0, selectionLimit)) : remove(signature)}>
                <span>{source.file} · {source.at}</span>
              </Checkbox> : <span>{source.file} · {source.at}</span>}
              {preview && source.materialId && <Button type="link" size="small" onClick={() => preview(source.materialId!, source.at)}>{copy.searchPreview}</Button>}
            </div>
            <p>{item.text}</p>
          </li>;
        })}</ul>
      </section>}
    </div>
  </Modal>;
}
