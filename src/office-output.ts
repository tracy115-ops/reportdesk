import type { Cell, Evidence, Locale, Sheet } from './domain';
import type { OfficeDraft } from './office';
import { ZIP_LIMIT } from './desktop';
import type { SlideData } from './slide-data';
import { normalizePresentation } from './presentation';

export async function makeWord(draft: OfficeDraft, locale: Locale, evidence: Evidence[] = []): Promise<Blob> {
  const { Document, HeadingLevel, Packer, Paragraph } = await import('docx');
  return Packer.toBlob(new Document({
    title: draft.title, creator: 'Office Workspace',
    styles: { default: { document: { run: { size: 22, font: { ascii: 'Calibri', eastAsia: 'Microsoft YaHei' }, language: { value: locale } }, paragraph: { spacing: { after: 140, line: 315 } } } } },
    sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.TITLE, text: draft.title }),
      ...draft.sections.flatMap(section => [
        ...(section.heading ? [new Paragraph({ heading: HeadingLevel.HEADING_1, text: section.heading })] : []),
        ...section.text.split(/\r?\n/).filter(Boolean).map(text => new Paragraph({ text })),
      ]),
      ...(evidence.length ? [new Paragraph({ heading: HeadingLevel.HEADING_1, text: locale === 'zh-CN' ? '引用资料' : 'Sources' }),
        ...evidence.map(item => new Paragraph({ text: `[${item.id}] ${item.locations.map(location => `${location.file} · ${location.at}`).join(' / ')}` }))] : []),
    ] }],
  }));
}

const slideThemes = {
  forest: { cover: '193F35', accent: '66C899', paper: 'F6F9F7', heading: '15372E', body: '283F37', rule: 'B8DCCB', muted: '446A5E' },
  blue: { cover: '182E56', accent: '92BAFF', paper: 'F6F8FD', heading: '1F3C64', body: '23354A', rule: 'CADAF3', muted: '465D7A' },
  ink: { cover: '26262B', accent: 'F6BB6B', paper: 'FCFAF7', heading: '25252A', body: '36363B', rule: 'D7CEC3', muted: '666069' },
};
export type SlideTheme = keyof typeof slideThemes;

export async function makeSlides(draft: OfficeDraft, evidence: Evidence[] = [], locale: Locale = 'zh-CN',
  options: { overview?: { title: string; values: { label: string; value: number }[] }; theme?: SlideTheme; chart?: SlideData; cover?: boolean; pageNumbers?: boolean } = {}): Promise<Blob> {
  const { overview, theme = 'forest', chart, cover: includeCover = true, pageNumbers: numberPages = true } = options;
  const palette = slideThemes[theme];
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = draft.title;
  pptx.author = 'Office Workspace';
  if (includeCover) {
    const cover = pptx.addSlide();
    cover.background = { color: palette.cover };
    cover.addShape(pptx.ShapeType.rect, { x: .9, y: 2.25, w: 1.25, h: .08, fill: { color: palette.accent }, line: { transparency: 100 } });
    cover.addText(draft.title.slice(0, 120), { x: .9, y: 2.72, w: 11.6, h: 2.2, color: 'FFFFFF', fontFace: 'Microsoft YaHei', fontSize: 45, bold: true, fit: 'shrink', margin: 0 });
  }
  if (overview) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.paper };
    slide.addText(overview.title, { x: .85, y: .64, w: 11.7, h: .8, fontFace: 'Microsoft YaHei', fontSize: 32, bold: true, color: palette.heading, margin: 0 });
    overview.values.forEach((metric, index) => {
      const x = .85 + index * 2.95;
      const fill = index === 1 ? 'DDEFE4' : index === 3 ? 'F4EBD4' : 'FFFFFF';
      slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.05, w: 2.74, h: 2.5, line: { color: 'DCE7E0', width: 1 }, fill: { color: fill } });
      slide.addText(new Intl.NumberFormat(locale).format(metric.value), { x: x + .23, y: 2.45, w: 2.26, h: .86, margin: 0,
        fontFace: 'Microsoft YaHei', fontSize: 42, bold: true, color: '17654F', fit: 'shrink' });
      slide.addText(metric.label, { x: x + .23, y: 3.56, w: 2.26, h: .51, margin: 0, fontFace: 'Microsoft YaHei', fontSize: 17, color: '36554A', fit: 'shrink' });
    });
  }
  if (chart) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.paper };
    slide.addText(chart.title, { x: .85, y: .56, w: 11.7, h: .78, fontFace: 'Microsoft YaHei', fontSize: 31,
      bold: true, color: palette.heading, margin: 0, fit: 'shrink' });
    slide.addShape(pptx.ShapeType.line, { x: .85, y: 1.49, w: 11.6, h: 0, line: { color: palette.rule, width: 1.5 } });
    // PptxGenJS writes numeric zero as an empty cell in the embedded worksheet.
    const values = chart.values.map(value => value === 0 ? '0' : value);
    slide.addChart(pptx.ChartType.bar, [{ name: chart.series, labels: chart.labels, values }], {
      x: .9, y: 1.72, w: 11.5, h: 4.8, barDir: 'bar', chartColors: [palette.heading], showLegend: false,
      catAxisLabelFontFace: 'Microsoft YaHei', catAxisLabelFontSize: 14, valAxisLabelFontSize: 11,
      catAxisLabelPos: 'low', showValue: true, dataLabelPosition: 'ctr', dataLabelFormatCode: '#,##0.###', dataLabelColor: 'FFFFFF', dataLabelFontSize: 12,
    });
    slide.addText(chart.source, { x: .9, y: 6.78, w: 11.5, h: .39, fontFace: 'Microsoft YaHei', fontSize: 13, color: palette.muted, fit: 'shrink', margin: 0 });
  }
  const sources = [];
  for (let index = 0; index < evidence.length; index += 7) sources.push({ heading: locale === 'zh-CN' ? '引用资料' : 'Sources',
    text: evidence.slice(index, index + 7).map(item => `[${item.id}] ${item.locations.map(location => `${location.file} · ${location.at}`).join(' / ')}`).join('\n') });
  const pages = [...draft.sections, ...sources].flatMap(part => {
    const groups: string[][] = [[]];
    let weight = 0;
    for (const line of part.text.split(/\r?\n/).map(text => text.trim()).filter(Boolean)) {
      const chunks = line.match(/[\s\S]{1,240}/gu) ?? [];
      for (const chunk of chunks) {
        const current = groups.at(-1)!;
        if (current.length && (current.length >= 7 || weight + chunk.length > 415)) { groups.push([]); weight = 0; }
        groups.at(-1)!.push(chunk);
        weight += chunk.length;
      }
    }
    return groups.map((lines, index) => ({ heading: index ? `${part.heading || draft.title} (${index + 1})` : part.heading, text: lines.join('\n') }));
  });
  for (const [index, part] of pages.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.paper };
    slide.addText(part.heading || draft.title, { x: .85, y: .58, w: 11.7, h: .95, fontFace: 'Microsoft YaHei', fontSize: 31, color: palette.heading, bold: true, fit: 'shrink', margin: 0 });
    slide.addShape(pptx.ShapeType.line, { x: .85, y: 1.67, w: 11.6, h: 0, line: { color: palette.rule, width: 1.5 } });
    const lines = part.text.split(/\r?\n/).filter(Boolean).map(line => line.replace(/^\s*[-•]\s*/, ''));
    slide.addText(lines.join('\n\n'), { x: .9, y: 1.97, w: 11.5, h: 4.75, fontSize: 22, color: palette.body, fontFace: 'Microsoft YaHei', fit: 'shrink', valign: 'top', margin: 0 });
    if (numberPages) slide.addText(String(index + 1 + Number(includeCover) + Number(Boolean(overview)) + Number(Boolean(chart))), { x: 11.8, y: 7.08, w: .55, h: .24,
      color: palette.muted, align: 'right', fontSize: 11, margin: 0 });
  }
  const output = await pptx.write({ outputType: 'blob', compression: true });
  if (!(output instanceof Blob)) throw new Error('export_failed');
  return normalizePresentation(output);
}

export async function packageFiles(files: { name: string; file: Blob }[]) {
  const estimatedSize = files.reduce((sum, item) => sum + item.file.size + 1024, 22);
  if (estimatedSize > ZIP_LIMIT) throw 'zip_export_limit';
  const { zipSync } = await import('fflate');
  const used = new Set<string>();
  const entries = await Promise.all(files.map(async item => {
    const extension = item.name.lastIndexOf('.');
    let name = item.name;
    for (let suffix = 2; used.has(name.normalize('NFC').toLowerCase()); suffix++) {
      name = item.name.slice(0, extension) + ' (' + suffix + ')' + item.name.slice(extension);
    }
    used.add(name.normalize('NFC').toLowerCase());
    return [name, new Uint8Array(await item.file.arrayBuffer())] as const;
  }));
  return new Blob([new Uint8Array(zipSync(Object.fromEntries(entries), { level: 0 }))], { type: 'application/zip' });
}

export function cleanRows(sheet: Sheet, header: number, removeDuplicates: boolean) {
  const seen = new Set<string>();
  const headerRow = sheet.rows.find(row => row.number === header);
  const rows: Record<number, Cell>[] = [];
  let removed = 0;
  if (headerRow) rows.push(headerRow.cells);
  for (const row of sheet.rows) {
    if (row.number <= header) continue;
    const normalized = Object.fromEntries(Object.entries(row.cells).flatMap(([col, value]) => {
      const cell = typeof value === 'string' ? value.trim() : value;
      return cell === '' ? [] : [[col, cell]];
    })) as Record<number, Cell>;
    const key = JSON.stringify(normalized);
    if (!Object.keys(normalized).length || (removeDuplicates && seen.has(key))) { removed++; continue; }
    seen.add(key);
    rows.push(normalized);
  }
  return { rows, removed };
}

interface WorkbookTab { name: string; rows: Record<number, Cell>[]; widths?: number[] }

export async function makeWorkbook(sheetName: string, rows: Record<number, Cell>[],
  options: { widths?: number[]; extra?: WorkbookTab[] } = {}): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const tab of [{ name: sheetName, rows, widths: options.widths }, ...(options.extra ?? [])]) {
    const sheet = workbook.addWorksheet(tab.name);
    for (const [index, values] of tab.rows.entries()) {
      for (const [column, value] of Object.entries(values)) sheet.getRow(index + 1).getCell(Number(column)).value = value;
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FF166B54' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    if (tab.widths?.length) {
      tab.widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
      sheet.getRow(1).height = 24;
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF3EF' } };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: tab.rows.length, column: tab.widths.length } };
    }
  }
  const data = new Uint8Array(await workbook.xlsx.writeBuffer());
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  const entries = unzipSync(data);
  const styles = strFromU8(entries['xl/styles.xml']!);
  // ExcelJS writes its default font in an order rejected by the Open XML validator.
  const normalized = styles.replace(
    /<font>(<color theme="1"\s*\/>)(<family val="2"\s*\/>)(<scheme val="minor"\s*\/>)(<sz val="11"\s*\/>)(<name val="Calibri"\s*\/>)<\/font>/,
    '<font>$4$1$5$2$3</font>',
  );
  if (normalized === styles) return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  entries['xl/styles.xml'] = strToU8(normalized);
  return new Blob([new Uint8Array(zipSync(entries, { level: 3 }))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function pageNumbers(input: string, count: number) {
  const pages: number[] = [];
  for (const term of input.split(/[,，]/)) {
    const range = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(term.trim());
    if (!range) throw new Error('invalid_pages');
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (start < 1 || end < start || end > count) throw new Error('invalid_pages');
    for (let i = start; i <= end; i++) if (!pages.includes(i - 1)) pages.push(i - 1);
  }
  return pages;
}

export async function makePdf(inputs: { bytes: ArrayBuffer; pages?: number[] }[]) {
  const { PDFDocument } = await import('pdf-lib');
  const output = await PDFDocument.create();
  for (const item of inputs) {
    const source = await PDFDocument.load(item.bytes);
    const pages = await output.copyPages(source, item.pages ?? source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  const data = new Uint8Array(await output.save());
  return { file: new Blob([data], { type: 'application/pdf' }), count: output.getPageCount() };
}
