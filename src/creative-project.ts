import type { Evidence, Locale } from './domain';
import type { OfficeDraft } from './office';
import type { SlideData } from './slide-data';
import { exceedsSlideBody, paginateSlideBody } from './creative-pagination';
import { creativeScene } from './creative-scene';

export const creativeLayouts = ['cover', 'content', 'columns', 'steps', 'statement', 'metrics', 'timeline', 'comparison', 'chart'] as const;
export type CreativeLayout = typeof creativeLayouts[number];
export const creativeThemes = ['blue', 'forest', 'ink'] as const;
export type CreativeTheme = typeof creativeThemes[number];
export interface CreativePage {
  id: string;
  title: string;
  body: string;
  notes: string;
  layout: CreativeLayout;
  chart?: SlideData;
}
export interface CreativeRevision { id: string; savedAt: string; title: string; pages: CreativePage[]; theme: CreativeTheme; refs?: Evidence[]; attachments?: string[] }
export interface CreativeProject {
  id: string;
  title: string;
  brief: string;
  audience: string;
  pageCount: number;
  locale: Locale;
  theme: CreativeTheme;
  pages: CreativePage[];
  refs: Evidence[];
  attachments: string[];
  includeSources: boolean;
  createdAt: string;
  updatedAt: string;
  revisions: CreativeRevision[];
  sourceReport?: string;
}
export interface CreativeIntake { draft: OfficeDraft; refs: Evidence[]; locale: Locale; chart?: SlideData; brief?: string; sourceReport?: string }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const time = (value: unknown) => string(value) && Number.isFinite(Date.parse(value));

function chart(value: unknown): boolean {
  return object(value) && [value.title, value.series, value.source].every(string) && strings(value.labels)
    && Array.isArray(value.values) && value.values.length === value.labels.length && value.values.length > 0 && value.values.length <= 12
    && value.values.every(value => typeof value === 'number' && Number.isFinite(value));
}
function page(value: unknown): boolean {
  return object(value) && [value.id, value.title, value.body, value.notes].every(string)
    && creativeLayouts.some(layout => layout === value.layout) && (value.chart === undefined || chart(value.chart));
}
function pages(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 300 && value.every(page)
    && new Set(value.map(item => item.id)).size === value.length;
}
function references(value: unknown): boolean {
  return Array.isArray(value) && value.every(ref => object(ref) && string(ref.id) && string(ref.text)
    && Array.isArray(ref.locations) && ref.locations.every(location => object(location) && [location.file, location.path, location.at, location.excerpt].every(string)
      && (location.version === undefined || string(location.version)) && (location.materialId === undefined || string(location.materialId))));
}

export function validCreativeProject(value: unknown): value is CreativeProject {
  return object(value) && [value.id, value.title, value.brief, value.audience].every(string)
    && (value.sourceReport === undefined || string(value.sourceReport))
    && typeof value.pageCount === 'number' && Number.isInteger(value.pageCount) && value.pageCount >= 3 && value.pageCount <= 12
    && (value.locale === 'zh-CN' || value.locale === 'en-US') && creativeThemes.some(theme => theme === value.theme)
    && pages(value.pages) && Array.isArray(value.refs) && value.refs.every(ref => object(ref) && string(ref.id) && string(ref.text)
      && Array.isArray(ref.locations) && ref.locations.every(location => object(location) && [location.file, location.path, location.at, location.excerpt].every(string)
        && (location.version === undefined || string(location.version)) && (location.materialId === undefined || string(location.materialId))))
    && strings(value.attachments) && typeof value.includeSources === 'boolean' && time(value.createdAt) && time(value.updatedAt)
    && Array.isArray(value.revisions) && value.revisions.length <= 6 && value.revisions.every(revision => object(revision)
      && string(revision.id) && time(revision.savedAt) && string(revision.title) && pages(revision.pages) && creativeThemes.some(theme => theme === revision.theme)
      && (revision.refs === undefined || references(revision.refs)) && (revision.attachments === undefined || strings(revision.attachments)));
}

export function newCreativeProject(title: string, locale: Locale): CreativeProject {
  const date = new Date().toISOString();
  return { id: crypto.randomUUID(), title, brief: '', audience: '', pageCount: 6, locale, theme: 'blue', pages: [], refs: [],
    attachments: [], includeSources: true, createdAt: date, updatedAt: date, revisions: [] };
}

export function pagesFromDraft(draft: OfficeDraft, chart?: SlideData): CreativePage[] {
  const cover: CreativePage = { id: crypto.randomUUID(), title: draft.title, body: '', notes: '', layout: 'cover' };
  const pages: CreativePage[] = draft.sections.flatMap(section => paginateSlideBody(section.text).map((body, part) => ({
    id: crypto.randomUUID(), title: (section.heading || draft.title) + (part ? ' (' + (part + 1) + ')' : ''), body, notes: '', layout: 'content',
  })));
  if (chart) pages.splice(0, 0, { id: crypto.randomUUID(), title: chart.title, body: chart.source, notes: chart.source, layout: 'chart', chart });
  if (pages.length > 299) throw Error('creative_page_limit');
  return [cover, ...pages];
}

export function reviseCreativeProject(project: CreativeProject, patch: Partial<CreativeProject>): CreativeProject {
  const revision: CreativeRevision = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), title: project.title,
    pages: structuredClone(project.pages), theme: project.theme, refs: structuredClone(project.refs), attachments: project.attachments.slice() };
  return { ...project, ...patch, updatedAt: new Date().toISOString(), revisions: project.pages.length ? [revision, ...project.revisions].slice(0, 6) : project.revisions };
}

export function creativeExportPages(project: CreativeProject) {
  const pages = project.pages.slice();
  if (project.includeSources && project.refs.length) {
    const refs = project.refs.map(ref => '[' + ref.id + '] ' + ref.locations.map(location => location.file + ' · ' + location.at).join(' / ')).join('\n');
    for (const [index, body] of paginateSlideBody(refs).entries()) pages.push({
      id: 'sources-' + index, title: project.locale === 'zh-CN' ? '资料来源' : 'Sources', body, notes: '', layout: 'content',
    });
  }
  return pages;
}

export function creativeFindings(project: CreativeProject) {
  return project.pages.flatMap((page, index) => {
    const denseBody = page.layout === 'content' ? exceedsSlideBody(page.body)
      : page.body.length > 300 || page.body.split('\n').filter(Boolean).length > 6;
    const hardToRead = denseBody || creativeScene(page, project.theme, index, project.pages.length).shapes.some(({ text, height }) =>
      text?.value.trim() && (text.size < 11 || text.value.split('\n').length * text.size * 1.18 > height + 1));
    return [
      ...(page.title.length > 52 ? [{ page: index + 1, code: 'creativeLongTitle' }] : []),
      ...(hardToRead ? [{ page: index + 1, code: 'creativeDensePage' }] : []),
      ...(!page.title.trim() || page.layout !== 'cover' && !page.body.trim() && !page.chart ? [{ page: index + 1, code: 'creativeEmptyPage' }] : []),
      ...(page.layout === 'chart' && !page.chart ? [{ page: index + 1, code: 'creativeMissingChart' }] : []),
      ...(page.chart && page.chart.labels.some(label => !label.trim()) ? [{ page: index + 1, code: 'creativeMissingChart' }] : []),
    ];
  });
}
