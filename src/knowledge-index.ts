import type { Evidence, Loaded } from './domain';
import { excerpts } from './office';

export interface KnowledgeModel {
  id: string;
  label: string;
  fingerprint: string;
  embed: (input: string[]) => Promise<number[][]>;
}

interface Segment { at: string; text: string; vector: Float32Array }
interface IndexedFile { id: string; version: string; segments: Segment[]; complete: boolean }

export interface KnowledgeIndex {
  datasetId: string;
  model: string;
  dimension: number;
  builtAt: string;
  files: IndexedFile[];
}

export interface KnowledgeProgress { done: number; total: number }

export const knowledgeSegmentLimit = 2048;
const segmentLength = 800;
const segmentOverlap = 60;
const batchSize = 16;
const maximumDimensions = 4096;
const storeName = 'indexes';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('office-knowledge-index', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(storeName, { keyPath: 'datasetId' });
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => resolve(opening.result);
  });
}

async function indexTransaction<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>, signal?: AbortSignal): Promise<T> {
  const db = await database();
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const operation = request(transaction.objectStore(storeName));
      const abort = () => transaction.abort();
      signal?.addEventListener('abort', abort, { once: true });
      transaction.oncomplete = () => {
        signal?.removeEventListener('abort', abort);
        resolve(operation.result);
      };
      transaction.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? transaction.error ?? Error('storage_error'));
      };
    });
  } finally { db.close(); }
}

export function loadKnowledgeIndex(datasetId: string) {
  return indexTransaction<KnowledgeIndex | undefined>('readonly', store => store.get(datasetId));
}

export function deleteKnowledgeIndex(datasetId: string, signal?: AbortSignal) {
  return indexTransaction('readwrite', store => store.delete(datasetId), signal);
}

function* fileSegments(file: Loaded): Generator<Omit<Segment, 'vector'>> {
  for (const { at, text } of excerpts(file)) {
    const clean = text.trim();
    if (!clean) continue;
    if (clean.length <= segmentLength) {
      yield { at, text: clean };
      continue;
    }
    const points = Array.from(clean);
    for (let offset = 0; offset < points.length; offset += segmentLength - segmentOverlap) {
      yield { at, text: points.slice(offset, offset + segmentLength).join('') };
      if (offset + segmentLength >= points.length) break;
    }
  }
}

function normalizeVector(values: number[], dimension?: number) {
  if (!values.length || values.length > maximumDimensions || (dimension !== undefined && values.length !== dimension)
    || values.some(value => !Number.isFinite(value))) throw Error('knowledge_vector_invalid');
  const norm = Math.hypot(...values);
  if (norm === 0 || !Number.isFinite(norm)) throw Error('knowledge_vector_invalid');
  return Float32Array.from(values, value => value / norm);
}

function verifiedFiles(files: readonly Loaded[]) {
  return files.filter(file => file.parsed && file.version !== undefined);
}

export function knowledgeStatus(index: KnowledgeIndex | undefined, files: readonly Loaded[]) {
  const known = new Map(verifiedFiles(files).map(file => [file.material.id, file.version]));
  const current = index?.files.filter(file => file.version === known.get(file.id)) ?? [];
  const covered = current.filter(file => file.segments.length).length;
  const limited = current.some(file => !file.complete);
  return {
    covered,
    total: files.length,
    segments: current.reduce((sum, file) => sum + file.segments.length, 0),
    stale: Boolean(index && (index.files.length !== current.length || current.length !== known.size)),
    limited,
  };
}

export async function buildKnowledgeIndex(datasetId: string, model: KnowledgeModel, files: readonly Loaded[], signal: AbortSignal,
  progress: (progress: KnowledgeProgress) => void): Promise<KnowledgeIndex> {
  const previous = await loadKnowledgeIndex(datasetId);
  signal.throwIfAborted();
  const reusable = previous?.model === model.fingerprint ? previous : undefined;
  const cached = new Map(reusable?.files.map(file => [file.id, file]));
  const indexed: IndexedFile[] = [];
  const pending: { file: IndexedFile; segment: Omit<Segment, 'vector'> }[] = [];
  let remaining = knowledgeSegmentLimit;

  for (const file of verifiedFiles(files)) {
    const { id } = file.material;
    const version = file.version!;
    const known = cached.get(id);
    if (known?.version === version && known.complete && known.segments.length <= remaining) {
      indexed.push(known);
      remaining -= known.segments.length;
      continue;
    }
    const next: IndexedFile = { id, version, segments: [], complete: true };
    indexed.push(next);
    for (const segment of fileSegments(file)) {
      if (!remaining) { next.complete = false; break; }
      pending.push({ file: next, segment });
      remaining--;
    }
  }

  let dimension = reusable?.dimension || undefined;
  progress({ done: 0, total: pending.length });
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    signal.throwIfAborted();
    const batch = pending.slice(offset, offset + batchSize);
    const vectors = await model.embed(batch.map(({ segment }) => segment.text));
    signal.throwIfAborted();
    if (vectors.length !== batch.length) throw Error('knowledge_vector_invalid');
    for (const [position, { file, segment }] of batch.entries()) {
      const vector = normalizeVector(vectors[position]!, dimension);
      dimension = vector.length;
      file.segments.push({ ...segment, vector });
    }
    progress({ done: Math.min(offset + batch.length, pending.length), total: pending.length });
  }
  const index: KnowledgeIndex = { datasetId, model: model.fingerprint, dimension: dimension ?? 0, builtAt: new Date().toISOString(), files: indexed };
  await indexTransaction('readwrite', store => store.put(index), signal);
  return index;
}

function anchor(evidence: Evidence) {
  const location = evidence.locations[0];
  return JSON.stringify([location?.materialId, location?.at]);
}

export async function hybridKnowledgeSearch(index: KnowledgeIndex, model: KnowledgeModel, files: readonly Loaded[],
  query: string, keywords: Evidence[], signal: AbortSignal, limit = 18): Promise<Evidence[]> {
  if (index.model !== model.fingerprint || !index.dimension) return keywords;
  const current = new Map(verifiedFiles(files).map(file => [file.material.id, file]));
  const available = index.files.filter(file => file.version === current.get(file.id)?.version && file.segments.length);
  if (!available.length) return keywords;
  signal.throwIfAborted();
  const vectors = await model.embed([query]);
  signal.throwIfAborted();
  if (vectors.length !== 1) throw Error('knowledge_vector_invalid');
  const vector = normalizeVector(vectors[0]!, index.dimension);
  const semantic = [];
  for (const indexed of available) {
    const file = current.get(indexed.id)!;
    for (const segment of indexed.segments) {
      let score = 0;
      for (let i = 0; i < vector.length; i++) score += vector[i]! * segment.vector[i]!;
      if (score < .15) continue;
      const evidence: Evidence = { id: '', text: segment.text, locations: [{ materialId: indexed.id,
        file: file.material.relative, path: file.material.path, version: indexed.version, at: segment.at, excerpt: segment.text }] };
      semantic.push({ score, evidence });
    }
  }

  // Fuse ranks because keyword scores and embedding cosine scores use different scales.
  const fused = new Map<string, { evidence: Evidence; score: number }>();
  for (const [position, evidence] of keywords.entries()) fused.set(anchor(evidence), { evidence, score: 1 / (20 + position) });
  let position = 0;
  const seen = new Set<string>();
  for (const { evidence } of semantic.sort((a, b) => b.score - a.score)) {
    const key = anchor(evidence);
    if (seen.has(key)) continue;
    seen.add(key);
    const lexical = fused.get(key);
    fused.set(key, { evidence: lexical?.evidence ?? evidence, score: (lexical?.score ?? 0) + 1 / (20 + position++) });
    if (position >= limit * 2) break;
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.evidence);
}
