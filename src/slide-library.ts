import { createPresentation } from './presentation';
import { readLocal } from './storage';

export interface SlideOrigin {
  type: 'material' | 'artifact';
  id: string;
  name: string;
  page: number;
  version: string;
}

export interface SlideAsset {
  id: string;
  title: string;
  text: string;
  notes: string;
  category: string;
  tags: string[];
  createdAt: string;
  origin: SlideOrigin;
  file: Blob;
}

export type ProjectSlide = { id: string; assetId: string } | { id: string; title: string; text: string };
export interface SlideProject { title: string; includeSources: boolean; pages: ProjectSlide[] }
export const slideProjectKey = 'slide-project';

const text = (value: unknown): value is string => typeof value === 'string';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

export function isSlideMetadata(value: unknown): value is Omit<SlideAsset, 'file'> {
  if (!object(value) || !object(value.origin)) return false;
  const origin = value.origin;
  return [value.id, value.title, value.text, value.notes, value.category, value.createdAt, origin.id, origin.name, origin.version].every(text)
    && text(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) && strings(value.tags)
    && (origin.type === 'material' || origin.type === 'artifact') && typeof origin.page === 'number' && Number.isInteger(origin.page) && origin.page > 0;
}

export function isSlideProject(value: unknown): value is SlideProject {
  return object(value) && text(value.title) && typeof value.includeSources === 'boolean' && Array.isArray(value.pages)
    && value.pages.every(page => object(page) && text(page.id) && (text(page.assetId) || (text(page.title) && text(page.text))));
}

export function readSlideProject(fallback: string): SlideProject {
  const value = readLocal<unknown>(slideProjectKey, undefined);
  return isSlideProject(value) ? value : { title: fallback, includeSources: false, pages: [] };
}

export async function deckVersion(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, item => item.toString(16).padStart(2, '0')).join('');
}

export async function snapshotSlide(origin: SlideOrigin, bytes: ArrayBuffer, title: string, text: string, notes: string,
  metadata: Pick<SlideAsset, 'category' | 'tags'>): Promise<SlideAsset> {
  const { file } = await createPresentation([new Blob([bytes])], [{ source: 0, page: origin.page }], title);
  return { id: crypto.randomUUID(), origin, title, text, notes, ...metadata, file, createdAt: new Date().toISOString() };
}
