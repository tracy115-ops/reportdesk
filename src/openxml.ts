import type { Document, Element, Node } from '@xmldom/xmldom';

export const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const chartNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const documentRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const emuPerPoint = 12700;

export function children(node: Node | null | undefined): Element[] {
  return Array.from(node?.childNodes ?? []).filter((child): child is Element => child.nodeType === 1);
}

export function element(node: Node | null | undefined, name: string, namespace = drawing) {
  return children(node).find(child => child.localName === name && child.namespaceURI === namespace);
}

export function attributeNumber(node: Element | undefined, name: string): number {
  const value = node?.getAttribute(name);
  return value ? Number(value) : NaN;
}

export function shapeBounds(shape: Element) {
  const props = element(shape, shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr', presentation);
  const transform = element(props, 'xfrm') ?? element(shape, 'xfrm', presentation);
  const offset = element(transform, 'off');
  const extent = element(transform, 'ext');
  const [x, y, width, height] = [attributeNumber(offset, 'x'), attributeNumber(offset, 'y'), attributeNumber(extent, 'cx'), attributeNumber(extent, 'cy')];
  if (![x, y, width, height].every(value => Number.isFinite(value) && Math.abs(value) < 100000000) || width < 0 || height < 0) return;
  return { x, y, width, height, rotation: attributeNumber(transform, 'rot') || 0 };
}

interface Relationship { target: string; external: boolean; type: string }

export function relationships(document: Document | null) {
  const links = new Map<string, Relationship>();
  if (!document) return links;
  const entries = document.getElementsByTagNameNS(packageRelationships, 'Relationship');
  for (let index = 0; index < entries.length; index++) {
    const link = entries.item(index);
    const id = link?.getAttribute('Id');
    const target = link?.getAttribute('Target');
    const type = link?.getAttribute('Type');
    if (id && target && type) links.set(id, { target, type, external: link?.getAttribute('TargetMode') === 'External' });
  }
  return links;
}

export function relationshipPart(owner: string) {
  const slash = owner.lastIndexOf('/');
  return owner.slice(0, slash + 1) + '_rels/' + owner.slice(slash + 1) + '.rels';
}

export function relatedPart(owner: string, target: string) {
  if (/^[a-z]+:/i.test(target) || target.includes('\\')) return;
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
