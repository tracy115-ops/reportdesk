import type { Element } from '@xmldom/xmldom';
import { children, drawing, element, presentation } from './openxml';

type Size = { width: number; height: number };
const textAttributes: Record<string, readonly string[]> = {
  rPr: ['sz', 'spc'], defRPr: ['sz', 'spc'], endParaRPr: ['sz', 'spc'],
  bodyPr: ['lIns', 'rIns', 'tIns', 'bIns'], pPr: ['marL', 'marR', 'indent'],
  lvl1pPr: ['marL', 'marR', 'indent'], lvl2pPr: ['marL', 'marR', 'indent'], lvl3pPr: ['marL', 'marR', 'indent'],
  spcPts: ['val'], ln: ['w'], gridCol: ['w'], tr: ['h'], tcPr: ['marL', 'marR', 'marT', 'marB'],
};

function adjust(node: Element | undefined, attribute: string, scale: number, origin = 0) {
  const value = node?.getAttribute(attribute);
  if (value && Number.isFinite(Number(value))) node?.setAttribute(attribute, String(Math.round(Number(value) * scale + origin)));
}

function scaleText(root: Element, scale: number) {
  const descendants = root.getElementsByTagNameNS(drawing, '*');
  for (let index = 0; index < descendants.length; index++) {
    const node = descendants.item(index)!;
    for (const attribute of textAttributes[node.localName ?? ''] ?? []) adjust(node, attribute, scale);
  }
}

export function fitSlidePart(root: Element, source: Size, target: Size) {
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const left = (target.width - source.width * scale) / 2;
  const top = (target.height - source.height * scale) / 2;
  const tree = element(element(root, 'cSld', presentation), 'spTree', presentation);
  for (const shape of children(tree)) {
    const group = shape.localName === 'grpSp';
    const props = element(shape, group ? 'grpSpPr' : 'spPr', presentation);
    const xfrm = element(props, 'xfrm') ?? element(shape, 'xfrm', presentation);
    const off = element(xfrm, 'off');
    const ext = element(xfrm, 'ext');
    adjust(off, 'x', scale, left);
    adjust(off, 'y', scale, top);
    adjust(ext, 'cx', scale);
    adjust(ext, 'cy', scale);
    if (!group) scaleText(shape, scale);
  }
  const styles = element(root, 'txStyles', presentation);
  if (styles) scaleText(styles, scale);
}
