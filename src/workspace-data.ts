import { listSources, replaceWorkspaceSources, setWorkspaceRestore } from './desktop';
import type { Locale, Source } from './domain';
import { database } from './office';
import type { ArchivedReport, Artifact, AssistantTask, AssistantVersion } from './office';
import { slideProjectKey } from './slide-library';
import type { SlideAsset } from './slide-library';
import { readLocal, removeLocal, writeLocal } from './storage';
import { tableAnalysisKey } from './table-analysis';
import type { CreativeProject } from './creative-project';

export const preferenceNames = [
  'page', 'report-tab', 'settings', 'columns', 'folder-columns', 'excluded', 'report-profiles',
  'active-profile', 'active-scope', 'review-decisions', 'document-inclusions', 'active-assistant', 'tool-draft', slideProjectKey, tableAnalysisKey, 'creative-active',
  'workbench-dataset', 'dataset-scans', 'office-commands', 'agent-engine', 'office-workflows',
] as const;
export interface WorkspacePreferences {
  language: Locale;
  values: Partial<Record<(typeof preferenceNames)[number], unknown>>;
}

export interface WorkspaceData {
  artifacts: Artifact[];
  tasks: AssistantTask[];
  'task-versions': AssistantVersion[];
  reports: ArchivedReport[];
  'slide-assets': SlideAsset[];
  'creative-projects': CreativeProject[];
}

export interface WorkspacePoint {
  data: WorkspaceData;
  preferences: WorkspacePreferences;
  sources: Source[];
  createdAt: string;
}

const dataStores = ['artifacts', 'tasks', 'task-versions', 'reports', 'slide-assets', 'creative-projects'] as const;
const recovery = 'workspace-recovery';
const languageKey = 'report-desk.language';
type Pending = Pick<WorkspacePoint, 'preferences' | 'sources'>;

export function savedLanguage(): Locale {
  return localStorage.getItem(languageKey) === 'en-US' ? 'en-US' : 'zh-CN';
}

function capturePreferences(): WorkspacePreferences {
  const values: WorkspacePreferences['values'] = {};
  for (const name of preferenceNames) {
    const value = readLocal<unknown>(name, undefined);
    if (value !== undefined) values[name] = value;
  }
  return { language: savedLanguage(), values };
}

function restorePreferences(preferences: WorkspacePreferences) {
  // Clear only known workspace preferences before writing to avoid temporarily storing both copies.
  for (const name of preferenceNames) removeLocal(name);
  for (const name of preferenceNames) {
    const value = preferences.values[name];
    if (value !== undefined) writeLocal(name, value);
  }
  localStorage.setItem(languageKey, preferences.language);
}

function requested<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('storage_error'));
  });
}

async function readData(): Promise<WorkspaceData> {
  const db = await database();
  try {
    const transaction = db.transaction([...dataStores], 'readonly');
    const [artifacts, tasks, versions, reports, slides, projects] = await Promise.all([
      ...dataStores.map(name => requested(transaction.objectStore(name).getAll())),
      committed(transaction),
    ]);
    return { artifacts, tasks, 'task-versions': versions, reports, 'slide-assets': slides, 'creative-projects': projects } as WorkspaceData;
  } finally { db.close(); }
}

export async function captureWorkspace(): Promise<WorkspacePoint> {
  const preferences = capturePreferences();
  const [data, sources] = await Promise.all([readData(), listSources()]);
  return { data, sources, preferences, createdAt: new Date().toISOString() };
}

async function readRestorePoint(id: 'previous' | 'pending') {
  const db = await database();
  try { return await requested(db.transaction(recovery, 'readonly').objectStore(recovery).get(id)); }
  finally { db.close(); }
}

export async function previousWorkspace(): Promise<WorkspacePoint | undefined> {
  const entry = await readRestorePoint('previous') as { point: WorkspacePoint } | undefined;
  return entry?.point;
}

export async function hasPreviousWorkspace() {
  const db = await database();
  try { return (await requested(db.transaction(recovery, 'readonly').objectStore(recovery).getKey('previous'))) !== undefined; }
  finally { db.close(); }
}

export async function stageWorkspace(point: WorkspacePoint, previous?: WorkspacePoint) {
  const db = await database();
  try {
    const transaction = db.transaction([...dataStores, recovery], 'readwrite');
    const completion = committed(transaction);
    try {
      for (const name of dataStores) {
        const store = transaction.objectStore(name);
        store.clear();
        for (const entry of point.data[name] ?? []) store.put(entry);
      }
      const checkpoints = transaction.objectStore(recovery);
      checkpoints.put({ id: 'pending', preferences: point.preferences, sources: point.sources });
      if (previous) checkpoints.put({ id: 'previous', point: previous });
      else checkpoints.delete('previous');
    } catch (error) {
      transaction.abort();
      await completion.catch(() => {});
      throw error;
    }
    await completion;
  } finally { db.close(); }
}

export async function restoreWorkspace(point: WorkspacePoint) {
  await setWorkspaceRestore(true);
  try {
    await stageWorkspace(point, await captureWorkspace());
  } catch (error) {
    await setWorkspaceRestore(false);
    throw error;
  }
}

export async function finishWorkspaceRestore() {
  const pending = await readRestorePoint('pending') as Pending | undefined;
  if (!pending) {
    await setWorkspaceRestore(false);
    return false;
  }
  await setWorkspaceRestore(true);
  await replaceWorkspaceSources(pending.sources);
  restorePreferences(pending.preferences);
  const db = await database();
  try {
    const transaction = db.transaction(recovery, 'readwrite');
    const completion = committed(transaction);
    transaction.objectStore(recovery).delete('pending');
    await completion;
  } finally { db.close(); }
  await setWorkspaceRestore(false);
  return true;
}
