import { columnName, evidenceSignature } from './domain';
import type { ArtifactKind, Evidence, Loaded, Locale, Report } from './domain';
import type { SavedReport } from './report-snapshot';
import { archiveKey } from './report-snapshot';
import { readLocal } from './storage';
import type { SlideAsset } from './slide-library';
import type { CreativeProject } from './creative-project';
import type { AgentFolder, AgentWorkspaceChanges } from './desktop';

export interface OfficeDraft { title: string; sections: { heading: string; text: string }[] }
export interface Artifact { id: string; title: string; kind: ArtifactKind; file: Blob; createdAt: string; detail: string; savedPath?: string; group?: string }
export type NewArtifact = Pick<Artifact, 'title' | 'kind' | 'file' | 'detail'>;

export function* excerpts(source: Loaded): Generator<{ at: string; text: string }> {
  const data = source.parsed;
  if (!data) return;
  if (data.kind === 'docx') {
    for (const paragraph of data.paragraphs) yield { at: `§ ${paragraph.paragraph}`, text: paragraph.text };
  } else if (data.kind === 'xlsx') {
    for (const sheet of data.sheets) for (const row of sheet.rows) {
      const entries = Object.entries(row.cells);
      yield { at: `${sheet.name}!${columnName(Number(entries[0]?.[0] ?? 1))}${row.number}`, text: entries.map(([col, value]) => `${columnName(Number(col))}${row.number} ${value}`).join(' | ') };
    }
  } else {
    for (const page of data.pages) if (page.text) yield { at: `# ${page.index}`, text: page.text };
  }
}

function evidence(source: Loaded, item: { at: string; text: string }, id = ''): Evidence {
  const text = item.text.slice(0, 1600);
  return { id, text, locations: [{ file: source.material.relative, path: source.material.path, version: source.version, at: item.at, excerpt: text, materialId: source.material.id }] };
}

export function findExcerpts(sources: Loaded[], query: string, limit = 60, matchName = true) {
  const matches: { item: Evidence; score: number; rank: number }[] = [];
  const phrase = query.normalize('NFKC').trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  for (const source of sources) {
    const fileName = source.material.relative.normalize('NFKC').toLowerCase();
    const hits = [];
    let first: { at: string; text: string } | undefined;
    for (const item of excerpts(source)) {
      first ??= item;
      if (!phrase) break;
      const text = item.text.normalize('NFKC').toLowerCase();
      const at = text.indexOf(phrase);
      if (at >= 0 || (words.every(word => text.includes(word) || fileName.includes(word)) && words.some(word => text.includes(word)))) {
        const start = Math.max(0, (at >= 0 ? at : text.indexOf(words.find(word => text.includes(word)) ?? '')) - 140);
        hits.push({ item: { at: item.at, text: item.text.slice(start, start + 1600) }, score: at >= 0 ? 3 : 2 });
        if (hits.length >= 6) break;
      }
    }
    if (matchName && !hits.length && first && words.every(word => fileName.includes(word))) hits.push({ item: first, score: 1 });
    hits.forEach((hit, rank) => matches.push({ item: evidence(source, hit.item), score: hit.score, rank }));
  }
  return matches.sort((a, b) => b.score - a.score || a.rank - b.rank).slice(0, limit).map(match => match.item);
}

export const assistantPresets = {
  report: { label: 'shortDoc', request: 'requestDoc', format: 'docx' },
  meeting: { label: 'shortMeeting', request: 'requestMeeting', format: 'docx' },
  slides: { label: 'shortSlides', request: 'requestSlides', format: 'pptx' },
} as const;
export type AssistantPreset = keyof typeof assistantPresets;
export interface AssistantDatasetScope {
  id: string;
  name: string;
  sourceIds: string[];
  materialIds: string[];
}
export type AssistantReference =
  | { materialIds: string[]; preset?: AssistantPreset }
  | { evidence: Evidence }
  | { analysis: Evidence }
  | { dataset: AssistantDatasetScope; request?: string; pinned?: Evidence[]; format?: Format };

export function datasetExcerpts(scope: AssistantDatasetScope, excerpts: Evidence[]) {
  const allowed = new Set(scope.materialIds);
  return excerpts.filter(excerpt => excerpt.locations.length > 0 && excerpt.locations.every(location =>
    location.materialId && allowed.has(location.materialId)));
}

type InputExcerpt = { ref: string; file: string; at: string; text: string };
type ConversationExtract = { request: string; response: string };
type ConversationMemory = { recent: ConversationExtract[]; earlierSummary: string[]; relevant: ConversationExtract[] };
const inputLimit = 55_000;

export function searchTerms(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const terms = new Set((normalized.match(/[a-z\d]{3,}/g) ?? []).slice(0, 40));
  for (const run of (normalized.match(/\p{Script=Han}{2,}/gu) ?? []).slice(0, 20)) {
    for (let index = 0; index < Math.min(run.length - 1, 24); index++) terms.add(run.slice(index, index + 2));
  }
  return terms;
}

export function assistantInput(request: string, kind: Format, files: Loaded[], pinned: Evidence[], prior: AssistantDraft | undefined,
  ancestry?: AssistantVersion[], retrieved?: Evidence[]) {
  const refs: Evidence[] = [];
  const parts: InputExcerpt[] = [];
  const encoder = new TextEncoder();
  const shown = new Map<string, string>();
  const latest = ancestry ? ancestry.at(-1)?.task.draft : prior;
  const previous = latest && {
    title: latest.value.title,
    sections: latest.value.sections.map(part => ({ ...part })),
  };
  if (ancestry && previous && encoder.encode(JSON.stringify(previous)).length > 25_000) {
    previous.sections = previous.sections.map(part => ({ heading: part.heading.slice(0, 140), text: part.text.slice(0, 480) }));
  }
  let conversation: ConversationMemory | undefined;
  const payload = () => JSON.stringify({ request, outputKind: kind, evidence: parts, priorDraft: previous ?? null, conversation });
  let budget = inputLimit - encoder.encode(payload()).length;
  if (budget < 0) throw 'assistant_input_too_large';

  function add(source: Evidence) {
    const location = source.locations[0];
    if (!location) return;
    const signature = evidenceSignature(source);
    if (shown.has(signature)) return shown.get(signature);
    const part = { ref: 'S' + (refs.length + 1), file: location.file.slice(0, 180), at: location.at.slice(0, 160), text: source.text };
    const size = encoder.encode(JSON.stringify(part)).length + 1;
    if (size > budget) return;
    parts.push(part);
    refs.push({ ...source, id: part.ref });
    budget -= size;
    shown.set(signature, part.ref);
    return part.ref;
  }

  for (const source of pinned) if (!add(source)) throw 'assistant_input_too_large';
  for (const source of retrieved ?? []) add(source);

  function remap(text: string, sourceRefs: Evidence[], permitEvidence: () => boolean) {
    const priorRefs = new Map<string, string>();
    for (const ref of sourceRefs) {
      if (!text.includes('[' + ref.id + ']')) continue;
      const fromSelected = ref.locations.length > 0 && ref.locations.every(location =>
        files.some(file => file.material.id === location.materialId && file.version === location.version));
      const id = shown.get(evidenceSignature(ref)) ?? (fromSelected && permitEvidence() ? add(ref) : undefined);
      if (id) priorRefs.set(ref.id, id);
    }
    return (value: string) => value.replace(/\[([SDTA]\d+)\]/g, (_, id: string) => priorRefs.has(id) ? '[' + priorRefs.get(id) + ']' : '');
  }

  if (previous && latest) {
    const text = [previous.title, ...previous.sections.flatMap(part => [part.heading, part.text])].join('\n');
    const citations = remap(text, latest.refs, () => true);
    previous.title = citations(previous.title);
    previous.sections = previous.sections.map(part => ({ heading: citations(part.heading), text: citations(part.text) }));
    budget = inputLimit - encoder.encode(payload()).length;
    if (budget < 0) throw 'assistant_input_too_large';
  }

  const cap = Math.max(3, Math.floor(70 / Math.max(1, files.length)));
  const terms = searchTerms(request);
  if (ancestry?.length) {
    const recent = ancestry.slice(-3);
    const older = ancestry.slice(0, -3);
    const relevant = older.map((entry, index) => {
      const { request, draft } = entry.task;
      const requestText = request.normalize('NFKC').toLowerCase();
      const requestScore = [...terms].filter(term => requestText.includes(term)).length;
      const passages = draft.value.sections.map(part => {
        const text = [part.heading, part.text].filter(Boolean).join('\n');
        const searchable = text.normalize('NFKC').toLowerCase();
        const matches = [...terms].map(term => searchable.indexOf(term)).filter(position => position >= 0);
        const start = matches.length ? Math.max(0, Math.min(...matches) - 85) : 0;
        return { text: text.slice(start, start + 370), matches: matches.length };
      }).sort((a, b) => b.matches - a.matches);
      return { entry, index, score: requestScore + (passages[0]?.matches ?? 0), passage: passages[0]?.text };
    }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 2);
    const minimumRemaining = budget - 3500;
    function extract(entry: AssistantVersion, passage?: string) {
      const response = [entry.task.draft.value.title.slice(0, 110), passage ?? entry.task.draft.value.sections.map(part => part.text).join('\n').slice(0, 380)]
        .filter(Boolean).join('\n').replace(/\[[SDTA]\d*$/, '');
      return { request: entry.task.request.slice(0, 300), response: remap(response, entry.task.draft.refs, () => budget > minimumRemaining)(response) };
    }
    conversation = {
      recent: recent.map(entry => extract(entry)),
      earlierSummary: older.filter((entry, index) => index === 0 || index >= older.length - 4).map(entry => {
        const text = [entry.task.request, entry.task.draft.value.title, ...entry.task.draft.value.sections.slice(0, 2).map(part => part.heading)].join(' — ').slice(0, 130);
        return text.replace(/\[([SDTA]\d+)\]/g, '');
      }),
      relevant: relevant.sort((a, b) => a.index - b.index).map(({ entry, passage }) => extract(entry, passage)),
    };
    const memoryBytes = encoder.encode(payload()).length;
    if (memoryBytes + 8_000 > inputLimit) conversation = undefined;
    budget = inputLimit - encoder.encode(payload()).length;
  }
  const candidates = (retrieved ? [] : files).map(file => {
    const best: { item: { at: string; text: string }; score: number; order: number }[] = [];
    let order = 0;
    for (const item of excerpts(file)) {
      order++;
      const text = item.text.normalize('NFKC').toLowerCase();
      let score = 0;
      for (const term of terms) if (text.includes(term)) score++;
      if (best.length === cap && score <= best.at(-1)!.score) continue;
      best.push({ item, score, order });
      best.sort((a, b) => b.score - a.score || a.order - b.order);
      if (best.length > cap) best.pop();
    }
    return best.map(({ item }) => evidence(file, { at: item.at, text: item.text.slice(0, 440) }));
  });
  const unread = retrieved ? [] : files.filter((_, index) => !candidates[index]?.length).map(file => file.material.relative);
  for (let rank = 0; rank < cap && budget > 0; rank++) {
    for (const excerpts of candidates) {
      const excerpt = excerpts[rank];
      if (excerpt) add(excerpt);
    }
  }
  if (candidates.some((matches, index) => matches.length > 0
    && !refs.some(ref => ref.locations[0]?.materialId === files[index]?.material.id))) throw 'assistant_input_too_large';
  return { refs, unread, conversation, includesDraft: Boolean(previous), payload: payload() };
}

export function artifactName(artifact: Pick<Artifact, 'title' | 'kind'>) {
  const title = artifact.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim().slice(0, 85).replace(/[. ]+$/g, '');
  const safeTitle = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title) ? `_${title}` : title;
  return `${safeTitle || 'Office document'}.${artifact.kind}`;
}

const activeReport = 'active';
export type ArchivedReport = SavedReport & { id: string };

export function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('office-workspace', 7);
    opening.onupgradeneeded = () => {
      for (const name of ['artifacts', 'tasks', 'slide-assets', 'creative-projects']) {
        if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name, { keyPath: 'id' });
      }
      if (!opening.result.objectStoreNames.contains('task-versions')) {
        const versions = opening.result.createObjectStore('task-versions', { keyPath: 'id' });
        versions.createIndex('taskId', 'taskId');
      }
      if (!opening.result.objectStoreNames.contains('workspace-recovery')) {
        opening.result.createObjectStore('workspace-recovery', { keyPath: 'id' });
      }
      if (!opening.result.objectStoreNames.contains('reports')) {
        const reports = opening.result.createObjectStore('reports', { keyPath: 'id' });
        const draft = readLocal<Report | null>('active-report', null);
        if (draft?.id) reports.put({ id: activeReport, report: draft });
        const history = readLocal<Report[]>('history', []);
        for (const report of Array.isArray(history) ? history : []) {
          if (report?.id) reports.put({ id: report.id, report });
        }
      }
    };
    opening.onsuccess = () => {
      opening.result.onversionchange = () => opening.result.close();
      resolve(opening.result);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error('storage_error'));
  });
}

async function transaction<T>(name: 'artifacts' | 'tasks' | 'reports' | 'task-versions' | 'slide-assets' | 'creative-projects', mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const result = request(tx.objectStore(name));
      tx.oncomplete = () => resolve(result.result);
      tx.onabort = () => reject(tx.error ?? result.error);
      tx.onerror = () => reject(tx.error ?? result.error);
    });
  } finally { db.close(); }
}

export async function storedCreativeProjects() {
  const projects = await transaction('creative-projects', 'readonly', store => store.getAll()) as CreativeProject[];
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function storeCreativeProject(project: CreativeProject) { await transaction('creative-projects', 'readwrite', store => store.put(project)); }
export async function deleteCreativeProject(id: string) { await transaction('creative-projects', 'readwrite', store => store.delete(id)); }

export async function storedSlides() {
  const items = await transaction('slide-assets', 'readonly', store => store.getAll()) as SlideAsset[];
  return items.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}
export async function storeSlide(asset: SlideAsset) { await transaction('slide-assets', 'readwrite', store => store.put(asset)); }
export async function deleteSlide(id: string) { await transaction('slide-assets', 'readwrite', store => store.delete(id)); }

export async function storedArtifacts(): Promise<Artifact[]> {
  const items = await transaction('artifacts', 'readonly', store => store.getAll()) as Artifact[];
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function storeArtifact(item: Artifact) { await transaction('artifacts', 'readwrite', store => store.put(item)); }
export async function storeArtifacts(items: Artifact[]) {
  if (items.length) await transaction('artifacts', 'readwrite', store => {
    for (const item of items.slice(0, -1)) store.put(item);
    return store.put(items.at(-1)!);
  });
}
export async function deleteArtifact(id: string) { await transaction('artifacts', 'readwrite', store => store.delete(id)); }

export async function storedReports() {
  const entries = await transaction('reports', 'readonly', store => store.getAll()) as ArchivedReport[];
  const draft = entries.find(entry => entry.id === activeReport) ?? null;
  const history = entries.filter(entry => entry.id !== activeReport)
    .sort((a, b) => (b.updatedAt ?? b.report.createdAt).localeCompare(a.updatedAt ?? a.report.createdAt));
  return { draft, history };
}

export async function storeReportDraft(draft: SavedReport, previous?: SavedReport) {
  const archived = previous && { ...previous, id: archiveKey(previous) };
  await transaction('reports', 'readwrite', store => {
    if (archived) store.put(archived);
    return store.put({ ...draft, id: activeReport });
  });
  return archived;
}

export async function storeReportArchive(report: SavedReport) {
  const archived = { ...report, id: archiveKey(report) };
  await transaction('reports', 'readwrite', store => store.put(archived));
  return archived;
}

export async function deleteReportArchive(id: string) { await transaction('reports', 'readwrite', store => store.delete(id)); }

export type Format = 'answer' | 'docx' | 'pptx' | 'bundle';
export type AssistantRetrieval = 'attachments' | 'keyword' | 'hybrid';
export type AssistantDraft = { value: OfficeDraft; language: Locale; refs: Evidence[]; format: Format; reply?: boolean; deniedTools?: number; changes?: AgentWorkspaceChanges };
export interface AssistantTask {
  id: string;
  conversationTitle?: string;
  conversationPinnedAt?: string;
  request: string;
  submittedRequest?: string;
  forkFromId?: string;
  attachments: string[];
  pinned?: Evidence[];
  dataset?: AssistantDatasetScope;
  retrieval?: AssistantRetrieval;
  agentFolder?: AgentFolder;
  locale: Locale;
  format: Format;
  draft?: AssistantDraft;
  status: 'idle' | 'running' | 'complete' | 'failed' | 'interrupted';
  error?: string;
  failedChanges?: AgentWorkspaceChanges;
  delivery?: string;
  deliveryError?: string;
  retryKinds?: ('docx' | 'pptx')[];
  updatedAt: string;
  revise: boolean;
}

export const conversationTitleLimit = 96;

export function normalizeConversationTitle(title: string) {
  const line = title.trim().replace(/\s+/g, ' ');
  return [...line].slice(0, conversationTitleLimit).join('');
}

export function assistantConversationTitle(task: AssistantTask): string {
  if (task.conversationTitle?.trim()) return task.conversationTitle;
  for (const candidate of [task.draft?.value.title, task.submittedRequest, task.request, task.dataset?.name]) {
    const title = candidate && normalizeConversationTitle(candidate.replace(/\[S\d+\]/g, ''));
    if (title) return title;
  }
  return '';
}

type VersionChange = 'generatedVersion' | 'editedVersion' | 'previousVersion';
export interface AssistantVersion {
  id: string;
  taskId: string;
  parentId?: string | null;
  savedAt: string;
  change: VersionChange;
  task: Pick<AssistantTask, 'request' | 'attachments' | 'pinned' | 'dataset' | 'retrieval' | 'agentFolder' | 'format' | 'locale'> & { draft: AssistantDraft };
}

export function assistantVersion(task: AssistantTask, change: VersionChange = 'previousVersion', parentId?: string | null): AssistantVersion | undefined {
  if (!task.draft || !task.delivery) return;
  return {
    id: task.delivery, taskId: task.id, parentId, savedAt: task.updatedAt, change,
    task: {
      request: task.submittedRequest ?? task.request,
      attachments: task.attachments,
      pinned: task.pinned,
      dataset: task.dataset,
      retrieval: task.retrieval,
      agentFolder: task.agentFolder,
      format: task.draft.format,
      locale: task.draft.language,
      draft: task.draft,
    },
  };
}

export function conversationVersions(entries: AssistantVersion[]) {
  const chronological = [...entries].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  return new Map(chronological.map((entry, index) => [entry.id, {
    ...entry,
    parentId: entry.parentId === undefined ? chronological[index - 1]?.id ?? null : entry.parentId,
  }]));
}

export function conversationPath(entries: ReadonlyMap<string, AssistantVersion>, turnId?: string | null) {
  const path: AssistantVersion[] = [];
  const visited = new Set<string>();
  let next = turnId ? entries.get(turnId) : undefined;
  while (next && !visited.has(next.id)) {
    visited.add(next.id);
    path.push(next);
    next = next.parentId ? entries.get(next.parentId) : undefined;
  }
  return path.reverse();
}

export async function storedTasks() {
  const items = await transaction('tasks', 'readonly', store => store.getAll()) as AssistantTask[];
  return items.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
}
export async function storeTask(task: AssistantTask) { await transaction('tasks', 'readwrite', store => store.put(task)); }

export async function taskVersions(id: string) {
  const rows = await transaction('task-versions', 'readonly', store => store.index('taskId').getAll(id)) as AssistantVersion[];
  return rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function storeTaskResult(task: AssistantTask, version: AssistantVersion, previous?: AssistantVersion) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['tasks', 'task-versions'], 'readwrite');
      const versions = tx.objectStore('task-versions');
      if (previous && previous.id !== version.id) {
        const check = versions.getKey(previous.id);
        check.onsuccess = () => { if (check.result === undefined) versions.put(previous); };
      }
      versions.put(version);
      tx.objectStore('tasks').put(task);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function deleteTask(id: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['tasks', 'task-versions'], 'readwrite');
      tx.objectStore('tasks').delete(id);
      const versions = tx.objectStore('task-versions');
      const cursor = versions.index('taskId').openCursor(id);
      cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
