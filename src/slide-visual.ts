import type { Element, Node } from '@xmldom/xmldom';
import { attributeNumber as number, chartNamespace, children, documentRelationships, element, emuPerPoint, presentation, shapeBounds } from './openxml';

export interface SlideShape {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'chart' | 'picture' | 'table';
  fill?: string;
  stroke?: string;
  strokeWidth: number;
  rotation?: number;
  text?: { value: string; size: number; bold: boolean; color: string; align: 'left' | 'center' | 'right'; center: boolean; shrink: boolean };
  chart?: { color: string; rows: { label: string; value: number }[] };
  picture?: Blob;
  crop?: { left: number; top: number; right: number; bottom: number };
  cells?: { text: string; fill?: string; color?: string }[][];
}

export interface SlideVisual {
  width: number;
  height: number;
  background: string;
  shapes: SlideShape[];
  approximate?: boolean;
}

function color(node: Element | undefined) {
  const rgb = element(element(node, 'solidFill'), 'srgbClr');
  const value = rgb?.getAttribute('val') ?? '';
  if (!/^[\da-f]{6}$/i.test(value)) return;
  const opacity = element(rgb, 'alpha')?.getAttribute('val');
  const alpha = opacity ? Math.round(Math.max(0, Math.min(100000, Number(opacity))) * 255 / 100000) : 255;
  if (Number.isFinite(alpha)) return '#' + value + alpha.toString(16).padStart(2, '0');
}

function shape(node: Element): SlideShape | undefined {
  const style = element(node, 'spPr', presentation);
  const transform = element(style, 'xfrm');
  if (!transform || transform.hasAttribute('rot') || transform.hasAttribute('flipH') || transform.hasAttribute('flipV')) return;
  const bounds = shapeBounds(node);
  if (!bounds) return;
  const kind = element(style, 'prstGeom')?.getAttribute('prst');
  if (kind !== 'rect' && kind !== 'roundRect' && kind !== 'line') return;
  const outline = element(style, 'ln');
  const result: SlideShape = { ...bounds, kind, fill: color(style), stroke: color(outline), strokeWidth: number(outline, 'w') || 0 };
  const textBox = element(node, 'txBody', presentation);
  if (!textBox) return result;
  const paragraphs = children(textBox).filter(child => child.localName === 'p');
  const value = paragraphs.map(paragraph => children(paragraph).map(item => item.localName === 'br' ? '\n' : element(item, 't')?.textContent ?? '').join('')).join('\n');
  if (!value.trim()) return result;
  const first = paragraphs.find(paragraph => children(paragraph).some(item => item.localName === 'r'));
  const run = element(element(first, 'r'), 'rPr');
  const body = element(textBox, 'bodyPr');
  const align = element(first, 'pPr')?.getAttribute('algn');
  result.text = { value, size: (number(run, 'sz') || 1800) * emuPerPoint / 100,
    color: color(run) ?? '#000', bold: run?.getAttribute('b') === '1', align: align === 'r' ? 'right' : align === 'ctr' ? 'center' : 'left',
    center: body?.getAttribute('anchor') === 'ctr', shrink: Boolean(element(body, 'normAutofit')) };
  return result;
}

export function chartShape(frame: Element, readPart: (id: string) => Element | undefined): SlideShape | undefined {
  const reference = frame.getElementsByTagNameNS(chartNamespace, 'chart').item(0)?.getAttributeNS(documentRelationships, 'id');
  const content = reference ? readPart(reference) : undefined;
  const box = shapeBounds(frame);
  if (!content || !box || box.rotation !== 0) return;
  const bar = content.getElementsByTagNameNS(chartNamespace, 'barChart').item(0);
  const series = bar?.getElementsByTagNameNS(chartNamespace, 'ser');
  if (series?.length !== 1 || element(bar, 'barDir', chartNamespace)?.getAttribute('val') !== 'bar') return;
  const data = series.item(0)!;
  const labels = element(data, 'cat', chartNamespace)?.getElementsByTagNameNS(chartNamespace, 'pt');
  const values = element(data, 'val', chartNamespace)?.getElementsByTagNameNS(chartNamespace, 'pt');
  if (!labels?.length || labels.length > 12 || labels.length !== values?.length) return;
  const rows = [];
  for (let index = 0; index < labels.length; index++) {
    const label = element(labels.item(index), 'v', chartNamespace)?.textContent;
    const raw = element(values.item(index), 'v', chartNamespace)?.textContent;
    const value = Number(raw);
    if (!label || !raw || !Number.isFinite(value)) return;
    rows.push({ label, value });
  }
  return { ...box, kind: 'chart', strokeWidth: 0, chart: { rows, color: color(element(data, 'spPr', chartNamespace)) ?? '#166B54' } };
}

export function slideSize(root: Node) {
  const size = element(root, 'sldSz', presentation);
  const width = number(size, 'cx');
  const height = number(size, 'cy');
  return width > 0 && height > 0 && width < 100000000 && height < 100000000 ? { width, height } : undefined;
}

export function readSlideVisual(root: Node, size: Pick<SlideVisual, 'width' | 'height'>, readPart: (id: string) => Element | undefined): SlideVisual | undefined {
  const slide = element(root, 'cSld', presentation);
  const background = color(element(element(slide, 'bg', presentation), 'bgPr', presentation));
  const shapes = children(element(slide, 'spTree', presentation)).filter(node => node.localName !== 'nvGrpSpPr' && node.localName !== 'grpSpPr');
  if (!background || shapes.length > 150) return;
  const parsed: SlideShape[] = [];
  for (const item of shapes) {
    if (item.namespaceURI !== presentation) return;
    const object = item.localName === 'sp' ? shape(item) : item.localName === 'graphicFrame' ? chartShape(item, readPart) : undefined;
    if (!object) return;
    parsed.push(object);
  }
  return { ...size, background, shapes: parsed };
}
