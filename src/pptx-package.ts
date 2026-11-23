import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { chartNamespace, children, documentRelationships, drawing, element, packageRelationships, presentation, relatedPart, relationshipPart, relationships } from './openxml';
import { fitSlidePart } from './pptx-resize';
import { slideSize } from './slide-visual';

export const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const maximumDeckBytes = 32 * 1024 * 1024;
const maximumUnpackedBytes = 64 * 1024 * 1024;
const maximumParts = 3000;
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const coreProps = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const mainPath = 'ppt/presentation.xml';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
type Size = { width: number; height: number };
type PartLink = { id: string; type: string; target: string; external?: boolean };
interface PickedPage { source: number; page: number }

function xml(value: string | number) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]!);
}

function putLinks(links: PartLink[]) {
  const items = links.map(({ id, type, target, external }) => '<Relationship Id="' + xml(id)
    + '" Type="' + xml(type) + '" Target="' + xml(target) + '"' + (external ? ' TargetMode="External"' : '') + '/>');
  return strToU8(xmlHeader + '<Relationships xmlns="' + packageRelationships + '">' + items.join('') + '</Relationships>');
}

export function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const text = strFromU8(bytes);
  if (/<!DOCTYPE/i.test(text)) throw new Error('ppt_package_invalid');
  return new DOMParser().parseFromString(text, 'text/xml');
}

export function openDeck(bytes: ArrayBuffer) {
  if (bytes.byteLength > maximumDeckBytes) throw new Error('file_too_large');
  let unpacked = 0;
  let count = 0;
  const entries = unzipSync(new Uint8Array(bytes), { filter: part => {
    unpacked += part.originalSize;
    if (unpacked > maximumUnpackedBytes || ++count > maximumParts) throw new Error('file_too_large');
    return !part.name.endsWith('/');
  } });
  const parse = (path: string) => parseXml(entries[path]);
  const root = parse(mainPath)?.documentElement;
  if (root?.namespaceURI !== presentation || root.localName !== 'presentation') throw new Error('ppt_package_invalid');
  const types = parse('[Content_Types].xml')?.documentElement;
  if (!types) throw new Error('ppt_package_invalid');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const tag of children(types)) {
    const name = tag.localName === 'Override' ? tag.getAttribute('PartName')?.replace(/^\//, '') : tag.getAttribute('Extension')?.toLowerCase();
    const type = tag.getAttribute('ContentType');
    if (name && type) (tag.localName === 'Override' ? overrides : defaults).set(name, type);
  }
  const links = (part: string) => relationships(parse(relationshipPart(part)));
  const target = (part: string, value: string) => {
    const path = relatedPart(part, value);
    if (!path) return;
    if (entries[path]) return path;
    try {
      const decoded = decodeURIComponent(path);
      if (entries[decoded]) return decoded;
    } catch { return undefined; }
  };
  const mainLinks = links(mainPath);
  const pages = children(element(root, 'sldIdLst', presentation)).map(item => {
    const link = mainLinks.get(item.getAttributeNS(documentRelationships, 'id') ?? '');
    return link && !link.external ? target(mainPath, link.target) : undefined;
  });
  if (pages.length > 300) throw new Error('file_too_large');
  return {
    entries, parse, links, target, pages,
    size: slideSize(root) ?? { width: 9144000, height: 6858000 },
    notesSize: slideSizeForNotes(root),
    contentType: (part: string) => overrides.get(part) ?? overrides.get(encodeURI(part)) ?? defaults.get(part.split('.').at(-1)?.toLowerCase() ?? ''),
  };
}

function slideSizeForNotes(root: Element): Size {
  const size = element(root, 'notesSz', presentation);
  const width = Number(size?.getAttribute('cx'));
  const height = Number(size?.getAttribute('cy'));
  return width > 0 && height > 0 && width < 100000000 && height < 100000000
    ? { width, height } : { width: 6858000, height: 9144000 };
}

export function normalizeGeneratedDeck(bytes: ArrayBuffer) {
  const deck = openDeck(bytes);
  const main = deck.parse(mainPath);
  const root = main?.documentElement;
  const slides = element(root, 'sldIdLst', presentation);
  const notesMasters = element(root, 'notesMasterIdLst', presentation);
  const serializer = new XMLSerializer();
  // PptxGenJS can write the notes master list after the slides.
  if (main && root && slides && notesMasters && children(root).indexOf(notesMasters) > children(root).indexOf(slides)) {
    root.insertBefore(notesMasters, slides);
    deck.entries[mainPath] = strToU8(serializer.serializeToString(main));
  }
  for (const path of Object.keys(deck.entries).filter(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))) {
    const doc = deck.parse(path);
    const plot = doc?.getElementsByTagNameNS(chartNamespace, 'plotArea').item(0);
    if (!doc || !plot) continue;
    const axes = new Set(children(plot).filter(node => node.localName === 'catAx' || node.localName === 'valAx')
      .map(axis => element(axis, 'axId', chartNamespace)?.getAttribute('val')));
    let repaired = false;
    for (const chart of children(plot).filter(node => node.localName === 'barChart')) {
      const ids = children(chart).filter(node => node.localName === 'axId');
      const extra = ids.filter(node => !axes.has(node.getAttribute('val')));
      // A 2-D bar chart uses category and value axes. Older generated files may also reference an undefined series axis.
      if (extra.length && ids.length - extra.length === 2) {
        for (const node of extra) chart.removeChild(node);
        repaired = true;
      }
    }
    if (repaired) deck.entries[path] = strToU8(serializer.serializeToString(doc));
  }
  return zipSync(deck.entries, { level: 3 });
}

interface PageCopy {
  input: ReturnType<typeof openDeck>;
  number: number;
  original: string;
  destination: string;
  sourceIndex: number;
}

function slidePart(number: number) {
  return 'ppt/slides/slide' + number + '.xml';
}

function renamedPart(source: number, path: string) {
  const slash = path.lastIndexOf('/') + 1;
  return path.slice(0, slash) + 'reuse' + source + '-' + path.slice(slash);
}

export function assembleDeck(sources: ArrayBuffer[], selection: PickedPage[], title: string): { bytes: Uint8Array; count: number; fitted: number } {
  if (!selection.length || selection.length > 300) throw new Error('ppt_no_pages');
  const groups = new Map<number, { page: number; number: number }[]>();
  for (const [index, { source, page }] of selection.entries()) {
    const group = groups.get(source);
    const entry = { page, number: index + 1 };
    if (group) group.push(entry);
    else groups.set(source, [entry]);
  }
  const first = sources[selection[0]!.source];
  if (!first) throw new Error('ppt_package_invalid');
  let firstDeck: ReturnType<typeof openDeck> | undefined = openDeck(first);
  const canvas = firstDeck.size;
  const notesCanvas = firstDeck.notesSize;
  const entries = new Map<string, Uint8Array>();
  const overrides = new Map([[mainPath, 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml']]);
  const masters = new Set<string>();
  const copied = new Set<string>();
  const serializer = new XMLSerializer();
  let notesMaster: string | undefined;
  let layoutId = 2147487000;
  let rawSize = 0;
  let fitted = 0;
  function put(path: string, bytes: Uint8Array) {
    rawSize += bytes.byteLength;
    if (rawSize > maximumUnpackedBytes || entries.size >= maximumParts) throw new Error('export_limit');
    entries.set(path, bytes);
  }

  function copyPart(page: PageCopy, original: string, destination: string, aliases: Map<string, string>) {
    if (copied.has(destination)) return;
    if (copied.size >= maximumParts) throw new Error('export_limit');
    const { input, sourceIndex } = page;
    const bytes = input.entries[original];
    const contentType = input.contentType(original);
    if (!bytes || !contentType) throw new Error('ppt_dependency_missing');
    copied.add(destination);
    overrides.set(destination, contentType);
    const links: PartLink[] = [];
    const removed = new Set<string>();
    for (const [id, link] of input.links(original)) {
      if (link.external) { links.push({ id, ...link }); continue; }
      const kind = link.type.split('/').at(-1);
      const target = input.target(original, link.target);
      if (!target) throw new Error('ppt_dependency_missing');
      let mapped: string;
      if (kind === 'slide') {
        const retained = target === page.original ? page.destination : aliases.get(target);
        if (!retained) { removed.add(id); continue; }
        mapped = retained;
      } else if (kind === 'notesMaster' && notesMaster) {
        mapped = notesMaster;
      } else {
        mapped = kind === 'notesSlide' ? 'ppt/notesSlides/notesSlide' + page.number + '.xml' : renamedPart(sourceIndex, target);
        if (kind === 'notesMaster') notesMaster = mapped;
        copyPart(page, target, mapped, aliases);
      }
      links.push({ id, type: link.type, target: '/' + encodeURI(mapped) });
    }
    const master = contentType.endsWith('.slideMaster+xml');
    const layout = contentType.endsWith('.slideLayout+xml');
    const slide = contentType.endsWith('.slide+xml');
    const resized = canvas.width !== input.size.width || canvas.height !== input.size.height;
    if (master) masters.add(destination);
    let output = bytes;
    if (master || (resized && (layout || slide)) || removed.size) {
      const doc = input.parse(original);
      const root = doc?.documentElement;
      if (!doc || !root) throw new Error('ppt_package_invalid');
      if (master) {
        for (const node of children(element(root, 'sldLayoutIdLst', presentation))) node.setAttribute('id', String(layoutId++));
      }
      if (resized && (master || layout || slide)) fitSlidePart(root, input.size, canvas);
      if (removed.size) {
        const hyperlinks = [...Array.from(root.getElementsByTagNameNS(drawing, 'hlinkClick')), ...Array.from(root.getElementsByTagNameNS(drawing, 'hlinkMouseOver'))];
        for (const link of hyperlinks) {
          if (removed.has(link.getAttributeNS(documentRelationships, 'id') ?? '')) link.parentNode?.removeChild(link);
        }
      }
      output = strToU8(serializer.serializeToString(doc));
    }
    put(destination, output);
    if (links.length) put(relationshipPart(destination), putLinks(links));
  }

  // Process one source at a time so only the parts being kept stay in memory.
  for (const [sourceIndex, group] of groups) {
    const data = sources[sourceIndex];
    if (!data) throw new Error('ppt_package_invalid');
    const input = firstDeck ?? openDeck(data);
    firstDeck = undefined;
    const aliases = new Map<string, string>();
    const pages = group.map(({ page, number }): PageCopy => {
      const original = input.pages[page - 1];
      if (!original) throw new Error('ppt_page_missing');
      const destination = slidePart(number);
      if (!aliases.has(original)) aliases.set(original, destination);
      return { input, original, number, destination, sourceIndex };
    });
    if (canvas.width !== input.size.width || canvas.height !== input.size.height) fitted += pages.length;
    for (const page of pages) copyPart(page, page.original, page.destination, aliases);
  }

  const links: PartLink[] = [];
  function relate(kind: string, destination: string) {
    const id = 'rId' + (links.length + 1);
    links.push({ id, type: documentRelationships + '/' + kind, target: '/' + encodeURI(destination) });
    return id;
  }
  const masterIds = [...masters].map((part, index) => '<p:sldMasterId id="' + (2147483648 + index) + '" r:id="' + relate('slideMaster', part) + '"/>');
  const notesIds = notesMaster ? '<p:notesMasterIdLst><p:notesMasterId r:id="' + relate('notesMaster', notesMaster) + '"/></p:notesMasterIdLst>' : '';
  const slideIds = selection.map((_, index) => '<p:sldId id="' + (256 + index) + '" r:id="' + relate('slide', slidePart(index + 1)) + '"/>');
  const slides = '<p:sldIdLst>' + slideIds.join('') + '</p:sldIdLst>';
  const sizes = '<p:sldSz cx="' + canvas.width + '" cy="' + canvas.height + '"/><p:notesSz cx="' + notesCanvas.width + '" cy="' + notesCanvas.height + '"/>';
  put(mainPath, strToU8(xmlHeader + '<p:presentation xmlns:p="' + presentation + '" xmlns:r="' + documentRelationships + '" xmlns:a="' + drawing + '">'
    + '<p:sldMasterIdLst>' + masterIds.join('') + '</p:sldMasterIdLst>' + notesIds + slides + sizes + '</p:presentation>'));
  put(relationshipPart(mainPath), putLinks(links));
  put('_rels/.rels', putLinks([
    { id: 'rId1', type: documentRelationships + '/officeDocument', target: mainPath },
    { id: 'rId2', type: packageRelationships + '/metadata/core-properties', target: 'docProps/core.xml' },
  ]));
  put('docProps/core.xml', strToU8(xmlHeader + '<cp:coreProperties xmlns:cp="' + coreProps + '" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:title>' + xml(title) + '</dc:title><dc:creator>Office Workspace</dc:creator></cp:coreProperties>'));
  const contentTypes = [...overrides].map(([path, type]) => '<Override PartName="/' + xml(encodeURI(path)) + '" ContentType="' + xml(type) + '"/>');
  put('[Content_Types].xml', strToU8(xmlHeader + '<Types xmlns="' + contentTypesNamespace
    + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' + contentTypes.join('') + '</Types>'));
  const bytes = zipSync(Object.fromEntries(entries), { level: 3 });
  if (bytes.byteLength > maximumDeckBytes) throw new Error('export_limit');
  return { bytes, count: selection.length, fitted };
}
