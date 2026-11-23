import { AudioOutlined, DeleteOutlined, EditOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Input, Modal, Popconfirm, Segmented, Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, nativeDesktop } from './desktop';
import type { NewArtifact } from './office';
import { configuredModels, discoverProviderModels, providerApiAddress, providerMedia, removeProvider, saveProvider, startVideo, testProvider, videoStatus } from './provider-client';
import type { MediaKind, ProviderProfile } from './provider-client';
import { readLocal, writeLocal } from './storage';
import './extension-workbench.css';

interface VideoJob { providerId: string; id: string; title: string; status: string; progress?: number; saved?: boolean }
interface Props {
  profiles: ProviderProfile[];
  changed: () => Promise<void>;
  deliver: (files: NewArtifact[], group?: string) => Promise<unknown>;
  openArtifacts: () => void;
  media?: boolean;
}

const extraModels = ['embeddingModel', 'imageModel', 'ttsModel', 'videoModel'] as const;
const officialUrls = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' } as const;
const newProfile = (): ProviderProfile => ({
  id: crypto.randomUUID(), name: '', kind: 'openai', baseUrl: officialUrls.openai,
});
const pending = (status: string) => !['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'expired'].includes(status);

export default function ModelWorkbench({ profiles, changed, deliver, openArtifacts, media }: Props) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language === 'zh-CN';
  const { message } = AntApp.useApp();
  const [editor, setEditor] = useState<ProviderProfile>();
  const [key, setKey] = useState('');
  const [catalog, setCatalog] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const catalogRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [kind, setKind] = useState<MediaKind>('png');
  const [provider, setProvider] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [reference, setReference] = useState<File>();
  const [jobs, setJobs] = useState<VideoJob[]>(() => readLocal('media-jobs', []));
  const saving = useRef(new Set<string>());
  const deliverCurrent = useRef(deliver);
  useEffect(() => { deliverCurrent.current = deliver; }, [deliver]);
  const fieldNames = zh ? ['向量模型', '图像模型', '语音模型', '视频模型'] :
    ['Embedding model', 'Image model', 'Speech model', 'Video model'];
  const apiAddress = editor && providerApiAddress(editor, profiles.find(item => item.id === editor.id));
  const selectedModels = editor ? configuredModels(editor) : [];
  const catalogOptions = [...new Set([...catalog, ...selectedModels])].map(value => ({ value, label: value }));
  const modelField = ({ png: 'imageModel', mp3: 'ttsModel', mp4: 'videoModel' } as const)[kind];
  const capable = profiles.filter(item => item.kind === 'openai' && item[modelField]);
  const selected = capable.find(item => item.id === provider) ?? capable[0];
  const reportError = (error: unknown) => setProblem(t(errorCode(error, 'provider_failed'), { defaultValue: t('provider_failed') }));

  useEffect(() => { try { writeLocal('media-jobs', jobs); } catch { /* current session state remains available */ } }, [jobs]);
  useEffect(() => {
    if (!media || !nativeDesktop || !jobs.some(job => pending(job.status))) return;
    let stopped = false;
    let timer = 0;
    let latest = jobs;
    async function refresh() {
      const updates = await Promise.all(latest.map(async job => {
        if (!pending(job.status)) return job;
        try { return { ...job, ...await videoStatus(job.providerId, job.id) }; }
        catch { return job; }
      }));
      if (stopped) return;
      if (updates.some((job, index) => job.status !== latest[index]?.status || job.progress !== latest[index]?.progress)) {
        setJobs(current => current.map(job => updates.find(item => item.id === job.id && item.providerId === job.providerId) ?? job));
      }
      latest = updates;
      if (updates.some(job => pending(job.status))) timer = window.setTimeout(refresh, 3400);
    }
    timer = window.setTimeout(refresh, 3400);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [jobs, media]);

  async function saveVideo(job: VideoJob) {
    const id = job.providerId + '-' + job.id;
    if (saving.current.has(id) || job.saved) return;
    saving.current.add(id);
    try {
      const file = await providerMedia(job.providerId, 'mp4', job.id);
      await deliverCurrent.current([{ title: job.title, kind: 'mp4', file, detail: zh ? '视频生成' : 'Generated video' }], 'video-' + id);
      setJobs(current => current.map(item => item.id === job.id && item.providerId === job.providerId ? { ...item, saved: true } : item));
    } finally { saving.current.delete(id); }
  }

  useEffect(() => {
    if (!media || !nativeDesktop) return;
    for (const job of jobs) if (!job.saved && ['completed', 'succeeded'].includes(job.status)) {
      void saveVideo(job).catch(() => undefined);
    }
  }, [jobs, media]);

  async function operation(task: () => Promise<void>) {
    setBusy(true);
    setProblem('');
    try { await task(); } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  function clearCatalog() {
    catalogRequest.current++;
    setCatalog([]);
    setFetchingModels(false);
    setProblem('');
  }

  function edit(profile?: ProviderProfile) {
    clearCatalog();
    setKey('');
    setEditor(profile);
  }

  async function pullModels() {
    if (!editor?.baseUrl.trim()) return;
    const request = ++catalogRequest.current;
    setFetchingModels(true);
    setProblem('');
    try {
      const profile = apiAddress ? { ...editor, baseUrl: apiAddress.baseUrl } : editor;
      const ids = await discoverProviderModels(profile, key.trim() ? key : undefined);
      if (catalogRequest.current !== request) return;
      setCatalog(ids);
      if (!ids.length) message.info(t('providerCatalogEmpty'));
    } catch (error) {
      if (catalogRequest.current === request) reportError(error);
    } finally {
      if (catalogRequest.current === request) setFetchingModels(false);
    }
  }

  function store() {
    if (!editor?.name.trim() || !editor.baseUrl.trim()) return;
    void operation(async () => {
      const profile = { ...editor, name: editor.name.trim(), baseUrl: apiAddress?.baseUrl ?? editor.baseUrl.trim() };
      for (const field of extraModels) {
        profile[field] = profile.kind === 'anthropic' ? undefined : profile[field]?.trim() || undefined;
      }
      await saveProvider(profile, key.trim() ? key : undefined);
      edit();
      await changed();
    });
  }

  function generate() {
    if (!selected || !prompt.trim()) return;
    void operation(async () => {
      const text = prompt.trim();
      const title = text.slice(0, 64);
      if (kind === 'mp4') {
        let image: { mime: string; data: string } | undefined;
        if (reference) {
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(reference.type) || reference.size > 8 * 1024 * 1024) throw 'provider_reference';
          const bytes = new Uint8Array(await reference.arrayBuffer());
          const chunks: string[] = [];
          for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
          image = { mime: reference.type, data: btoa(chunks.join('')) };
        }
        const job = await startVideo(selected.id, text, image ? undefined : '720x1280', 4, image);
        setJobs(current => [{ ...job, providerId: selected.id, title }, ...current]);
      } else {
        const file = await providerMedia(selected.id, kind, text, kind === 'mp3' ? voice : undefined);
        await deliver([{ title, kind, file, detail: selected.name }]);
        message.success(zh ? '已保存到工作成果' : 'Saved to work files');
      }
    });
  }

  return <div className="extension-workbench">
    <div className="page-heading"><div><h1>{t(media ? 'media' : 'models')}</h1><p>{media
      ? zh ? '生成图像、配音和短视频，结果统一保存在工作成果。' : 'Generate images, speech, and short videos in your work files.'
      : zh ? '接入自有模型端点，为对话、知识检索和多媒体选择相应模型。' : 'Connect your own model endpoint for drafting, retrieval, and media generation.'}</p></div>
      {media ? <Button onClick={openArtifacts}>{t('artifacts')}</Button> :
        <Button type="primary" icon={<PlusOutlined />} disabled={!nativeDesktop || busy} onClick={() => edit(newProfile())}>{zh ? '添加供应商' : 'Add provider'}</Button>}
    </div>
    {!nativeDesktop && <Alert showIcon type="info" title={zh ? '在桌面版连接模型' : 'Connect model providers in the desktop app'} />}
    {problem && !editor && <Alert className="extension-alert" type="error" showIcon title={problem} />}
    {media ? <>
      <section className="panel extension-panel">
        <Segmented<MediaKind> value={kind} onChange={setKind} disabled={busy} options={[
          { value: 'png', icon: <PictureOutlined />, label: zh ? '图像' : 'Image' },
          { value: 'mp3', icon: <AudioOutlined />, label: zh ? '配音' : 'Speech' },
          { value: 'mp4', icon: <VideoCameraOutlined />, label: zh ? '视频' : 'Video' },
        ]} />
        <label>{zh ? '模型供应商' : 'Provider'}<Select value={selected?.id} disabled={busy || !capable.length} onChange={setProvider}
          placeholder={zh ? '请先在模型广场配置对应模型' : 'Add a matching model in Model providers'}
          options={capable.map(item => ({ value: item.id, label: [item.name, item[modelField]].join(' · ') }))} /></label>
        <label>{kind === 'mp3' ? zh ? '朗读文字' : 'Text to speak' : zh ? '生成描述' : 'Prompt'}
          <Input.TextArea rows={4} value={prompt} maxLength={5000} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>
        {kind === 'mp3' && <label>{zh ? '语音名' : 'Voice'}<Input value={voice} maxLength={80} onChange={event => setVoice(event.target.value)} /></label>}
        {kind === 'mp4' && <label>{zh ? '参考图片（可选）' : 'Reference image (optional)'}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setReference(event.target.files?.[0])} /></label>}
        <div><Button type="primary" loading={busy} disabled={!selected || !prompt.trim()} onClick={generate}>{zh ? '生成' : 'Generate'}</Button></div>
      </section>
      {!!jobs.length && <section className="panel extension-panel"><h2>{zh ? '视频任务' : 'Video jobs'}</h2>
        {jobs.map(job => <div className="extension-item" key={job.providerId + job.id}><div><strong>{job.title}</strong><small>
          {({
            queued: zh ? '排队' : 'Queued', in_progress: zh ? '生成中' : 'Generating', completed: zh ? '已完成' : 'Completed',
            succeeded: zh ? '已完成' : 'Completed', failed: zh ? '生成失败' : 'Failed',
          } as Record<string, string>)[job.status] ?? job.status}{job.progress === undefined ? '' : ` · ${job.progress}%`}</small></div>
          {job.saved ? <Button onClick={openArtifacts}>{zh ? '查看成果' : 'View work files'}</Button>
            : <Button disabled={busy || !['completed', 'succeeded'].includes(job.status)} onClick={() => void operation(() => saveVideo(job))}>
              {zh ? '保存成果' : 'Save video'}</Button>}
          <Button type="text" aria-label={zh ? '移除任务' : 'Remove job'} icon={<DeleteOutlined />} onClick={() => setJobs(current => current.filter(item =>
            item.id !== job.id || item.providerId !== job.providerId))} />
        </div>)}</section>}
    </> : <section className="panel extension-panel">
      {!profiles.length && <p className="muted">{zh ? '添加你的首个模型端点。API Key 由 Windows 加密保存在本机。' : 'Add your first model endpoint. Windows encrypts the API key on this device.'}</p>}
      {profiles.map(item => <div className="extension-item" key={item.id}><div><strong>{item.name}</strong><small>{item.baseUrl} · {item.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'}</small>
        <small>{[item.textModel && t('providerTextSummary', { count: configuredModels(item).length, model: item.textModel }),
          ...extraModels.flatMap((field, index) => item[field] ? [fieldNames[index] + ' · ' + item[field]] : [])].filter(Boolean).join(' / ')}</small></div>
        <Button disabled={busy} onClick={() => void operation(async () => { await testProvider(item.id, item.textModel); message.success(zh ? '连接成功' : 'Connection successful'); })}>{zh ? '测试连接' : 'Test'}</Button>
        <Button icon={<EditOutlined />} disabled={busy} onClick={() => edit({ ...item })}>{zh ? '编辑' : 'Edit'}</Button>
        <Popconfirm title={zh ? '移除此供应商与本地密钥？' : 'Remove this provider and its local key?'} onConfirm={() =>
          operation(async () => { await removeProvider(item.id); await changed(); })}>
          <Button disabled={busy} type="text" danger aria-label={zh ? '移除供应商' : 'Remove provider'} icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>)}
    </section>}
    <Modal open={Boolean(editor)} title={zh ? '模型供应商' : 'Model provider'} okText={zh ? '保存' : 'Save'} centered width={600}
      styles={{ body: { maxHeight: 'calc(100dvh - 160px)', overflowY: 'auto' } }}
      onCancel={() => { if (!busy) edit(); }} onOk={store} confirmLoading={busy} okButtonProps={{ disabled: !editor?.name.trim() || !editor.baseUrl.trim() }}>
      {editor && <div className="extension-form">
        {problem && <Alert type="error" showIcon title={problem} />}
        <label>{zh ? '名称' : 'Name'}<Input value={editor.name} maxLength={80} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>{zh ? '接口协议' : 'API protocol'}<Select<ProviderProfile['kind']> value={editor.kind} options={[{ value: 'openai', label: zh ? 'OpenAI 兼容' : 'OpenAI compatible' }, { value: 'anthropic', label: 'Anthropic Messages' }]}
          onChange={value => {
            clearCatalog();
            const baseUrl = editor.baseUrl === officialUrls[editor.kind] ? officialUrls[value] : editor.baseUrl;
            setEditor({ ...editor, kind: value, baseUrl });
          }} /></label>
        <label>API URL<Input value={editor.baseUrl} onChange={event => { clearCatalog(); setEditor({ ...editor, baseUrl: event.target.value }); }} />
          <small className="muted">{t('providerApiUrlHint')}</small>
          {apiAddress && <small className="muted provider-request-url">{t('providerChatUrl')} <code>{apiAddress.chatUrl}</code></small>}</label>
        <label>API Key<Input.Password autoComplete="new-password" value={key} placeholder={editor.hasKey ? zh ? '留空保留现有密钥' : 'Leave empty to keep the current key' : ''}
          onChange={event => { clearCatalog(); setKey(event.target.value); }} />
          {apiAddress?.http && <small className="muted">{t('providerPlainHttp')}</small>}</label>
        <div className="provider-models-field">
          <div className="provider-models-heading">
            <label htmlFor="provider-chat-models">{t('providerChatModels')}</label>
            {catalog.length > 0 && <small className="muted" role="status">{t('providerCatalogCount', { count: catalog.length })}</small>}
            <Button size="small" icon={<ReloadOutlined />} loading={fetchingModels} disabled={busy || !editor.baseUrl.trim()}
              onClick={() => void pullModels()}>{t('providerPullModels')}</Button>
          </div>
          <Select<string[]> id="provider-chat-models" aria-label={t('providerChatModels')} mode="tags" value={selectedModels} options={catalogOptions}
            placeholder={t('providerModelPlaceholder')} maxTagCount={4} onChange={values => {
              const ids = [...new Set(values.map(id => id.trim()).filter(Boolean))];
              const textModel = editor.textModel && ids.includes(editor.textModel) ? editor.textModel : ids[0];
              setEditor({ ...editor, textModel, textModels: ids });
            }} />
          {selectedModels.length > 1 && <label>{t('providerDefaultModel')}
            <Select value={editor.textModel ?? selectedModels[0]} options={selectedModels.map(value => ({ value, label: value }))}
              onChange={textModel => setEditor({ ...editor, textModel })} />
          </label>}
        </div>
        {editor.kind === 'openai' && extraModels.map((field, index) => <label key={field}>{fieldNames[index]}
          <Input value={editor[field] ?? ''} maxLength={160} placeholder={zh ? '供应商提供的模型 ID' : 'Model ID from the provider'}
            onChange={event => setEditor({ ...editor, [field]: event.target.value })} /></label>)}
      </div>}
    </Modal>
  </div>;
}
