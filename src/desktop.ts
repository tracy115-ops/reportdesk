import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { materialKinds } from './domain';
import type { Issue, Loaded, Material, MaterialKind, Narrative, Parsed, Report, Source } from './domain';
import type { OfficeDraft } from './office';
import { providerChat, providerDraft, providerReport, providerTarget } from './provider-client';
import type { ProviderEngine } from './provider-client';

export const nativeDesktop = isTauri();
export const FILE_LIMIT = 32 * 1024 * 1024;
export const ZIP_LIMIT = 128 * 1024 * 1024;
export const BACKUP_EXTENSION = '.officebackup';
const SCAN_LIMIT = 500;
const inputs = new Map<string, File[]>();
const example: Source = { id: 'sample', name: 'Atlas Delivery', path: 'Atlas Delivery', directory: true, sample: true };
const exampleFiles = import.meta.glob('./sample/*.{docx,xlsx}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function demoSource() { return example; }
export function listSources() { return nativeDesktop ? invoke<Source[]>('list_sources') : Promise.resolve([]); }
export interface SourceSelection { sources: Source[]; selectedIds: string[]; added: number; skipped: number }
export function pickSources(directory: boolean) { return invoke<SourceSelection>('pick_sources', { directory }); }
export function relinkSource(id: string) { return invoke<Source[] | null>('relink_source', { id }); }
export function replaceWorkspaceSources(sources: Source[]) {
  return nativeDesktop ? invoke<void>('replace_workspace_sources', { sources }) : Promise.resolve();
}
export function setWorkspaceRestore(active: boolean) {
  return nativeDesktop ? invoke<void>('set_workspace_restore', { active }) : Promise.resolve();
}
export async function pickWorkspaceBackup() {
  const bytes = await invoke<ArrayBuffer>('pick_workspace_backup');
  return bytes.byteLength ? bytes : undefined;
}

function supported(name: string) { return materialKinds.includes(name.split('.').at(-1)?.toLowerCase() as MaterialKind) && !name.startsWith('~$') && !name.startsWith('.'); }

export function addBrowserFiles(files: File[], directory: boolean): Source[] {
  const supportedFiles = files.filter(file => supported(file.name));
  if (!supportedFiles.length) return [];
  const id = crypto.randomUUID();
  if (directory) {
    const name = supportedFiles[0]?.webkitRelativePath.split('/')[0] || 'Folder';
    inputs.set(id, supportedFiles);
    return [{ id, path: name, name, directory }];
  }
  return supportedFiles.map((file, index) => {
    const sourceId = `${id}-${index}`;
    inputs.set(sourceId, [file]);
    return { id: sourceId, path: file.name, name: file.name, directory: false };
  });
}

export async function removeSource(source: Source) {
  if (source.sample) return;
  if (nativeDesktop) await invoke('remove_source', { id: source.id });
  else inputs.delete(source.id);
}

interface FileEntry { relative: string; size: number; modified?: string | null }
interface ScanResult { files: FileEntry[]; skipped: number; limited: boolean }

async function enumerate(source: Source): Promise<ScanResult> {
  if (source.sample) return { files: Object.keys(exampleFiles).sort().map(path => ({ relative: path.split('/').at(-1)!, size: 0 })), skipped: 0, limited: false };
  if (nativeDesktop) return invoke<ScanResult>('scan_source', { id: source.id });
  const files = (inputs.get(source.id) ?? []).map(file => ({ relative: file.webkitRelativePath.split('/').slice(1).join('/') || file.name, size: file.size, modified: String(file.lastModified) }));
  return { files: files.slice(0, 300), skipped: 0, limited: files.length > 300 };
}

export async function readMaterial(source: Source, material: Material): Promise<ArrayBuffer> {
  if (source.sample) {
    const url = exampleFiles[`./sample/${material.relative}`];
    if (!url) throw 'file_access';
    const response = await fetch(url);
    if (!response.ok) throw 'file_access';
    return response.arrayBuffer();
  }
  if (nativeDesktop) return invoke<ArrayBuffer>('read_material', { id: source.id, relative: material.relative });
  const file = (inputs.get(source.id) ?? []).find(item => (item.webkitRelativePath.split('/').slice(1).join('/') || item.name) === material.relative);
  if (!file) throw 'source_unavailable';
  return file.arrayBuffer();
}

export function openMaterial(material: Material) { return invoke<void>('open_material', { id: material.sourceId, relative: material.relative }); }

export function errorCode(error: unknown, fallback = 'file_access') {
  const value = error instanceof Error ? error.message : error;
  return typeof value === 'string' && /^[a-z_]+$/.test(value) ? value : fallback;
}

function bounded<T>(job: Promise<T>, code: string, signal?: AbortSignal, ms = 25_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(signal?.reason ?? 'scan_cancelled'); };
    const timer = window.setTimeout(() => { finish(); reject(code); }, ms);
    job.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function officeParser() {
  let worker: Worker | undefined;
  const stop = () => { worker?.terminate(); worker = undefined; };
  async function parse(bytes: ArrayBuffer, kind: MaterialKind, signal?: AbortSignal): Promise<{ parsed: Parsed; version: string }> {
    signal?.throwIfAborted();
    if (bytes.byteLength > FILE_LIMIT) throw 'file_too_large';
    if (kind === 'pdf') {
      const { readPdf } = await import('./pdf-reader');
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const version = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      return { parsed: await readPdf(bytes, signal), version };
    }
    worker ??= new Worker(new URL('./office.worker.ts', import.meta.url), { type: 'module' });
    const parser = worker;
    try {
      return await bounded(new Promise((resolve, reject) => {
        parser.onmessage = ({ data }: MessageEvent) => data.error ? reject(data.error) : resolve({ parsed: data.parsed, version: data.version });
        parser.onerror = () => reject('file_parse');
        parser.postMessage({ id: 0, bytes, kind }, [bytes]);
      }), 'file_parse_timeout', signal, 30_000);
    } catch (error) { stop(); throw error; }
  }
  return { parse, stop };
}

export async function parseArtifactWithVersion(file: Blob, kind: MaterialKind, signal?: AbortSignal) {
  const parser = officeParser();
  try { return await parser.parse(await file.arrayBuffer(), kind, signal); }
  finally { parser.stop(); }
}

export async function parseArtifact(file: Blob, kind: MaterialKind, signal?: AbortSignal) {
  return (await parseArtifactWithVersion(file, kind, signal)).parsed;
}

export async function loadMaterials(sources: Source[], progress: (count: number) => void, signal: AbortSignal, previous: Loaded[] = []) {
  const loaded: Loaded[] = [];
  const issues: Issue[] = [];
  const paths = new Map<string, Loaded>();
  const cached = new Map(previous.map(file => [file.material.id, file]));
  const parser = officeParser();
  try {
    for (const source of sources) {
      signal.throwIfAborted();
      let scan: ScanResult;
      try { scan = await bounded(enumerate(source), 'source_timeout', signal); }
      catch (error) { signal.throwIfAborted(); issues.push({ code: errorCode(error), detail: source.name, sourceId: source.id }); continue; }
      if (scan.skipped) issues.push({ code: 'folder_skipped', detail: source.name + ' · ' + scan.skipped, sourceId: source.id });
      if (scan.limited) issues.push({ code: 'folder_limit', detail: source.name, sourceId: source.id });
      if (!scan.files.length) { issues.push({ code: 'no_files', detail: source.name, sourceId: source.id }); continue; }
      for (const file of scan.files) {
        signal.throwIfAborted();
        const path = source.directory ? `${source.path}${source.path.endsWith('\\') ? '' : '/'}${file.relative}` : source.path;
        const key = nativeDesktop && !source.sample ? path.replaceAll('\\', '/').toLowerCase() : `${source.id}/${file.relative}`;
        const duplicate = paths.get(key);
        if (duplicate) {
          if (duplicate.material.sourceId !== source.id) (duplicate.sourceAliases ??= []).push(source.id);
          continue;
        }
        if (loaded.length >= SCAN_LIMIT) {
          if (!issues.some(issue => issue.code === 'workspace_limit' && issue.sourceId === source.id)) {
            issues.push({ code: 'workspace_limit', detail: source.name, sourceId: source.id });
          }
          continue;
        }
        const kind = file.relative.split('.').at(-1)!.toLowerCase() as MaterialKind;
        const identity = !source.directory && source.originalName ? source.originalName : file.relative;
        const material: Material = { ...file, path, kind, sourceId: source.id, id: `${source.id}/${identity}` };
        try {
          const existing = cached.get(material.id);
          if (existing?.parsed && file.modified && file.modified === existing.material.modified && file.size === existing.material.size) {
            loaded.push({ parsed: existing.parsed, version: existing.version, material });
          } else {
            if (file.size > FILE_LIMIT) throw 'file_too_large';
            const bytes = await bounded(readMaterial(source, material), 'source_timeout', signal);
            loaded.push({ material, ...await parser.parse(bytes, kind, signal) });
          }
        } catch (error) {
          signal.throwIfAborted();
          loaded.push({ material, error: errorCode(error, 'file_parse') });
        }
        paths.set(key, loaded[loaded.length - 1]!);
        progress(loaded.length);
      }
    }
  } finally {
    parser.stop();
  }
  return { loaded, issues };
}

export type NativeAgent = 'codex' | 'claude';
export type AgentEngine = NativeAgent | ProviderEngine;
export type AgentOptionGroup = { label: string; options: { value: AgentEngine; label: string }[] };
export interface AgentFolder { id: string; path: string }
export interface AgentWorkspaceChanges {
  folderId: string;
  files: { path: string; change: 'created' | 'modified' }[];
  limited: boolean;
}
export interface AgentReply { text?: string; deniedTools?: number; changes?: AgentWorkspaceChanges; error?: string }
export type AgentEvent =
  | { kind: 'connection'; retrying: boolean }
  | { kind: 'text'; text: string; replace: boolean }
  | { kind: 'tool'; id: string; action: 'command' | 'read' | 'write' | 'search' | 'mcp' | 'tool'; target: string; state: 'running' | 'done' | 'failed' }
  | { kind: 'finished'; id: string; failed: boolean };
export interface AgentCliDetails {
  status: string;
  path?: string;
  version?: string;
  stage: 'install' | 'version' | 'login' | 'ready';
}
export function agentCliDetails(engine: 'codex' | 'claude') {
  return invoke<AgentCliDetails>('agent_cli_details', { engine });
}
export async function codexStatus(engine: NativeAgent = 'codex') {
  if (!nativeDesktop) return 'codexBrowser';
  return invoke<string>('codex_status', { engine });
}
export function polishReport(payload: string, locale: Report['settings']['locale'], engine: AgentEngine = 'codex') {
  if (engine !== 'codex' && engine !== 'claude') return providerReport(providerTarget(engine), payload, locale);
  return invoke<Narrative>('polish_report', { payload, locale, engine });
}
export function runOffice(payload: string, locale: Report['settings']['locale'], engine: AgentEngine = 'codex') {
  if (engine !== 'codex' && engine !== 'claude') return providerDraft(providerTarget(engine), payload, locale);
  return invoke<OfficeDraft>('office_assist', { payload, locale, engine });
}
export function chatWithAgent(payload: string, engine: AgentEngine, folder?: AgentFolder, onProgress?: (events: AgentEvent[]) => void): Promise<AgentReply> {
  if (engine !== 'codex' && engine !== 'claude') return providerChat(providerTarget(engine), payload, onProgress);
  const progress = onProgress ? new Channel<AgentEvent[]>(onProgress) : undefined;
  return invoke<AgentReply>('assistant_chat', { payload, engine, folderId: folder?.id, progress });
}
export const pickAgentFolder = () => invoke<AgentFolder | null>('agent_pick_folder');
export const openAgentFolder = (id: string) => invoke<void>('agent_open_folder', { id });
export const revealAgentFile = (id: string, path: string) => invoke<void>('agent_reveal_file', { id, path });
export const openAgentTerminal = (engine: NativeAgent, id: string) => invoke<void>('agent_open_terminal', { engine, id });
export async function cancelPolish() {
  await invoke<void>('cancel_polish');
  await invoke<void>('provider_cancel_text').catch(() => undefined);
}

export async function saveArtifact(fileName: string, blob: Blob): Promise<string | null> {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const archive = extension === '.zip' || extension === BACKUP_EXTENSION;
  if (blob.size > (archive ? ZIP_LIMIT : FILE_LIMIT)) {
    throw extension === BACKUP_EXTENSION ? 'backup_too_large' : archive ? 'zip_export_limit' : 'export_limit';
  }
  if (nativeDesktop) {
    return invoke<string | null>('save_artifact', await exportBytes(fileName, blob));
  }
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  return fileName;
}

async function exportBytes(fileName: string, blob: Blob) {
  const name = new TextEncoder().encode(fileName);
  const bytes = new Uint8Array(4 + name.length + blob.size);
  new DataView(bytes.buffer).setUint32(0, name.length, true);
  bytes.set(name, 4);
  bytes.set(new Uint8Array(await blob.arrayBuffer()), 4 + name.length);
  return bytes;
}

export async function openArtifact(fileName: string, blob: Blob) {
  await invoke<void>('open_artifact', await exportBytes(fileName, blob));
}
