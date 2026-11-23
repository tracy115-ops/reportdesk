import { FILE_LIMIT, isAgentEngine, ZIP_LIMIT } from './desktop';
import { sections } from './domain';
import type { Artifact } from './office';
import { isSlideMetadata, isSlideProject } from './slide-library';
import type { SlideAsset } from './slide-library';
import { preferenceNames } from './workspace-data';
import type { WorkspacePoint } from './workspace-data';
import { validToolDraft } from './tool-draft';
import { validTableAnalysis } from './table-analysis';
import { validCreativeProject } from './creative-project';
import { validWorkflows } from './office-workflows';

const format = 'Office Workspace Backup';
const version = 4;
const manifestName = 'workspace.json';
const checksumName = 'workspace.sha256';
const artifactKinds = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'png', 'mp3', 'mp4'];
type RecordValue = Record<string, unknown>;
type StoredBlob = { entry: string; size: number; sha256: string };
type FileRecord = Omit<Artifact, 'file'> & StoredBlob;
type AssetRecord = Omit<SlideAsset, 'file'> & StoredBlob;
type Manifest = Omit<WorkspacePoint, 'data'> & {
  format: typeof format;
  version: 1 | 2 | 3 | typeof version;
  data: Omit<WorkspacePoint['data'], 'artifacts' | 'slide-assets' | 'creative-projects'> & { artifacts: FileRecord[]; 'slide-assets'?: AssetRecord[]; 'creative-projects'?: WorkspacePoint['data']['creative-projects'] };
};

const isObject = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isSet = (value: unknown): value is string => isText(value) && value.trim() !== '';
const isBool = (value: unknown) => typeof value === 'boolean';
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown) => isText(value) && Number.isFinite(Date.parse(value));
const isLocale = (value: unknown) => value === 'zh-CN' || value === 'en-US';
const isCadence = (value: unknown) => value === 'weekly' || value === 'monthly';
const isChoice = (value: unknown, choices: string[]) => isText(value) && choices.includes(value);
const isOptional = (value: unknown, validate: (value: unknown) => boolean) => value === undefined || validate(value);
const isList = (value: unknown, validate: (value: unknown) => boolean) => Array.isArray(value) && value.every(validate);
const objectValues = (value: unknown, validate: (entry: unknown) => boolean) => isObject(value) && Object.values(value).every(validate);
const textFields = (value: RecordValue, names: readonly string[]) => names.every(name => isText(value[name]));

function settings(value: unknown, period = true) {
  return isObject(value) && isText(value.team) && isCadence(value.cadence) && isLocale(value.locale)
    && (!period || textFields(value, ['from', 'to']));
}

function source(value: unknown) {
  return isObject(value) && isSet(value.id) && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.id)
    && isSet(value.name) && isSet(value.path) && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(value.path) && isBool(value.directory)
    && isOptional(value.originalName, isSet);
}

function evidence(value: unknown) {
  return isObject(value) && textFields(value, ['id', 'text']) && isList(value.locations, location =>
    isObject(location) && textFields(location, ['file', 'path', 'at', 'excerpt'])
      && isOptional(location.version, isText) && isOptional(location.materialId, isText));
}

function agentChanges(value: unknown) {
  return isObject(value) && isSet(value.folderId) && isBool(value.limited)
    && Array.isArray(value.files) && value.files.length <= 40 && value.files.every(file =>
      isObject(file) && isSet(file.path) && isChoice(file.change, ['created', 'modified']));
}

function draft(value: unknown) {
  return isObject(value) && isLocale(value.language) && isChoice(value.format, ['answer', 'docx', 'pptx', 'bundle'])
    && isOptional(value.reply, isBool) && isOptional(value.deniedTools, isCount) && isOptional(value.changes, agentChanges)
    && isOptional(value.model, isSet)
    && isList(value.refs, evidence) && isObject(value.value) && isText(value.value.title)
    && isList(value.value.sections, part => isObject(part) && textFields(part, ['heading', 'text']));
}

function taskInputs(value: unknown): value is RecordValue {
  return isObject(value) && isText(value.request) && isLocale(value.locale) && isList(value.attachments, isText)
    && isOptional(value.agentFolder, folder => isObject(folder) && isSet(folder.id) && isSet(folder.path))
    && isOptional(value.retrieval, entry => isChoice(entry, ['attachments', 'keyword', 'hybrid']))
    && isChoice(value.format, ['answer', 'docx', 'pptx', 'bundle']) && isOptional(value.pinned, items => isList(items, evidence))
    && isOptional(value.dataset, scope => isObject(scope) && isSet(scope.id) && isSet(scope.name)
      && isList(scope.sourceIds, isSet) && isList(scope.materialIds, isSet));
}

function task(value: unknown) {
  return taskInputs(value) && isSet(value.id) && isTime(value.updatedAt) && isBool(value.revise) && isOptional(value.draft, draft)
    && isOptional(value.conversationTitle, isSet) && isOptional(value.conversationPinnedAt, isTime)
    && isOptional(value.submittedRequest, isText) && isOptional(value.failedChanges, agentChanges)
    && isOptional(value.engine, isAgentEngine)
    && isOptional(value.interruptedReply, reply => isObject(reply) && isSet(reply.request) && isSet(reply.model)
      && isSet(reply.text) && reply.text.length <= 50_000)
    && isChoice(value.status, ['idle', 'running', 'complete', 'failed', 'interrupted'])
    && isOptional(value.delivery, isText) && isOptional(value.error, isText) && isOptional(value.deliveryError, isText)
    && isOptional(value.retryKinds, kinds => isList(kinds, kind => isChoice(kind, ['docx', 'pptx'])))
    && isOptional(value.forkFromId, isSet);
}

function taskVersion(value: unknown) {
  return isObject(value) && isSet(value.id) && isSet(value.taskId) && isTime(value.savedAt)
    && isChoice(value.change, ['generatedVersion', 'editedVersion', 'previousVersion']) && taskInputs(value.task) && draft(value.task.draft)
    && isOptional(value.parentId, id => id === null || isSet(id));
}

function reportSnapshot(value: unknown) {
  if (!isObject(value) || !isObject(value.input) || !isObject(value.details)) return false;
  return textFields(value.input, ['settings', 'review', 'scan'])
    && isList(value.input.files, file => isObject(file) && textFields(file, ['id', 'name', 'signature']))
    && isList(value.details.tasks, row => isObject(row) && textFields(row, ['title', 'owner', 'date', 'rawStatus', 'reason', 'sources'])
      && isBool(row.confirmed) && isChoice(row.status, ['done', 'open', 'unknown', 'conflict']))
    && isList(value.details.issues, row => isObject(row) && textFields(row, ['code', 'detail', 'sources', 'excerpt']));
}

function report(value: unknown) {
  if (!isObject(value) || !isSet(value.id) || !isObject(value.report)) return false;
  const data = value.report;
  return isSet(data.id) && isTime(data.createdAt) && settings(data.settings) && isObject(data.metrics)
    && ['total', 'done', 'open', 'unverified', 'documents'].every(key => isObject(data.metrics) && isCount(data.metrics[key]))
    && isObject(data.narrative) && textFields(data.narrative, sections) && isList(data.evidence, evidence) && objectValues(data.issues, isCount)
    && isOptional(value.updatedAt, isTime) && isOptional(value.revision, isText) && isOptional(value.snapshot, reportSnapshot)
    && isOptional(value.dataset, entry => isObject(entry) && isSet(entry.id) && isSet(entry.name) && isList(entry.sourceIds, isSet));
}

function datasetScan(value: unknown) {
  if (!isObject(value) || !isObject(value.changes)) return false;
  const changes = value.changes;
  return isList(value.files, file => isObject(file) && textFields(file, ['key', 'name', 'version']))
    && (isTime(changes.at) || (changes.at === '' && changes.partial === true))
    && isOptional(changes.first, isBool) && isOptional(changes.partial, isBool)
    && ['added', 'changed', 'removed'].every(name => isList(changes[name], isText));
}

function mapping(value: unknown) {
  return isObject(value) && textFields(value, ['sheet', 'namespace', 'done', 'open', 'signature'])
    && ['headerRow', 'date', 'status'].every(field => isCount(value[field]))
    && ['id', 'title', 'owner'].every(field => isOptional(value[field], isCount))
    && isChoice(value.dateOrder, ['ymd', 'mdy', 'dmy']);
}

function preferences(value: unknown) {
  if (!isObject(value) || !isLocale(value.language) || !isObject(value.values)) return false;
  const values = value.values;
  if (Object.keys(values).some(name => !preferenceNames.some(key => key === name))) return false;
  const checks: Record<(typeof preferenceNames)[number], (entry: unknown) => boolean> = {
    page: entry => isChoice(entry, ['data', 'assistant', 'library', 'analysis', 'tools', 'current', 'artifacts', 'slides', 'creative', 'workflows', 'models', 'media', 'mcp', 'browser']),
    'report-tab': entry => isChoice(entry, ['review', 'preview']),
    settings,
    columns: entry => objectValues(entry, mapping),
    'folder-columns': entry => objectValues(entry, rules => isList(rules, mapping)),
    excluded: entry => isList(entry, isText),
    'report-profiles': entry => isList(entry, profile => isObject(profile) && textFields(profile, ['id', 'name'])
      && settings(profile.settings, false) && isList(profile.sourceIds, isText) && isList(profile.excluded, isText)),
    'active-profile': entry => entry === null || isText(entry),
    'active-scope': entry => entry === null || isList(entry, isText),
    'review-decisions': entry => objectValues(entry, group => objectValues(group, decision => isObject(decision)
      && isChoice(decision.status, ['done', 'open']) && textFields(decision, ['signature', 'reason']) && isOptional(decision.date, isText))),
    'document-inclusions': entry => objectValues(entry, group => objectValues(group, isText)),
    'active-assistant': task,
    'tool-draft': validToolDraft,
    'slide-project': isSlideProject,
    'table-analysis': validTableAnalysis,
    'creative-active': isText,
    'workbench-dataset': entry => entry === null || isText(entry),
    'dataset-scans': entry => objectValues(entry, datasetScan),
    'office-commands': entry => Array.isArray(entry) && entry.length <= 32 && entry.every(command => isObject(command)
      && isSet(command.id) && isSet(command.name) && command.name.length <= 60 && isSet(command.request) && command.request.length <= 1200),
    'agent-engine': isAgentEngine,
    'office-workflows': validWorkflows,
  };
  return preferenceNames.every(name => isOptional(values[name], checks[name]));
}

function fileRecord(value: unknown) {
  return isObject(value) && isSet(value.id) && textFields(value, ['title', 'detail', 'entry']) && isTime(value.createdAt)
    && isChoice(value.kind, artifactKinds) && isOptional(value.group, isText) && isOptional(value.savedPath, isText)
    && validBlob(value);
}

function validBlob(value: unknown): value is StoredBlob {
  return isObject(value) && isText(value.entry) && isCount(value.size) && Number(value.size) > 0 && Number(value.size) <= FILE_LIMIT
    && isText(value.sha256) && /^[\da-f]{64}$/.test(value.sha256);
}

function uniqueIds(entries: { id: string }[]) {
  return new Set(entries.map(entry => entry.id)).size === entries.length;
}

function validateManifest(manifest: unknown): Manifest {
  if (!isObject(manifest) || manifest.format !== format || !isTime(manifest.createdAt)) throw 'backup_invalid';
  if (manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3 && manifest.version !== version) throw 'backup_version';
  const { data } = manifest;
  if (!isObject(data) || !preferences(manifest.preferences) || !isList(manifest.sources, source) || !isList(data.artifacts, fileRecord)
    || !isList(data.tasks, task) || !isList(data['task-versions'], taskVersion) || !isList(data.reports, report)
    || (manifest.version !== 1 && !isList(data['slide-assets'], entry => isSlideMetadata(entry) && validBlob(entry)))
    || (manifest.version === 1 && data['slide-assets'] !== undefined)
    || (manifest.version === version && !isList(data['creative-projects'], validCreativeProject))) throw 'backup_invalid';
  const checked = manifest as unknown as Manifest;
  if (!uniqueIds(checked.sources) || new Set(checked.sources.map(source => source.path.toLowerCase())).size !== checked.sources.length
    || !Object.values(checked.data).every(uniqueIds)) throw 'backup_invalid';
  return checked;
}

async function checksum(value: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildWorkspaceBackup(point: WorkspacePoint): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const encoder = new TextEncoder();
  const files: FileRecord[] = [];
  const slides: AssetRecord[] = [];
  const entries: Record<string, Uint8Array> = {};
  let size = 0;
  async function storeBlob(file: Blob, entry: string): Promise<StoredBlob> {
    size += file.size + 1024;
    if (size > ZIP_LIMIT) throw 'backup_too_large';
    const contents = new Uint8Array(await file.arrayBuffer());
    entries[entry] = contents;
    return { entry, size: file.size, sha256: await checksum(contents) };
  }
  for (const [index, artifact] of point.data.artifacts.entries()) {
    const { file, ...fields } = artifact;
    files.push({ ...fields, ...await storeBlob(file, 'files/' + index + '.' + artifact.kind) });
  }
  for (const [index, asset] of point.data['slide-assets'].entries()) {
    const { file, ...fields } = asset;
    slides.push({ ...fields, ...await storeBlob(file, 'slide-assets/' + index + '.pptx') });
  }
  const manifest = { ...point, format, version, data: { ...point.data, artifacts: files, 'slide-assets': slides } };
  validateManifest(manifest);
  const json = encoder.encode(JSON.stringify(manifest));
  if (size + json.byteLength + 4096 > ZIP_LIMIT) throw 'backup_too_large';
  entries[manifestName] = json;
  entries[checksumName] = encoder.encode(await checksum(json));
  return new Blob([new Uint8Array(zipSync(entries, { level: 0 }))], { type: 'application/zip' });
}

export async function openWorkspaceBackup(buffer: ArrayBuffer): Promise<WorkspacePoint> {
  if (buffer.byteLength > ZIP_LIMIT) throw 'backup_too_large';
  const { unzipSync } = await import('fflate');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  const names = new Set<string>();
  try {
    const entries = unzipSync(new Uint8Array(buffer), { filter: entry => {
      if (names.has(entry.name) || ![manifestName, checksumName].includes(entry.name)
        && !/^(?:files\/\d+\.(docx|xlsx|pptx|pdf|html|png|mp3|mp4)|slide-assets\/\d+\.pptx)$/.test(entry.name)) {
        throw 'backup_invalid';
      }
      names.add(entry.name);
      size += entry.originalSize;
      if (size > ZIP_LIMIT) throw 'backup_too_large';
      return true;
    } });
    const manifestBytes = entries[manifestName];
    const digestBytes = entries[checksumName];
    if (!manifestBytes || !digestBytes || decoder.decode(digestBytes) !== await checksum(manifestBytes)) throw 'backup_invalid';
    const manifest = validateManifest(JSON.parse(decoder.decode(manifestBytes)));
    const assetRecords = manifest.data['slide-assets'] ?? [];
    if (names.size !== manifest.data.artifacts.length + assetRecords.length + 2) throw 'backup_invalid';
    async function readBlob(record: StoredBlob, path: string, type?: string) {
      const bytes = entries[record.entry];
      if (record.entry !== path || !bytes || bytes.byteLength !== record.size || await checksum(bytes) !== record.sha256) throw 'backup_invalid';
      return new Blob([new Uint8Array(bytes)], { type });
    }
    const artifacts: Artifact[] = [];
    for (const [index, record] of manifest.data.artifacts.entries()) {
      const { entry, sha256, size, ...fields } = record;
      const types: Partial<Record<Artifact['kind'], string>> = { png: 'image/png', mp3: 'audio/mpeg', mp4: 'video/mp4' };
      artifacts.push({ ...fields, file: await readBlob({ entry, sha256, size }, 'files/' + index + '.' + fields.kind, types[fields.kind]) });
    }
    const slides: SlideAsset[] = [];
    for (const [index, record] of assetRecords.entries()) {
      const { entry, sha256, size, ...fields } = record;
      slides.push({ ...fields, file: await readBlob({ entry, sha256, size }, 'slide-assets/' + index + '.pptx') });
    }
    return { sources: manifest.sources, preferences: manifest.preferences, createdAt: manifest.createdAt,
      data: { ...manifest.data, artifacts, 'slide-assets': slides, 'creative-projects': manifest.data['creative-projects'] ?? [] } };
  } catch (error) {
    if (error === 'backup_version' || error === 'backup_too_large') throw error;
    throw 'backup_invalid';
  }
}
