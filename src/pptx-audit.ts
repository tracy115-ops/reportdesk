import type { Element } from '@xmldom/xmldom';
import { attributeNumber, children, documentRelationships, drawing, element, emuPerPoint, presentation, relatedPart, shapeBounds } from './openxml';
import type { relationships } from './openxml';

export type SlideFindingCode = 'missingSlidePart' | 'missingMedia' | 'linkedMedia' | 'outsideSlide' | 'smallType' | 'textMayOverflow' | 'emptySlide';
export interface SlideFinding {
  page: number;
  code: SlideFindingCode;
  object?: string;
  size?: number;
}

export const pptxRules = {
  missingSlidePart: { severity: 'error', fix: 'restoreSlidePart' },
  missingMedia: { severity: 'error', fix: 'replaceMedia' },
  linkedMedia: { severity: 'info', fix: 'embedMedia' },
  outsideSlide: { severity: 'warning', fix: 'positionObject' },
  smallType: { severity: 'warning', fix: 'increaseType' },
  textMayOverflow: { severity: 'warning', fix: 'resizeTextBox' },
  emptySlide: { severity: 'info', fix: 'reviewBlankSlide' },
} as const;
export const maxFontCheck = 24;

function outside(box: NonNullable<ReturnType<typeof shapeBounds>>, slide: { width: number; height: number }) {
  const angle = box.rotation / 60000 * Math.PI / 180;
  const rotatedWidth = Math.abs(box.width * Math.cos(angle)) + Math.abs(box.height * Math.sin(angle));
  const rotatedHeight = Math.abs(box.width * Math.sin(angle)) + Math.abs(box.height * Math.cos(angle));
  const left = box.x + (box.width - rotatedWidth) / 2;
  const top = box.y + (box.height - rotatedHeight) / 2;
  const tolerance = 2 * emuPerPoint;
  return left < -tolerance || top < -tolerance || left + rotatedWidth > slide.width + tolerance || top + rotatedHeight > slide.height + tolerance;
}

function objectName(shape: Element) {
  return shape.getElementsByTagNameNS(presentation, 'cNvPr').item(0)?.getAttribute('name')?.slice(0, 140) || undefined;
}

function typeSize(shape: Element) {
  const runs = shape.getElementsByTagNameNS(drawing, 'r');
  let smallest = Infinity;
  for (let index = 0; index < runs.length; index++) {
    const run = runs.item(index);
    const text = element(run, 't')?.textContent?.trim() ?? '';
    if (!text || /^\d{1,4}$/.test(text)) continue;
    const explicit = attributeNumber(element(run, 'rPr'), 'sz');
    const inherited = attributeNumber(element(element(run?.parentNode, 'pPr'), 'defRPr'), 'sz');
    const point = (Number.isFinite(explicit) ? explicit : inherited) / 100;
    if (point > 0) smallest = Math.min(smallest, point);
  }
  return smallest;
}

function mayOverflow(shape: Element, box: ReturnType<typeof shapeBounds>) {
  const textBox = element(shape, 'txBody', presentation);
  const body = element(textBox, 'bodyPr');
  if (!box?.width || !box.height || box.rotation || !body || element(body, 'normAutofit') || element(body, 'spAutoFit')
    || body.hasAttribute('vert') || body.getAttribute('wrap') === 'none') return false;
  const inset = (key: string, fallback: number) => body.hasAttribute(key) ? attributeNumber(body, key) : fallback;
  const width = box.width - inset('lIns', 91440) - inset('rIns', 91440);
  const height = box.height - inset('tIns', 45720) - inset('bIns', 45720);
  if (width <= 0 || height <= 0) return false;
  let estimated = 0;
  for (const paragraph of children(textBox).filter(child => child.localName === 'p')) {
    let measure = 0;
    let tall = 0;
    const fallback = attributeNumber(element(element(paragraph, 'pPr'), 'defRPr'), 'sz');
    for (const run of children(paragraph).filter(child => child.localName === 'r')) {
      const text = element(run, 't')?.textContent ?? '';
      const length = [...text].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 0.88 : 0.44), 0);
      const size = (attributeNumber(element(run, 'rPr'), 'sz') || fallback) * emuPerPoint / 100;
      if (!Number.isFinite(size) || size <= 0) continue;
      measure += length * size;
      tall = Math.max(tall, size);
    }
    estimated += tall * Math.ceil(measure / width);
  }
  return estimated > height * 1.1;
}

export function inspectSlide(root: Element, page: number, part: string, slideSize: { width: number; height: number } | undefined,
  parts: Set<string>, links: ReturnType<typeof relationships>, text: string) {
  const findings: SlideFinding[] = [];
  const canvas = element(element(root, 'cSld', presentation), 'spTree', presentation);
  const objects = children(canvas).filter(child => ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp', 'contentPart'].includes(child.localName ?? ''));
  if (!objects.length && !text) findings.push({ page, code: 'emptySlide' });
  for (const shape of objects) {
    const object = objectName(shape);
    const box = shapeBounds(shape);
    if (box && slideSize && outside(box, slideSize)) findings.push({ page, code: 'outsideSlide', object });
    const size = typeSize(shape);
    if (size < maxFontCheck) findings.push({ page, code: 'smallType', object, size });
    if (mayOverflow(shape, box)) findings.push({ page, code: 'textMayOverflow', object });
    const pictures = shape.getElementsByTagNameNS(drawing, 'blip');
    const media = new Set<SlideFindingCode>();
    for (let index = 0; index < pictures.length; index++) {
      const picture = pictures.item(index);
      const id = picture?.getAttributeNS(documentRelationships, 'embed') || picture?.getAttributeNS(documentRelationships, 'link');
      if (!id) continue;
      const link = links.get(id);
      const target = link && relatedPart(part, link.target);
      if (link?.external) media.add('linkedMedia');
      else if (!target || !parts.has(target)) media.add('missingMedia');
    }
    for (const code of media) findings.push({ page, code, object });
  }
  return findings;
}
