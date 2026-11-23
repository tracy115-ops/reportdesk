import { CloseOutlined, EyeOutlined, FolderOpenOutlined, PaperClipOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Checkbox, Drawer, Dropdown, Flex, Input, Pagination, Select, Spin, Tooltip } from 'antd';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { evidenceSignature, materialKinds } from './domain';
import type { Evidence, Loaded, MaterialKind } from './domain';
import { fileIcons } from './OfficeTools';

interface Props {
  files: Loaded[];
  attachments: string[];
  pinned: Evidence[];
  locked: boolean;
  loading: boolean;
  change: (ids: string[]) => void;
  pick: (folder: boolean) => void;
  preview: (id: string) => void;
  show: (excerpt: Evidence) => void;
  removeExcerpt: (index: number) => void;
  review?: () => void;
  reviewContext?: boolean;
  retrievalActive?: boolean;
  compact?: boolean;
  controls?: ReactNode;
  scope?: { name: string; openInitially: boolean };
}

export const maximumAttachments = 12;

export default function AssistantMaterials({ files, attachments, pinned, locked, loading, change, pick, preview, show, removeExcerpt, review, reviewContext, retrievalActive, compact = false, controls, scope }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const [open, setOpen] = useState(scope?.openInitially ?? false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MaterialKind | 'all'>('all');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const term = useDeferredValue(query.trim().normalize('NFKC').toLowerCase());
  const readable = useMemo(() => files.filter(item => item.parsed), [files]);
  const byId = useMemo(() => new Map(readable.map(item => [item.material.id, item.material])), [readable]);
  const selected = useMemo(() => new Set(attachments), [attachments]);
  const formats = useMemo(() => {
    const kinds = new Set(readable.map(({ material }) => material.kind));
    return materialKinds.filter(value => kinds.has(value));
  }, [readable]);
  const matches = useMemo(() => readable.filter(({ material }) => {
    if (kind !== 'all' && material.kind !== kind) return false;
    if (selectedOnly && !selected.has(material.id)) return false;
    return material.path.normalize('NFKC').toLowerCase().includes(term);
  }), [readable, kind, selectedOnly, selected, term]);
  const missing = attachments.filter(id => !byId.has(id));
  const pageSize = 18;
  const current = Math.min(page, Math.max(1, Math.ceil(matches.length / pageSize)));

  function toggle(id: string, checked: boolean) {
    if (checked && !selected.has(id) && selected.size < maximumAttachments) change([...attachments, id]);
    if (!checked) change(attachments.filter(item => item !== id));
  }

  function openLibrary() {
    setQuery('');
    setKind('all');
    setSelectedOnly(false);
    setPage(1);
    setOpen(true);
  }

  return <section className={'assistant-materials' + (compact ? ' is-composer' : '')} aria-labelledby={labelId}>
    <div className="assistant-material-actions">
      {retrievalActive ? null : scope ? <Button id={labelId} className="assistant-attach" type="text" icon={<PaperClipOutlined />} disabled={locked || loading || !readable.length} onClick={openLibrary}>
        {t('assistantDatasetChoose')}
      </Button> : <Dropdown trigger={['click']} menu={{
        items: [
          { key: 'files', icon: <PlusOutlined />, label: t('addFiles') },
          { key: 'folder', icon: <FolderOpenOutlined />, label: t('addFolder') },
          { key: 'library', icon: <PaperClipOutlined />, label: t('pickAvailable'), disabled: !readable.length },
        ],
        onClick: ({ key }) => { if (key === 'library') openLibrary(); else pick(key === 'folder'); },
      }}><Tooltip title={t('assistantAttach')}><Button id={labelId} className="assistant-attach" type={compact ? 'text' : 'default'} size={compact ? 'middle' : 'small'} aria-label={t('assistantAttach')} icon={<PaperClipOutlined />} disabled={locked || loading}>{t('assistantAttach')}</Button></Tooltip></Dropdown>}
      {!compact && attachments.length + pinned.length > 0 && <small>{t('assistantAttachmentCount', { files: attachments.length, excerpts: pinned.length })}</small>}
      {review && (attachments.length > 0 || pinned.length > 0 || reviewContext || retrievalActive) && <Button type="link" size="small" className="attachment-preview-link" id={retrievalActive ? labelId : undefined} aria-label={t('previewAssistantInput')}
        disabled={locked || missing.length > 0 || loading} onClick={review}>{t(compact ? reviewContext ? 'assistantReviewContext' : 'composerReviewSources' : 'previewAssistantInput')}</Button>}
      {controls}
    </div>
    {loading && <div className="assistant-restore-note" role="status"><Spin size="small" /> {t('loadingMaterials')}</div>}
    {(attachments.length > missing.length || pinned.length > 0) && <ul className="assistant-attachment-list">
      {attachments.flatMap(id => {
        const material = byId.get(id);
        if (!material) return [];
        const Icon = fileIcons[material.kind];
        return <li key={id}>
          <button type="button" className="assistant-attachment-name" title={material.path} onClick={() => preview(id)}>
            <Icon /><span>{material.relative}</span>
          </button>
          <Button type="text" size="small" icon={<CloseOutlined />} aria-label={t('assistantRemoveFile', { name: material.relative })}
            disabled={locked} onClick={() => toggle(id, false)} />
        </li>;
      })}
      {pinned.map((item, index) => <li key={evidenceSignature(item)}>
        <button type="button" className="assistant-attachment-name" title={item.text} onClick={() => show(item)}>
          <PaperClipOutlined /><span>{item.locations[0]?.file} · {item.locations[0]?.at}<small>{item.text}</small></span>
        </button>
        <Button type="text" size="small" icon={<CloseOutlined />} aria-label={t('removeExcerpt')} disabled={locked} onClick={() => removeExcerpt(index)} />
      </li>)}
    </ul>}
    {missing.length > 0 && !loading && <div className="assistant-restore-note">
      <span className="muted">{t('missingAttachments', { count: missing.length })}</span>
      <Button type="link" size="small" disabled={locked} onClick={() => change(attachments.filter(id => byId.has(id)))}>{t('removeMissing')}</Button>
    </div>}
    <Drawer open={open && !retrievalActive} title={scope ? scope.name : t('attach')} size="min(580px, 96vw)" onClose={() => setOpen(false)}
      footer={<div className="assistant-material-footer">
        <span aria-live="polite">{t('assistantSelectedFiles', { count: selected.size, max: maximumAttachments })}</span>
        <Flex wrap gap={6} align="center">
          <Button type="text" disabled={!selected.size || locked || loading} onClick={() => change([])}>{t('clearSelection')}</Button>
          <Button type="primary" onClick={() => setOpen(false)}>{t('doneSelecting')}</Button>
        </Flex>
      </div>}>
      {scope && readable.length > maximumAttachments && <p className="assistant-picker-scope-note">{t('assistantDatasetChooseHint')}</p>}
      <Flex className="assistant-picker-filters" gap={8} wrap>
        <Input prefix={<SearchOutlined />} allowClear aria-label={t('searchFiles')}
          placeholder={t('searchFileNames')} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        <Select<MaterialKind | 'all'> aria-label={t('formatFilter')} value={kind}
          onChange={value => { setKind(value); setPage(1); }}
          options={[{ value: 'all', label: t('allFormats') }, ...formats.map(value => ({ value, label: t(value) }))]} />
      </Flex>
      <Flex className="assistant-picker-summary" align="center" justify="space-between" gap={8} wrap>
        <Checkbox checked={selectedOnly} onChange={event => { setSelectedOnly(event.target.checked); setPage(1); }}>{t('assistantSelectedOnly')}</Checkbox>
        <small className="muted" aria-live="polite">{t(term ? 'matchingNames' : 'filesFound', { count: matches.length })}</small>
      </Flex>
      {matches.length ? <ul className="assistant-picker-list">{matches.slice((current - 1) * pageSize, current * pageSize).map(({ material }) => {
        const checked = selected.has(material.id);
        const Icon = fileIcons[material.kind];
        return <li key={material.id}>
          <Checkbox checked={checked} disabled={locked || loading || (!checked && selected.size >= maximumAttachments)}
            onChange={event => toggle(material.id, event.target.checked)}>
            <span className="assistant-picker-name" title={material.path}><Icon /> {material.relative}</span>
          </Checkbox>
          <Button type="text" size="small" icon={<EyeOutlined />} aria-label={t('filePreview')} title={t('filePreview')}
            onClick={() => { setOpen(false); preview(material.id); }} />
        </li>;
      })}</ul> : <p className="muted">{t(selectedOnly && selected.size === 0 ? 'assistantNoSelectedFiles' : 'noMatches')}</p>}
      {matches.length > pageSize && <Pagination size="small" current={current} pageSize={pageSize} total={matches.length} onChange={setPage} showSizeChanger={false} />}
    </Drawer>
  </section>;
}
