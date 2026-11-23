import type { Evidence, Loaded } from './domain';
import type { AssistantRetrieval } from './office';
import { excerpts, searchTerms } from './office';
import { hybridKnowledgeSearch, knowledgeStatus, loadKnowledgeIndex } from './knowledge-index';
import type { KnowledgeModel } from './knowledge-index';

const limit = 12;
const stop = new Set(['the', 'for', 'with', 'from', 'and', 'what', 'which', 'how', 'does', 'did', 'please', 'tell', 'this',
  '一下', '哪些', '如何', '什么', '资料', '里面', '帮我', '请问', '根据', '关于', '告诉', '问题']);

export function keywordEvidence(files: Loaded[], query: string): Evidence[] {
  const phrase = query.trim().normalize('NFKC').toLowerCase();
  const terms = [...searchTerms(phrase)].filter(term => !stop.has(term));
  const ranked: { score: number; matches: number; exact: boolean; at: string; text: string; file: Loaded }[] = [];
  let bestCoverage = 0;
  for (const file of files) {
    if (!file.parsed || !file.version) continue;
    const candidates: typeof ranked = [];
    for (const { at, text } of excerpts(file)) {
      if (!text.trim()) continue;
      const normalized = text.normalize('NFKC').toLowerCase();
      const exact = phrase ? normalized.indexOf(phrase) : -1;
      const positions = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
      if (exact < 0 && !positions.length) continue;
      bestCoverage = Math.max(bestCoverage, positions.length);
      const score = positions.length + (exact >= 0 ? 8 : 0);
      if (candidates.length >= 3 && score <= candidates.at(-1)!.score) continue;
      const start = Math.max(0, (exact >= 0 ? exact : Math.min(...positions)) - 140);
      candidates.push({ score, matches: positions.length, exact: exact >= 0, at, text: text.slice(start, start + 820).trim(), file });
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > 3) candidates.pop();
    }
    ranked.push(...candidates);
  }
  const minimumCoverage = Math.ceil(bestCoverage / 2);
  return ranked.filter(item => item.exact || item.matches >= minimumCoverage)
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ at, text, file }) => ({
      id: '', text, locations: [{ file: file.material.relative, path: file.material.path, version: file.version,
        materialId: file.material.id, at, excerpt: text }],
    }));
}

export async function retrieveAssistantEvidence(datasetId: string, mode: Exclude<AssistantRetrieval, 'attachments'>, files: Loaded[],
  query: string, models: readonly KnowledgeModel[], signal: AbortSignal) {
  const keywords = keywordEvidence(files, query);
  if (mode === 'keyword') return { refs: keywords, degraded: false };
  try {
    const index = await loadKnowledgeIndex(datasetId);
    signal.throwIfAborted();
    const model = models.find(item => item.fingerprint === index?.model);
    if (index && model && knowledgeStatus(index, files).segments) {
      const refs = await hybridKnowledgeSearch(index, model, files, query, keywords, signal, limit);
      return { refs, degraded: false };
    }
  } catch { signal.throwIfAborted(); }
  return { refs: keywords, degraded: true };
}
