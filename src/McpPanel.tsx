import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Popconfirm, Segmented, Select, Spin } from 'antd';
import { ApiOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { nativeDesktop } from './desktop';
import { listMcpServers, listMcpTools, mcpCall, removeMcpServer, saveMcpServer } from './mcp-client';
import type { McpServer, McpTool, McpToolResult } from './mcp-client';
import { mcpEn, mcpZh } from './mcp-i18n';
import './mcp-panel.css';

interface Editor { id: string; name: string; kind: McpServer['kind']; url: string; command: string; args: string }

function form(server?: McpServer): Editor {
  return { id: server?.id ?? '', name: server?.name ?? '', kind: server?.kind ?? 'http',
    url: server?.kind === 'http' ? server.url : '', command: server?.kind === 'stdio' ? server.command : '',
    args: server?.kind === 'stdio' ? server.args.join('\n') : '' };
}

function argumentsObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report invalid input in-place. */ }
  throw 'mcp_arguments';
}

export default function McpPanel() {
  const { i18n } = useTranslation();
  const copy = i18n.language === 'zh-CN' ? mcpZh : mcpEn;
  const [servers, setServers] = useState<McpServer[]>();
  const [selected, select] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [tools, setTools] = useState<McpTool[]>();
  const [toolName, setToolName] = useState<string>();
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<McpToolResult>();
  const [busy, setBusy] = useState<'discover' | 'run' | 'save' | 'remove'>();
  const [error, setError] = useState<string>();
  const server = servers?.find(item => item.id === selected) ?? servers?.[0];
  const tool = tools?.find(item => item.name === toolName);
  const errorText = error && (Object.hasOwn(copy, error) ? copy[error as keyof typeof copy] : copy.mcp_connection);

  useEffect(() => {
    let active = true;
    void listMcpServers().then(items => { if (active) setServers(items); }).catch(reason => {
      if (active) { setError(String(reason)); setServers([]); }
    });
    return () => { active = false; };
  }, []);

  function reset(id?: string) {
    select(id);
    setTools(undefined);
    setToolName(undefined);
    setArgs('{}');
    setResult(undefined);
    setError(undefined);
  }

  async function save() {
    if (!editor || busy) return;
    setBusy('save');
    setError(undefined);
    try {
      const identity = { id: editor.id, name: editor.name };
      const saved = await saveMcpServer(editor.kind === 'http' ? { ...identity, kind: 'http', url: editor.url } : {
        ...identity, kind: 'stdio', command: editor.command, args: editor.args.split(/\r?\n/).filter(Boolean),
      });
      setServers(items => editor.id ? items?.map(item => item.id === saved.id ? saved : item) : [...items ?? [], saved]);
      reset(saved.id);
      setEditor(undefined);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(undefined); }
  }

  async function remove() {
    if (!server || busy) return;
    setBusy('remove');
    try {
      await removeMcpServer(server.id);
      setServers(items => items?.filter(item => item.id !== server.id));
      reset();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(undefined); }
  }

  async function discover() {
    if (!server || busy) return;
    reset(server.id);
    setBusy('discover');
    try {
      const found = await listMcpTools(server.id);
      setTools(found);
      if (found.length === 1) setToolName(found[0]?.name);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(undefined); }
  }

  async function run() {
    if (!server || !tool || busy) return;
    setBusy('run');
    setResult(undefined);
    setError(undefined);
    try { setResult(await mcpCall(server.id, tool.name, argumentsObject(args))); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(undefined); }
  }

  return <div className="mcp-panel">
    <header className="page-heading"><div><h1>{copy.title}</h1><p>{copy.intro}</p></div>
      {nativeDesktop && <Button type="primary" icon={<PlusOutlined />} disabled={!!busy}
        onClick={() => { setError(undefined); setEditor(form()); }}>{copy.add}</Button>}
    </header>
    {!nativeDesktop ? <Alert type="info" title={copy.desktop} /> : !servers ? <Spin /> : <section className="panel mcp-settings">
      {errorText && !editor && <Alert type="error" showIcon title={errorText} />}
      {!server ? <p>{copy.empty}</p> : <>
        <div className="mcp-row">
          <Select aria-label={copy.name} value={server.id} disabled={!!busy} onChange={reset}
            options={servers.map(item => ({ label: item.name, value: item.id }))} />
          <Button disabled={!!busy} onClick={() => { setError(undefined); setEditor(form(server)); }}>{copy.edit}</Button>
          <Popconfirm title={copy.removeTitle} okText={copy.remove} cancelText={copy.cancel} onConfirm={remove}>
            <Button disabled={!!busy} danger>{copy.remove}</Button>
          </Popconfirm>
          <Button icon={<ApiOutlined />} disabled={!!busy} loading={busy === 'discover'} onClick={() => void discover()}>{copy.discover}</Button>
        </div>
        <small className="mcp-target">{server.kind === 'http' ? server.url : server.command}</small>
        {tools?.length === 0 && <p>{copy.discoverEmpty}</p>}
        {!!tools?.length && <Select aria-label={copy.selectTool} placeholder={copy.selectTool} value={toolName} disabled={!!busy}
          onChange={name => { setToolName(name); setArgs('{}'); setResult(undefined); setError(undefined); }}
          options={tools.map(item => ({ value: item.name, label: item.name }))} />}
        {tool && <div className="mcp-tool">
          {tool.description && <p>{tool.description}</p>}
          <details><summary>{copy.schema}</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
          <label htmlFor="mcp-tool-args">{copy.json}</label>
          <Input.TextArea id="mcp-tool-args" value={args} rows={5} maxLength={120000} disabled={!!busy} onChange={event => setArgs(event.target.value)} />
          {server.kind === 'http' && <small>{copy.userInput}</small>}
          <Button type="primary" disabled={!!busy} loading={busy === 'run'} onClick={() => void run()}>{copy.run}</Button>
        </div>}
        {result && <section className="mcp-result">
          <h2>{copy.output}</h2>
          {result.isError && <Alert type="warning" showIcon title={copy.toolError} />}
          <pre>{JSON.stringify(result.structuredContent ?? result.content ?? result, null, 2)}</pre>
        </section>}
      </>}
    </section>}
    <Modal open={!!editor} title={editor?.id ? copy.edit : copy.add} okText={copy.save} cancelText={copy.cancel} onCancel={() => { if (!busy) setEditor(undefined); }}
      onOk={() => void save()} confirmLoading={busy === 'save'} okButtonProps={{ disabled: !editor?.name.trim() || !(editor.kind === 'http' ? editor.url : editor.command).trim() }}>
      {editor && <div className="mcp-editor">
        {errorText && <Alert type="error" showIcon title={errorText} />}
        <label htmlFor="mcp-name">{copy.name}</label>
        <Input id="mcp-name" value={editor.name} maxLength={100} onChange={event => setEditor({ ...editor, name: event.target.value })} />
        <span>{copy.transport}</span>
        <Segmented<McpServer['kind']> value={editor.kind} options={[{ value: 'http', label: copy.http }, { value: 'stdio', label: copy.stdio }]}
          onChange={kind => setEditor({ ...editor, kind })} />
        {editor.kind === 'http' ? <><label htmlFor="mcp-url">{copy.url}</label>
          <Input id="mcp-url" value={editor.url} maxLength={2048} onChange={event => setEditor({ ...editor, url: event.target.value })} /></> : <>
          <label htmlFor="mcp-command">{copy.command}</label>
          <Input id="mcp-command" value={editor.command} maxLength={2048} onChange={event => setEditor({ ...editor, command: event.target.value })} />
          <label htmlFor="mcp-command-args">{copy.arguments}</label>
          <Input.TextArea id="mcp-command-args" value={editor.args} rows={3} maxLength={12000}
            onChange={event => setEditor({ ...editor, args: event.target.value })} />
        </>}
      </div>}
    </Modal>
  </div>;
}
