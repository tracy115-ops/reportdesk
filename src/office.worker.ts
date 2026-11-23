import { DOMParser, type Node as XmlNode } from '@xmldom/xmldom';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import type { Cell, MaterialKind, Note, NoteKind, ParagraphText, Parsed, Sheet } from './domain';
import { reportingField } from './report-period';
import { readSlideVisual, slideSize } from './slide-visual';
import type { SlideVisual } from './slide-visual';
import { children, documentRelationships, drawing, element, presentation, relatedPart, relationshipPart, relationships } from './openxml';
import { inspectSlide } from './pptx-audit';
import type { SlideFinding } from './pptx-audit';
import type { PresentationPage } from './domain';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_PARTS = 3000;

function inspect(bytes: Uint8Array, wanted?: string) {
  let size = 0;
  let count = 0;
  return unzipSync(bytes, { filter: entry => {
    size += entry.originalSize;
    count++;
    if (size > MAX_UNPACKED || count > MAX_PARTS) throw new Error('file_too_large');
    return entry.name === wanted;
  } });
}

function visibleText(node: XmlNode): string {
  if (node.nodeType === 1) {
    const name = node.nodeName.split(':').at(-1);
    if (name === 'del' || name === 'moveFrom' || name === 'instrText') return '';
    if (name === 't') return node.textContent ?? '';
    if (name === 'tab' || name === 'br') return ' ';
  }
  let text = '';
  for (let child = node.firstChild; child; child = child.nextSibling) text += visibleText(child);
  return text;
}

const groups: [NoteKind, RegExp][] = [
  ['progress', /^(本期进展|本周进展|本周完成|完成事项|工作进展|进展|重点成果|成果|progress|highlights|accomplishments)$/i],
  ['risks', /^(风险与问题|风险及问题|风险|问题|阻塞|需协调|需要协调|risks?( and issues)?|issues?|blockers?)$/i],
  ['next', /^(下周计划|下月计划|下期计划|下步计划|下一步|接下来|计划|next steps|next week|next month|plan)$/i],
];

function parseWord(bytes: Uint8Array): Parsed {
  const xml = inspect(bytes, 'word/document.xml')['word/document.xml'];
  if (!xml) throw new Error('file_parse');
  const document = new DOMParser().parseFromString(strFromU8(xml), 'text/xml');
  const body = document.getElementsByTagNameNS(WORD, 'body').item(0);
  if (!body) throw new Error('file_parse');
  const paragraphs = body.getElementsByTagNameNS(WORD, 'p');
  if (paragraphs.length > 5000) throw new Error('file_too_large');
  const content: ParagraphText[] = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const node = paragraphs.item(index)!;
    const text = visibleText(node).replace(/\s+/g, ' ').trim().slice(0, 8000);
    if (!text) continue;
    const style = node.getElementsByTagNameNS(WORD, 'pStyle').item(0)?.getAttributeNS(WORD, 'val') ?? '';
    content.push({ paragraph: index + 1, text, heading: /heading|title|^\d$/i.test(style) });
  }
  return documentContent(content);
}

function documentContent(paragraphs: ParagraphText[]): Parsed {
  if (!paragraphs.length) throw new Error('empty_document');
  const notes: Note[] = [];
  let kind: NoteKind = 'progress';
  for (const paragraph of paragraphs) {
    let text = paragraph.text;
    const heading = text.replace(/^(?:#{1,6}\s+|\d{1,2}[.、)]|[一二三四五六七八九十]+、)\s*/, '');
    const split = /^([^:：]{1,32})[:：]\s*(.*)$/.exec(heading);
    if (reportingField(text) || /^(汇报人|上报人|author)$/i.test(split?.[1]?.trim() ?? '')) continue;
    const category = groups.find(([, pattern]) => pattern.test((split?.[1] ?? heading).trim()));
    if (category) {
      kind = category[0];
      text = split?.[2]?.trim() ?? '';
    }
    if (text) notes.push({ text: text.slice(0, 1600), paragraph: paragraph.paragraph, kind });
  }
  return { kind: 'docx', paragraphs, notes };
}

function textFromBytes(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}

function parseText(bytes: Uint8Array): Parsed {
  const lines = textFromBytes(bytes).split(/\r\n|\n|\r/);
  if (lines.length > 20_000) throw new Error('file_too_large');
  return documentContent(lines.flatMap((line, index) => {
    const text = line.trim().slice(0, 8000);
    return text ? [{ paragraph: index + 1, text, heading: /^#{1,6}\s/.test(text) }] : [];
  }));
}

function parseCsv(bytes: Uint8Array): Parsed {
  const rows: Sheet['rows'] = [];
  let number = 0;
  let count = 0;
  let failure: string | undefined;
  Papa.parse<string[]>(textFromBytes(bytes), {
    delimiter: '', delimitersToGuess: [',', '\t', ';'],
    step(result, parser) {
      number++;
      count += result.data.length;
      if (number > 25_000 || count > 220_000 || result.data.length > 16_384) failure = 'file_too_large';
      if (result.errors.some(error => error.type === 'Quotes')) failure = 'file_parse';
      if (failure) { parser.abort(); return; }
      const cells = Object.fromEntries(result.data.flatMap((value, index) => value !== '' ? [[index + 1, value.slice(0, 1600)]] : []));
      if (Object.keys(cells).length) rows.push({ number, cells });
    },
  });
  if (failure) throw new Error(failure);
  if (!rows.length) throw new Error('empty_document');
  return { kind: 'xlsx', sheets: [{ name: 'CSV', rows }] };
}

function plainCell(input: unknown): Cell | undefined {
  if (input instanceof Date) return Number.isFinite(input.valueOf()) ? input.toISOString().slice(0, 10) : undefined;
  if (typeof input === 'string') return input.slice(0, 1600);
  if (typeof input === 'number') return input;
  if (typeof input === 'boolean') return String(input);
  if (!input || typeof input !== 'object') return;
  if ('formula' in input || 'sharedFormula' in input) return plainCell('result' in input ? input.result : undefined);
  if ('richText' in input && Array.isArray(input.richText)) return input.richText.map(item => item.text).join('').slice(0, 1600);
  if ('text' in input && typeof input.text === 'string') return input.text.slice(0, 1600);
}

function parseSlides(bytes: Uint8Array): Parsed {
  let size = 0;
  const parts = new Set<string>();
  let count = 0;
  const archive = unzipSync(bytes, { filter: entry => {
    parts.add(entry.name);
    size += entry.originalSize;
    if (size > MAX_UNPACKED || ++count > MAX_PARTS) throw new Error('file_too_large');
    return entry.name === 'docProps/core.xml' || /^ppt\/(slides\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?|(?:charts|notesSlides)\/[^/]+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(entry.name);
  } });
  const parse = (path: string) => {
    const file = archive[path];
    return file ? new DOMParser().parseFromString(strFromU8(file), 'text/xml') : null;
  };
  const mainPart = 'ppt/presentation.xml';
  const root = parse(mainPart);
  if (!root?.documentElement) throw new Error('file_parse');
  const links = relationships(parse('ppt/_rels/presentation.xml.rels'));
  const author = parse('docProps/core.xml')?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator').item(0)?.textContent;
  const dimensions = slideSize(root.documentElement);
  const ids = root.getElementsByTagNameNS(presentation, 'sldId');
  if (ids.length > 300) throw new Error('file_too_large');
  const pages: PresentationPage[] = [];
  const findings: SlideFinding[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids.item(i)!.getAttributeNS(documentRelationships, 'id');
    const link = links.get(id ?? '');
    const part = link && !link.external ? relatedPart(mainPart, link.target) : undefined;
    const slide = part ? parse(part) : null;
    const page = i + 1;
    if (!part || !slide?.documentElement || slide.documentElement.namespaceURI !== presentation) {
      findings.push({ page, code: 'missingSlidePart' });
      continue;
    }
    const paragraphs = slide.getElementsByTagNameNS(drawing, 'p');
    const lines: string[] = [];
    for (let p = 0; p < paragraphs.length; p++) {
      const line = visibleText(paragraphs.item(p)!).trim();
      if (line) lines.push(line);
    }
    const text = lines.join('\n').slice(0, 10000);
    const slideLinks = relationships(parse(relationshipPart(part)));
    const visual = author === 'Office Workspace' && dimensions ? readSlideVisual(slide.documentElement, dimensions, id => {
      const link = slideLinks.get(id);
      const target = link && !link.external ? relatedPart(part, link.target) : undefined;
      return target ? parse(target)?.documentElement ?? undefined : undefined;
    }) : undefined;
    findings.push(...inspectSlide(slide.documentElement, page, part, dimensions, parts, slideLinks, text));
    const chartText = visual?.shapes.flatMap(shape => shape.chart?.rows.map(row => row.label + '  ' + row.value) ?? []).join('\n');
    const tree = element(element(slide.documentElement, 'cSld', presentation), 'spTree', presentation);
    const titleShape = children(tree).find(node => {
      const role = node.getElementsByTagNameNS(presentation, 'ph').item(0)?.getAttribute('type');
      return role === 'title' || role === 'ctrTitle';
    });
    const title = (titleShape ? visibleText(titleShape).trim() : lines[0]?.trim())?.slice(0, 150);
    const notesLink = [...slideLinks.values()].find(link => !link.external && link.type.endsWith('/notesSlide'));
    const notesPart = notesLink && relatedPart(part, notesLink.target);
    const notesRoot = notesPart ? parse(notesPart)?.documentElement : undefined;
    const notesTree = element(element(notesRoot, 'cSld', presentation), 'spTree', presentation);
    const noteShapes = children(notesTree).filter(shape => shape.getElementsByTagNameNS(presentation, 'ph').item(0)?.getAttribute('type') === 'body');
    const notes = noteShapes.map(shape => Array.from(shape.getElementsByTagNameNS(drawing, 'p')).map(visibleText).join('\n')).join('\n').trim().slice(0, 3000);
    pages.push({ index: page, title, notes, text: [text, chartText].filter(Boolean).join('\n').slice(0, 10000), visual });
  }
  return { kind: 'pptx', pages, pageCount: ids.length, findings };
}

async function parseWorkbook(bytes: ArrayBuffer): Promise<Parsed> {
  inspect(new Uint8Array(bytes));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  let rowCount = 0;
  let cellCount = 0;
  const sheets = workbook.worksheets.map(sheet => {
    const rows: Sheet['rows'] = [];
    sheet.eachRow((row, number) => {
      rowCount++;
      if (rowCount > 25_000) throw new Error('file_too_large');
      const cells: Record<number, Cell> = {};
      row.eachCell((cell, col) => {
        cellCount++;
        if (cellCount > 220_000) throw new Error('file_too_large');
        const value = plainCell(cell.value);
        if (value !== undefined && value !== '') cells[col] = value;
      });
      if (Object.keys(cells).length) rows.push({ number, cells });
    });
    return { name: sheet.name, rows };
  });
  if (!sheets.some(sheet => sheet.rows.length > 0)) throw new Error('empty_document');
  return { kind: 'xlsx', sheets };
}

self.addEventListener('message', async (event: MessageEvent<{ id: number; bytes: ArrayBuffer; kind: MaterialKind }>) => {
  const { id, bytes, kind } = event.data;
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const version = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    let parsed: Parsed;
    switch (kind) {
      case 'docx': parsed = parseWord(new Uint8Array(bytes)); break;
      case 'pptx': parsed = parseSlides(new Uint8Array(bytes)); break;
      case 'csv': parsed = parseCsv(new Uint8Array(bytes)); break;
      case 'txt': case 'md': parsed = parseText(new Uint8Array(bytes)); break;
      default: parsed = await parseWorkbook(bytes);
    }
    self.postMessage({ id, parsed, version });
  } catch (error) {
    const code = error instanceof Error && ['file_too_large', 'empty_document'].includes(error.message) ? error.message : 'file_parse';
    self.postMessage({ id, error: code });
  }
});
