import {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { dictionaries } from './i18n';
import { reportTitle, sections } from './domain';
import type { Report } from './domain';

export async function renderDocx(report: Report): Promise<Blob> {
  const lang = report.settings.locale;
  const labels = dictionaries[lang];
  const zh = lang === 'zh-CN';
  const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei', cs: 'Calibri' };
  const number = new Intl.NumberFormat(lang);
  const cell = (label: string, value: number) => new TableCell({
    shading: { type: ShadingType.CLEAR, fill: 'EAF3EF' }, margins: { top: 130, bottom: 130, left: 180, right: 180 },
    children: [new Paragraph({ children: [new TextRun({ text: label, color: '355649', size: 20 })] }),
      new Paragraph({ children: [new TextRun({ text: number.format(value), bold: true, color: '176951', size: 36 })] })],
  });
  const { metrics } = report;
  const contents: (Paragraph | Table)[] = [
    new Paragraph({ text: reportTitle(report.settings), heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `${report.settings.from} – ${report.settings.to}${report.sample ? `  ·  ${labels.sampleBadge}` : ''}`, color: '5A6B65' })] }),
    new Paragraph({ spacing: { after: 120 } }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
      cell(labels.taskTotal, metrics.total), cell(labels.done, metrics.done), cell(labels.open, metrics.open), cell(labels.unverified, metrics.unverified),
    ] })], borders: { insideVertical: { style: BorderStyle.SINGLE, size: 15, color: 'FFFFFF' } } }),
  ];
  for (const key of sections) {
    contents.push(new Paragraph({ text: labels[key], heading: HeadingLevel.HEADING_1 }));
    for (const line of report.narrative[key].split(/\r?\n/).filter(Boolean)) contents.push(new Paragraph({ text: line }));
  }
  const issueTotal = Object.values(report.issues).reduce((sum, value) => sum + value, 0);
  if (issueTotal) {
    contents.push(new Paragraph({ text: labels.auditInReport, heading: HeadingLevel.HEADING_1 }));
    contents.push(new Paragraph(labels.issueTotals.replace('{{count}}', number.format(issueTotal))));
  }
  if (report.evidence.length) {
    contents.push(new Paragraph({ text: labels.reportEvidence, heading: HeadingLevel.HEADING_1 }));
    for (const evidence of report.evidence) {
      contents.push(new Paragraph({ children: [new TextRun({ text: `[${evidence.id}] ${evidence.text.slice(0, 220)}`, bold: true })], keepNext: true }));
      for (const source of evidence.locations) {
        contents.push(new Paragraph({ children: [new TextRun({ text: `${source.file} · ${source.at}`, color: '52625B', size: 19 })] }));
      }
    }
  }
  const document = new Document({
    title: reportTitle(report.settings), creator: 'Office Workspace',
    styles: {
      default: {
        document: { run: { font, size: 22, language: { value: lang, eastAsia: 'zh-CN' } }, paragraph: { spacing: { after: 115, line: 315 } } },
        title: { run: { font, size: 54, bold: true, color: '15372E' }, paragraph: { spacing: { after: 160 }, alignment: AlignmentType.LEFT } },
        heading1: { run: { font, size: 29, bold: true, color: '176951' }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
      },
    },
    sections: [{ properties: { page: { size: zh ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 }, margin: { top: 1200, bottom: 1200, left: 1250, right: 1250 } } }, children: contents }],
  });
  return Packer.toBlob(document);
}
