import { ArrowRightOutlined, FileOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Spin } from 'antd';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComponentRef } from 'react';
import type { Loaded, Location } from './domain';
import type { Artifact } from './office';
import { findExcerpts } from './office';

export default function WorkspaceSearch({ files, artifacts, pages, navigate, material, artifact, locate }: {
  files: Loaded[]; artifacts: Artifact[]; pages: { key: string; label: string }[];
  navigate: (key: string) => void; material: (id: string) => void; artifact: (id: string) => void; locate: (location: Location) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const input = useRef<ComponentRef<typeof Input>>(null);
  const deferredQuery = useDeferredValue(query);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(value => !value); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  const results = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    const pageItems = pages.filter(page => !normalized || page.label.toLocaleLowerCase().includes(normalized)).map(page => ({ id: 'page-' + page.key, type: 'commandPages', title: page.label, detail: '', action: () => navigate(page.key) }));
    const materials = normalized ? files.filter(file => file.material.relative.toLocaleLowerCase().includes(normalized)).slice(0, 7).map(file => ({ id: 'material-' + file.material.id, type: 'commandFiles', title: file.material.relative, detail: file.material.path, action: () => material(file.material.id) })) : [];
    const outputs = artifacts.filter(item => !normalized || item.title.toLocaleLowerCase().includes(normalized)).slice(0, normalized ? 6 : 4).map(item => ({ id: 'artifact-' + item.id, type: 'commandOutputs', title: item.title + '.' + item.kind, detail: new Date(item.createdAt).toLocaleDateString(), action: () => artifact(item.id) }));
    const excerpts = normalized.length >= 2 ? findExcerpts(files, deferredQuery, 6, false).map((ref, index) => ({ id: 'excerpt-' + index, type: 'commandExcerpts', title: ref.locations[0]!.file + ' · ' + ref.locations[0]!.at, detail: ref.text, action: () => locate(ref.locations[0]!) })) : [];
    return [...pageItems, ...materials, ...outputs, ...excerpts];
  }, [deferredQuery, pages, files, artifacts]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { if (open) document.getElementById('workspace-search-' + selected)?.scrollIntoView({ block: 'nearest' }); }, [selected, open]);
  const pending = query !== deferredQuery;
  function activate(index: number) { const item = results[index]; if (item && !pending) { item.action(); setOpen(false); } }
  return <>
    <Button type="text" className="workspace-search-trigger" icon={<SearchOutlined />} aria-label={t('navSearch')} onClick={() => { setOpen(true); setQuery(''); }}><span>{t('navSearch')}</span><kbd>Ctrl K</kbd></Button>
    <Modal open={open} title={null} footer={null} width={650} className="workspace-search-modal" onCancel={() => setOpen(false)} afterOpenChange={visible => { if (visible) input.current?.focus(); }}>
      <Input ref={input} size="large" variant="borderless" prefix={<SearchOutlined />} suffix={pending ? <Spin size="small" /> : null} value={query} placeholder={t('commandPlaceholder')} aria-label={t('commandPlaceholder')} role="combobox" aria-expanded aria-autocomplete="list" aria-controls="workspace-search-list" aria-activedescendant={'workspace-search-' + selected} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(index => Math.min(results.length - 1, index + 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => Math.max(0, index - 1)); }
        if (event.key === 'Enter') { event.preventDefault(); activate(selected); }
      }} />
      <div id="workspace-search-list" className="workspace-search-results" role="listbox" aria-busy={pending} aria-label={t('navSearch')}>
        {!results.length && <p className="muted">{t('commandEmpty')}</p>}
        {results.map((item, index) => <div key={item.id}>
          {(index === 0 || item.type !== results[index - 1]!.type) && <h3>{t(item.type)}</h3>}
          <button id={'workspace-search-' + index} type="button" role="option" aria-selected={index === selected} onMouseEnter={() => setSelected(index)} onClick={() => activate(index)}><FileOutlined /><span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span><ArrowRightOutlined /></button>
        </div>)}
      </div>
      <div className="workspace-search-hint"><kbd>↑ ↓</kbd> <kbd>Enter</kbd> <kbd>Esc</kbd></div>
    </Modal>
  </>;
}
