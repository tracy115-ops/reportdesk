import type { CreativePage, CreativeTheme } from './creative-project';
import type { SlideShape, SlideVisual } from './slide-visual';

export const creativePalettes = {
  blue: { paper: '#F7F9FE', dark: '#142B50', accent: '#3A61C9', muted: '#526584', line: '#CCD7EE', card: '#E9EEFC', ink: '#213451' },
  forest: { paper: '#F6F9F6', dark: '#173F35', accent: '#237B5D', muted: '#4C6C60', line: '#C9DDD2', card: '#E5F0E8', ink: '#253F34' },
  ink: { paper: '#FAF8F4', dark: '#292B32', accent: '#B16A22', muted: '#736959', line: '#DBD2C4', card: '#F1E8DB', ink: '#363430' },
} as const;

const slideTokens = /\[[SDTA]\d+\]|(?:https?:\/\/|www\.)[^\s]+|\d{4}(?:[-/]\d{1,2}){2}|[¥￥$€£]?[+−-]?\d+(?:[.,]\d+)*(?:e[+-]?\d+)?(?:%|个百分点|亿元|万元|万|元)?|[\p{Script=Latin}\d][\p{Script=Latin}\d_.'’/-]*|[^\S\r\n]+|[^\s]/giu;

export function slideTextTokens(text: string) {
  return text.match(slideTokens) ?? [];
}

export function wrapSlideText(text: string, width: number, size: number): string {
  const limit = width / size;
  const weight = (value: string) => [...value].reduce((sum, character) =>
    sum + (/[^\u0000-\u00ff]/.test(character) ? 1 : /[MW@#]/.test(character) ? .85 : .51), 0);
  return text.split('\n').map(line => {
    const lines: string[] = [];
    let current = '';
    let length = 0;
    const tokens = slideTextTokens(line).flatMap(token => weight(token) > limit ? [...token] : [token]);
    for (const token of tokens) {
      const size = weight(token);
      if (length + size > limit && current) {
        if (/^[，。！？、；：）》】」』,.!?;:%]$/.test(token) && [...current.trimEnd()].length > 1) {
          const prior = [...current.trimEnd()]; const carry = prior.pop()!;
          lines.push(prior.join('')); current = carry; length = weight(carry);
        } else { lines.push(current.trimEnd()); current = ''; length = 0; }
      }
      if (!current && !token.trim()) continue;
      current += token;
      length += size;
    }
    lines.push(current.trimEnd());
    return lines.join('\n');
  }).join('\n');
}

export function creativeScene(page: CreativePage, theme: CreativeTheme, index: number, count: number): SlideVisual {
  const palette = creativePalettes[theme];
  const shapes: SlideShape[] = [];
  const rect = (x: number, y: number, width: number, height: number, fill: string) => {
    shapes.push({ x, y, width, height, kind: 'rect', fill, strokeWidth: 0 });
  };
  const text = (value: string, x: number, y: number, width: number, height: number, size: number, color = palette.ink as string, bold = false) => {
    let fontSize = size;
    let wrapped = wrapSlideText(value, width, fontSize);
    if (wrapped.split('\n').length * fontSize * 1.18 > height) {
      let low = 2, high = size;
      for (let index = 0; index < 12; index++) {
        const candidate = (low + high) / 2;
        if (wrapSlideText(value, width, candidate).split('\n').length * candidate * 1.18 <= height) low = candidate;
        else high = candidate;
      }
      fontSize = Math.floor(low * 10) / 10;
      wrapped = wrapSlideText(value, width, fontSize);
    }
    shapes.push({ x, y, width, height, kind: 'rect', strokeWidth: 0,
      text: { value: wrapped, size: fontSize, bold, color, align: 'left', center: false, shrink: false } });
  };
  const lines = page.body.split(/\r?\n/).map(line => line.replace(/^\s*(?:-\s+|•\s*)/, '').trim()).filter(Boolean);
  if (page.layout === 'cover') {
    rect(0, 0, 960, 540, palette.dark);
    rect(58, 110, 65, 5, palette.accent);
    rect(790, 273, 23, 172, palette.accent); rect(831, 218, 23, 227, palette.line); rect(872, 158, 23, 287, palette.card);
    text(page.title, 58, 158, 665, 186, page.title.length > 34 ? 36 : 48, '#FFFFFF', true);
    if (page.body) text(page.body, 60, 365, 647, 98, 19, '#DCE6EE');
    rect(58, 486, 845, 1, palette.muted);
    return { width: 960, height: 540, background: palette.dark, shapes };
  }
  text(page.title, 48, 35, 860, 80, page.title.length > 40 ? 26 : 32, palette.dark, true);
  rect(48, 125, 864, 2, palette.line);
  text((index + 1) + ' / ' + count, 851, 506, 65, 19, 11, palette.muted);
  if (['metrics', 'steps', 'timeline'].includes(page.layout) && lines.length > 6) {
    text(lines.join('\n'), 58, 157, 826, 324, 19);
    return { width: 960, height: 540, background: palette.paper, shapes };
  }
  if (page.layout === 'statement') {
    rect(48, 155, 8, 290, palette.accent);
    text(page.body, 82, 170, 792, 274, page.body.length > 100 ? 28 : 38, palette.dark, true);
  } else if (page.layout === 'metrics') {
    const items = lines.length ? lines : [''];
    const cols = Math.min(3, items.length), rows = Math.ceil(items.length / cols);
    const width = (864 - (cols - 1) * 16) / cols, height = (326 - (rows - 1) * 14) / rows;
    for (const [position, line] of items.entries()) {
      const x = 48 + (position % cols) * (width + 16), y = 155 + Math.floor(position / cols) * (height + 14);
      const parts = line.split('|').map(value => value.trim());
      rect(x, y, width, height, palette.card); rect(x, y, width, 4, palette.accent);
      if (parts.length > 1) {
        text(parts[0]!, x + 20, y + 18, width - 40, 32, 15, palette.muted);
        text(parts[1]!, x + 20, y + 59, width - 40, rows > 1 ? 43 : 80, rows > 1 ? 32 : 46, palette.dark, true);
        const detailY = rows > 1 ? 110 : 163;
        if (parts.length > 2) text(parts.slice(2).join(' · '), x + 20, y + detailY, width - 40, height - detailY - 15, rows > 1 ? 12 : 16, palette.muted);
      } else text(line, x + 22, y + 32, width - 44, height - 62, items.length > 3 ? 19 : 25, palette.dark, true);
    }
  } else if (page.layout === 'columns' || page.layout === 'comparison') {
    const split = Math.ceil(lines.length / 2);
    for (const [column, content] of [lines.slice(0, split), lines.slice(split)].entries()) {
      const x = 48 + column * 444;
      rect(x, 155, 420, 326, palette.card);
      rect(x, 155, 420, 4, column === 0 ? palette.line : palette.accent);
      if (page.layout === 'comparison' && content.length) {
        text(content[0]!, x + 23, 181, 374, 79, 25, palette.dark, true);
        text(content.slice(1).join('\n\n'), x + 23, 279, 374, 171, 21);
      } else text(content.join('\n\n'), x + 23, 183, 374, 270, lines.join('').length > 200 ? 20 : 23);
    }
  } else if (page.layout === 'steps' || page.layout === 'timeline') {
    const steps = lines.length ? lines : [''];
    const cols = Math.min(3, steps.length), rows = Math.ceil(steps.length / cols);
    const width = (864 - (cols - 1) * 16) / cols, height = (310 - (rows - 1) * 14) / rows;
    for (const [position, line] of steps.entries()) {
      const x = 48 + position % cols * (width + 16), y = 163 + Math.floor(position / cols) * (height + 14);
      rect(x, y, width, height, palette.card);
      text(String(position + 1).padStart(2, '0'), x + 19, y + 18, 65, 33, rows > 1 ? 20 : 30, palette.accent, true);
      if (page.layout === 'timeline') rect(x + 20, y + 65, width - 40, 2, palette.accent);
      text(line, x + 19, y + (rows > 1 ? 56 : 97), width - 38, height - (rows > 1 ? 70 : 118), rows > 1 ? 16 : 22, palette.dark, true);
    }
  } else if (page.layout === 'chart' && page.chart) {
    shapes.push({ x: 48, y: 155, width: 864, height: 310, kind: 'chart', strokeWidth: 0,
      chart: { color: palette.accent, rows: page.chart.labels.map((label, position) => ({ label, value: page.chart!.values[position]! })) } });
    if (page.body) text(page.body, 48, 475, 782, 28, 12, palette.muted);
  } else {
    const body = lines.join('\n\n');
    text(body, 58, 157, 826, 324, body.length > 230 ? 21 : 25);
  }
  return { width: 960, height: 540, background: palette.paper, shapes };
}
