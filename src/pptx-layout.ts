import type { Element } from '@xmldom/xmldom';
import { attributeNumber, children, documentRelationships, drawing, element, emuPerPoint, presentation, shapeBounds } from './openxml';
import { openDeck } from './pptx-package';
import { chartShape, readSlideVisual } from './slide-visual';
import type { SlideShape, SlideVisual } from './slide-visual';

const themeDefaults: Record<string, string> = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '203047', lt2: 'F1F2F4', accent1: '4472C4', accent2: 'ED7D31',
  accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};
const imageFormats: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
const aliasDefaults: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

function rgbOf(color: Element | undefined, palette: Record<string, string>, alias: Record<string, string>) {
  if (!color) return;
  const key = color.getAttribute('val') ?? '';
  let rgb = color.localName === 'schemeClr' ? palette[alias[key] ?? key] : color.localName === 'sysClr' ? color.getAttribute('lastClr') : key;
  if (!rgb || !/^[\da-f]{6}$/i.test(rgb)) return;
  const tint = attributeNumber(element(color, 'tint'), 'val');
  const shade = attributeNumber(element(color, 'shade'), 'val');
  const lumMod = attributeNumber(element(color, 'lumMod'), 'val');
  const lumOff = attributeNumber(element(color, 'lumOff'), 'val');
  const alpha = attributeNumber(element(color, 'alpha'), 'val');
  if ([tint, shade, lumMod, lumOff].some(Number.isFinite)) {
    rgb = rgb.match(/../g)!.map(channel => {
      let value = parseInt(channel, 16);
      if (Number.isFinite(tint)) value += (255 - value) * tint / 100000;
      if (Number.isFinite(shade)) value *= shade / 100000;
      if (Number.isFinite(lumMod)) value *= lumMod / 100000;
      if (Number.isFinite(lumOff)) value += 255 * lumOff / 100000;
      return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
    }).join('');
  }
  return '#' + rgb + (Number.isFinite(alpha) ? Math.round(Math.min(100000, Math.max(0, alpha)) * 255 / 100000).toString(16).padStart(2, '0') : '');
}

function tree(root?: Element | null) {
  return element(element(root, 'cSld', presentation), 'spTree', presentation);
}

function background(root?: Element | null) {
  return element(element(root, 'cSld', presentation), 'bg', presentation);
}

function placeholder(shape: Element) {
  const ph = shape.getElementsByTagNameNS(presentation, 'ph').item(0);
  return ph ? { index: ph.getAttribute('idx'), type: ph.getAttribute('type') || 'body' } : undefined;
}

function matchPlaceholder(shape: Element, owner?: Element | null) {
  const ph = placeholder(shape);
  if (!ph) return;
  return children(tree(owner)).find(node => {
    const candidate = placeholder(node);
    return candidate && (ph.index !== null && candidate.index === ph.index || candidate.type === ph.type);
  });
}

function paragraphText(box: Element | undefined) {
  const paragraphs = children(box).filter(child => child.localName === 'p' && child.namespaceURI === drawing);
  return paragraphs.map(paragraph => children(paragraph).map(item => item.localName === 'br' ? '\n' : element(item, 't')?.textContent ?? '').join(''))
    .join('\n').slice(0, 10000);
}

export function previewDeckPage(bytes: ArrayBuffer, page: number): SlideVisual {
  const input = openDeck(bytes);
  const part = input.pages[page - 1];
  if (!part) throw new Error('ppt_page_missing');
  const root = input.parse(part)?.documentElement;
  if (!root) throw new Error('ppt_package_invalid');
  const target = (owner: string, role: string) => {
    const link = [...input.links(owner).values()].find(link => link.type.endsWith('/' + role) && !link.external);
    return link ? input.target(owner, link.target) : undefined;
  };
  const layoutPart = target(part, 'slideLayout');
  const masterPart = layoutPart ? target(layoutPart, 'slideMaster') : undefined;
  const themePart = masterPart ? target(masterPart, 'theme') : undefined;
  const layout = layoutPart ? input.parse(layoutPart)?.documentElement : undefined;
  const master = masterPart ? input.parse(masterPart)?.documentElement : undefined;
  const theme = themePart ? input.parse(themePart)?.documentElement : undefined;
  const palette = { ...themeDefaults };
  for (const swatch of children(element(element(theme, 'themeElements'), 'clrScheme'))) {
    const color = rgbOf(children(swatch)[0], palette, {});
    if (swatch.localName && color) palette[swatch.localName] = color.slice(1, 7);
  }
  const map = { ...aliasDefaults };
  for (const mapping of [element(master, 'clrMap', presentation), element(element(layout, 'clrMapOvr', presentation), 'overrideClrMapping'),
    element(element(root, 'clrMapOvr', presentation), 'overrideClrMapping')]) {
    for (const attribute of Array.from(mapping?.attributes ?? [])) map[attribute.name] = attribute.value;
  }
  const fill = (node?: Element | null) => rgbOf(children(element(node, 'solidFill'))[0], palette, map);
  const fillBackground = (node?: Element) => fill(element(node, 'bgPr', presentation)) ?? rgbOf(children(element(node, 'bgRef', presentation))[0], palette, map);
  const approximate = readSlideVisual(root, input.size, id => {
    const link = input.links(part).get(id);
    const path = link && !link.external ? input.target(part, link.target) : undefined;
    return path ? input.parse(path)?.documentElement ?? undefined : undefined;
  });
  if (approximate) return approximate;
  const shapes: SlideShape[] = [];
  type Transform = { x: number; y: number; sx: number; sy: number };
  function walk(owner: string, nodes: Element[], transform: Transform, inherited = false) {
    const links = input.links(owner);
    for (const node of nodes) {
      if (shapes.length >= 240) break;
      const type = node.localName;
      if (inherited && placeholder(node)) continue;
      const inheritedLayout = !inherited ? matchPlaceholder(node, layout) : undefined;
      const inheritedMaster = !inherited ? matchPlaceholder(inheritedLayout ?? node, master) : undefined;
      const box = shapeBounds(node) ?? (inheritedLayout && shapeBounds(inheritedLayout)) ?? (inheritedMaster && shapeBounds(inheritedMaster));
      if (!box || !['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'].includes(type ?? '')) continue;
      const x = box.x * transform.sx + transform.x;
      const y = box.y * transform.sy + transform.y;
      const width = box.width * transform.sx;
      const height = box.height * transform.sy;
      const common = { x, y, width, height, rotation: box.rotation / 60000, strokeWidth: 0 };
      if (type === 'grpSp') {
        const xfrm = element(element(node, 'grpSpPr', presentation), 'xfrm');
        const childPosition = element(xfrm, 'chOff');
        const childSize = element(xfrm, 'chExt');
        const w = attributeNumber(childSize, 'cx');
        const h = attributeNumber(childSize, 'cy');
        if (!(w > 0 && h > 0)) continue;
        const sx = width / w;
        const sy = height / h;
        walk(owner, children(node), { x: x - (attributeNumber(childPosition, 'x') || 0) * sx, y: y - (attributeNumber(childPosition, 'y') || 0) * sy, sx, sy });
        continue;
      }
      if (type === 'pic') {
        const blipFill = element(node, 'blipFill', presentation);
        const blip = element(blipFill, 'blip');
        const link = links.get(blip?.getAttributeNS(documentRelationships, 'embed') ?? '');
        const path = link && !link.external ? input.target(owner, link.target) : undefined;
        if (!path) continue;
        const mime = imageFormats[path.split('.').at(-1)?.toLowerCase() ?? ''];
        const data = input.entries[path];
        if (!mime || !data || data.byteLength > 12 * 1024 * 1024) continue;
        const edges = element(blipFill, 'srcRect');
        const edge = (name: string) => Math.max(0, Math.min(.9, (attributeNumber(edges, name) || 0) / 100000));
        shapes.push({ ...common, kind: 'picture', picture: new Blob([new Uint8Array(data)], { type: mime }),
          crop: { left: edge('l'), top: edge('t'), right: edge('r'), bottom: edge('b') } });
        continue;
      }
      if (type === 'graphicFrame') {
        const table = node.getElementsByTagNameNS(drawing, 'tbl').item(0);
        if (table) {
          const cells = children(table).filter(row => row.localName === 'tr').slice(0, 50).map(row =>
            children(row).filter(cell => cell.localName === 'tc').slice(0, 35).map(cell => {
              const textBox = element(cell, 'txBody');
              const paragraph = element(textBox, 'p');
              const color = fill(element(element(paragraph, 'r'), 'rPr')) ?? fill(element(element(paragraph, 'pPr'), 'defRPr'));
              return { text: paragraphText(textBox).slice(0, 500), fill: fill(element(cell, 'tcPr')), color };
            }));
          shapes.push({ ...common, kind: 'table', cells });
        } else {
          const chart = chartShape(node, id => {
            const link = links.get(id);
            const path = link && !link.external ? input.target(owner, link.target) : undefined;
            return path ? input.parse(path)?.documentElement ?? undefined : undefined;
          });
          if (chart) shapes.push({ ...chart, ...common });
        }
        continue;
      }
      const props = element(node, 'spPr', presentation);
      const line = element(props, 'ln');
      const preset = element(props, 'prstGeom')?.getAttribute('prst');
      const textBox = element(node, 'txBody', presentation);
      const text = paragraphText(textBox);
      const kind = type === 'cxnSp' || preset === 'line' ? 'line' : preset === 'ellipse' ? 'ellipse' : preset === 'roundRect' ? 'roundRect' : 'rect';
      const color = fill(props);
      const border = fill(line);
      if (!text && !color && !border && kind === 'rect') continue;
      const shape: SlideShape = { ...common, kind, fill: color, stroke: border ?? (kind === 'line' ? '#708075' : undefined),
        strokeWidth: (attributeNumber(line, 'w') || emuPerPoint) * transform.sx };
      if (text.trim()) {
        const paragraph = element(textBox, 'p');
        const paragraphStyle = element(paragraph, 'pPr');
        const mark = element(element(paragraph, 'r'), 'rPr') ?? element(paragraphStyle, 'defRPr')
          ?? inheritedLayout?.getElementsByTagNameNS(drawing, 'defRPr').item(0) ?? undefined;
        const role = placeholder(node)?.type;
        const size = (attributeNumber(mark, 'sz') || (role === 'title' || role === 'ctrTitle' ? 3200 : 1800)) * emuPerPoint * transform.sy / 100;
        const align = paragraphStyle?.getAttribute('algn');
        const body = element(textBox, 'bodyPr');
        shape.text = { value: text, size, color: fill(mark) ?? '#' + palette[map.tx1 ?? 'dk1'],
          bold: mark?.getAttribute('b') === '1', align: align === 'ctr' ? 'center' : align === 'r' ? 'right' : 'left',
          center: body?.getAttribute('anchor') === 'ctr', shrink: true };
      }
      shapes.push(shape);
    }
  }

  const normal = { x: 0, y: 0, sx: 1, sy: 1 };
  if (root.getAttribute('showMasterSp') !== '0') {
    if (masterPart && layout?.getAttribute('showMasterSp') !== '0') walk(masterPart, children(tree(master)), normal, true);
    if (layoutPart) walk(layoutPart, children(tree(layout)), normal, true);
  }
  walk(part, children(tree(root)), normal);
  return { ...input.size, background: fillBackground(background(root)) ?? fillBackground(background(layout)) ?? fillBackground(background(master)) ?? '#FFFFFF',
    shapes, approximate: true };
}
