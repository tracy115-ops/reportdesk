import { DownloadOutlined, ExportOutlined, EyeOutlined, MoreOutlined, SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Checkbox, Dropdown, Input, Modal, Pagination, Select } from 'antd';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactKind } from './domain';
import type { Artifact } from './office';
import { fileIcons } from './OfficeTools';
import { Blank } from './Review';

interface Props {
  items: Artifact[];
  exporting: boolean;
  preview: (id: string) => void;
  open?: (item: Artifact) => void;
  save: (item: Artifact) => void;
  savePack: (items: Artifact[]) => void;
  remove: (id: string) => void;
  rename: (id: string, title: string) => void;
}

export default function ArtifactsView({ items, exporting, preview, open, save, savePack, remove, rename }: Props) {
  const { t, i18n } = useTranslation();
  const { modal } = AntApp.useApp();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | ArtifactKind>('all');
  const [editing, setEditing] = useState<{ id: string; title: string }>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'newest' | 'name'>('newest');
  const term = useDeferredValue(query.normalize('NFKC').trim().toLocaleLowerCase());
  const visible = useMemo(() => {
    const filtered = items.filter(item => (kind === 'all' || item.kind === kind)
      && [item.title, item.detail, item.savedPath ?? ''].join('\n').normalize('NFKC').toLocaleLowerCase().includes(term));
    return filtered.sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, i18n.language) : b.createdAt.localeCompare(a.createdAt));
  }, [items, kind, term, sort, i18n.language]);
  const pageSize = 12;
  const current = Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize)));
  const displayed = visible.slice((current - 1) * pageSize, current * pageSize);
  const included = items.filter(item => selected.has(item.id));
  const pageChecked = displayed.filter(item => selected.has(item.id)).length;
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  function selectItems(ids: string[], checked: boolean) {
    setSelected(current => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  return <section className="panel history-panel">
    {items.length > 0 && <div className="artifact-filters">
      <Input aria-label={t('searchArtifacts')} placeholder={t('searchArtifacts')} prefix={<SearchOutlined />} allowClear value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      <Select aria-label={t('formatFilter')} value={kind} onChange={value => { setKind(value); setPage(1); }}
        options={(['all', 'docx', 'xlsx', 'pptx', 'pdf', 'html', 'png', 'mp3', 'mp4'] as const).map(value => ({ value, label: t(value === 'all' ? 'allFormats' : value) }))} />
      <Select aria-label={t('artifactSort')} value={sort} onChange={value => { setSort(value); setPage(1); }}
        options={[{ value: 'newest', label: t('artifactNewest') }, { value: 'name', label: t('artifactByTitle') }]} />
    </div>}
    {(displayed.length > 0 || included.length > 0) && <div className="artifact-selection">
      <Checkbox checked={pageChecked > 0 && pageChecked === displayed.length} indeterminate={pageChecked > 0 && pageChecked < displayed.length}
        disabled={!displayed.length} onChange={event => selectItems(displayed.map(item => item.id), event.target.checked)}>{t('selectThisPage')}</Checkbox>
      {included.length > 0 && <Button type="text" size="small" onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>}
      <Button icon={<DownloadOutlined />} type={included.length ? 'primary' : 'default'} disabled={exporting || !included.length}
        onClick={() => savePack(included)}>{t('exportSelectedZip', { count: included.length })}</Button>
    </div>}
    {!visible.length ? <Blank kind="review" title={t(items.length ? 'noMatches' : 'emptyArtifacts')} body="" /> : displayed.map(item => {
      const Icon = fileIcons[item.kind];
      const related = item.group ? items.filter(artifact => artifact.group === item.group) : [];
      return <div className="history-row artifact-row" key={item.id}>
        <Checkbox aria-label={t('selectWorkFile', { name: item.title, type: t(item.kind) })} checked={selected.has(item.id)}
          onChange={event => selectItems([item.id], event.target.checked)} />
        <span className={`file-kind ${item.kind}`}><Icon /></span>
        <div className="min-w-0"><h3>{item.title}</h3><p>{t(item.kind)} · {date.format(new Date(item.createdAt))}</p>
          {item.detail && <p className="artifact-description">{item.detail}</p>}
          {item.savedPath && <p className="artifact-description" title={item.savedPath}>{item.savedPath}</p>}</div>
        <div className="artifact-actions">
          <Button icon={<EyeOutlined />} onClick={() => preview(item.id)}>{t('filePreview')}</Button>
          <Button icon={<DownloadOutlined />} disabled={exporting} onClick={() => save(item)}>{t('saveAs')}</Button>
          <Dropdown trigger={['click']} menu={{ items: [
            ...(open ? [{ key: 'open', label: t('openCopy'), icon: <ExportOutlined /> }] : []),
            ...(related.length > 1 ? [{ key: 'group', label: t('artifactSelectGroup', { count: related.length }) }] : []),
            { key: 'rename', label: t('renameArtifact'), disabled: exporting },
            { key: 'remove', label: t('removeArtifact'), danger: true, disabled: exporting },
          ], onClick: ({ key }) => {
            if (key === 'open') open?.(item);
            if (key === 'group') selectItems(related.map(artifact => artifact.id), true);
            if (key === 'rename') setEditing({ id: item.id, title: item.title });
            if (key === 'remove') modal.confirm({ title: t('removeArtifact'), content: item.title, okText: t('artifactRemove'), cancelText: t('cancel'), onOk: () => remove(item.id) });
          } }}><Button type="text" icon={<MoreOutlined />} aria-label={t('artifactActions')} title={t('artifactActions')} /></Dropdown>
        </div>
      </div>;
    })}
    {visible.length > pageSize && <Pagination size="small" current={current} pageSize={pageSize} total={visible.length} onChange={setPage} showSizeChanger={false} />}
    <Modal title={t('renameArtifact')} open={Boolean(editing)} okText={t('save')} cancelText={t('cancel')}
      okButtonProps={{ disabled: !editing?.title.trim() }} onCancel={() => setEditing(undefined)} onOk={() => {
        if (editing?.title.trim()) rename(editing.id, editing.title.trim());
        setEditing(undefined);
      }}>
      <Input aria-label={t('contentTitle')} maxLength={100} value={editing?.title ?? ''} onChange={event => setEditing(current => current ? { ...current, title: event.target.value } : current)} />
    </Modal>
  </section>;
}
