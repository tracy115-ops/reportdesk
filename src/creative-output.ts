import { invoke } from '@tauri-apps/api/core';
import { nativeDesktop } from './desktop';
import type { CreativeProject } from './creative-project';
import { creativeExportPages } from './creative-project';
import { creativeScene } from './creative-scene';
import { normalizePresentation } from './presentation';
import type { SlideVisual } from './slide-visual';

export type CreativeOutput = 'pptx' | 'html' | 'pdf';
const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function projectScenes(project: CreativeProject) {
  const pages = creativeExportPages(project);
  return { pages, scenes: pages.map((page, index) => creativeScene(page, project.theme, index, pages.length)) };
}

export async function creativePptx(project: CreativeProject): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.title = project.title;
  deck.author = 'Office Workspace';
  deck.subject = project.brief;
  const { pages, scenes } = projectScenes(project);
  for (const [index, visual] of scenes.entries()) {
    const slide = deck.addSlide();
    slide.background = { color: visual.background.slice(1) };
    slide.addNotes(pages[index]!.notes);
    for (const shape of visual.shapes) {
      const { x, y, width, height } = shape;
      const bounds = { x: x / 72, y: y / 72, w: width / 72, h: height / 72 };
      if (shape.fill) slide.addShape(deck.ShapeType.rect, { ...bounds, line: { transparency: 100 }, fill: { color: shape.fill.slice(1) } });
      if (shape.text) {
        const text = shape.text;
        slide.addText(text.value, { ...bounds, fontFace: project.locale === 'zh-CN' ? 'Microsoft YaHei' : 'Aptos',
          fontSize: text.size, color: text.color.slice(1), bold: text.bold, align: text.align, valign: 'top',
          margin: 0, breakLine: false, fit: 'shrink', paraSpaceAfter: 0, lineSpacingMultiple: 1.18 });
      }
      if (shape.chart) {
        const rows = shape.chart.rows;
        const chart = pages[index]!.chart;
        slide.addChart(deck.ChartType.bar, [{ name: chart?.series ?? pages[index]!.title, labels: rows.map(row => row.label), values: rows.map(row => row.value === 0 ? '0' : row.value) }], {
          ...bounds, barDir: 'bar', showLegend: false, showValue: true, dataLabelPosition: 'outEnd',
          chartColors: [shape.chart.color.slice(1)], catAxisLabelFontFace: 'Microsoft YaHei', catAxisLabelFontSize: 13,
          valAxisLabelFontSize: 11, dataLabelColor: '334155', dataLabelFontSize: 12, dataLabelFormatCode: '#,##0.######',
        });
      }
    }
  }
  const output = await deck.write({ outputType: 'blob', compression: true });
  if (!(output instanceof Blob)) throw Error('export_failed');
  return normalizePresentation(new Blob([output], { type: pptxMime }));
}

function visualHtml(visual: SlideVisual) {
  return visual.shapes.map(shape => {
    const style = 'left:' + shape.x / 9.6 + '%;top:' + shape.y / 5.4 + '%;width:' + shape.width / 9.6
      + '%;height:' + shape.height / 5.4 + '%;' + (shape.fill ? 'background:' + shape.fill + ';' : '');
    if (shape.text) {
      const text = shape.text;
      return '<div class="shape text" style="' + style + 'font-size:' + text.size / 9.6 + 'cqw;color:' + text.color
        + ';font-weight:' + (text.bold ? 700 : 400) + '">' + escape(text.value) + '</div>';
    }
    if (shape.chart) {
      const rows = shape.chart.rows;
      const scale = Math.max(...rows.map(row => Math.abs(row.value)), 1);
      const min = Math.min(0, ...rows.map(row => row.value / scale));
      const max = Math.max(0, ...rows.map(row => row.value / scale));
      const span = max - min || 1;
      const zero = -min / span * 100;
      return '<div class="shape chart" style="' + style + '">' + rows.map(row => {
        const level = (row.value / scale - min) / span * 100;
        return '<div class="chart-row"><span>' + escape(row.label) + '</span><div class="track"><i style="left:' + zero + '%"></i><b style="left:'
          + Math.min(zero, level) + '%;width:' + Math.abs(level - zero) + '%;background:' + shape.chart!.color + '"></b></div><strong>'
          + escape(String(row.value)) + '</strong></div>';
      }).join('') + '</div>';
    }
    return '<div class="shape" style="' + style + '"></div>';
  }).join('');
}

export function creativeHtml(project: CreativeProject): Blob {
  const { pages, scenes } = projectScenes(project);
  const chinese = project.locale === 'zh-CN';
  const sections = scenes.map((visual, index) => '<section class="slide" id="slide-' + (index + 1) + '" aria-label="'
    + escape(pages[index]!.title) + '" style="background:' + visual.background + '">' + visualHtml(visual) + '</section>').join('');
  const html = '<!doctype html><html lang="' + project.locale + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="generator" content="Office Workspace"><title>' + escape(project.title) + '</title><style>'
    + '*{box-sizing:border-box}body{margin:0;background:#e9edf5;color:#223047;font-family:"Microsoft YaHei",Aptos,Arial,sans-serif}'
    + 'header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:#fff;position:sticky;top:0;z-index:5;box-shadow:0 1px 8px #18233b22}'
    + 'header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}nav{display:flex;align-items:center;gap:10px;white-space:nowrap}'
    + 'button{cursor:pointer;border:1px solid #ccd4e4;border-radius:6px;padding:6px 11px;background:white;color:#203455;font:inherit}'
    + 'main{display:grid;gap:26px;max-width:1100px;margin:auto;padding:24px 12px}.slide{aspect-ratio:16/9;width:100%;container-type:inline-size;position:relative;overflow:hidden;box-shadow:0 6px 24px #1724421f}'
    + '.shape{position:absolute}.text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.18;overflow:hidden}.chart{display:grid;grid-auto-rows:1fr;font-size:1.64cqw;gap:0}'
    + '.chart-row{display:grid;grid-template-columns:1.6fr 4fr 1fr;align-items:center;gap:1.3cqw}.chart-row>span,.chart-row>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.track{position:relative;height:100%}.track i{position:absolute;top:0;bottom:0;width:1px;background:#a6b5ca}.track b{position:absolute;top:22%;bottom:22%}'
    + '@page{size:960pt 540pt;margin:0}@media print{body{background:white}header{display:none}main{display:block;margin:0;padding:0;max-width:none}.slide{width:960pt;height:540pt;break-after:page;page-break-after:always;box-shadow:none;print-color-adjust:exact}.slide:last-child{break-after:auto}}'
    + '</style></head><body><header><strong>' + escape(project.title) + '</strong><nav><button id="previous" aria-label="' + (chinese ? '上一页' : 'Previous') + '">←</button><span id="counter">1 / '
    + pages.length + '</span><button id="next" aria-label="' + (chinese ? '下一页' : 'Next') + '">→</button><button onclick="window.print()">'
    + (chinese ? '打印' : 'Print') + '</button></nav></header><main>' + sections + '</main><script>'
    + '(()=>{const slides=[...document.querySelectorAll(".slide")];let selected=0;const move=i=>{selected=Math.max(0,Math.min(slides.length-1,i));slides[selected].scrollIntoView({behavior:"smooth",block:"center"});document.querySelector("#counter").textContent=(selected+1)+" / "+slides.length};'
    + 'document.querySelector("#previous").onclick=()=>move(selected-1);document.querySelector("#next").onclick=()=>move(selected+1);'
    + 'document.addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key)){e.preventDefault();move(selected+1)}if(["ArrowLeft","PageUp"].includes(e.key)){e.preventDefault();move(selected-1)}});'
    + 'const watch=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){selected=slides.indexOf(e.target);document.querySelector("#counter").textContent=(selected+1)+" / "+slides.length}},{threshold:.6});slides.forEach(s=>watch.observe(s))})()'
    + '</script></body></html>';
  return new Blob([html], { type: 'text/html;charset=utf-8' });
}

let pdfTypeface: Promise<ArrayBuffer> | undefined;
export function providePdfTypeface(bytes: ArrayBuffer) { pdfTypeface = Promise.resolve(bytes); }

async function exportFont() {
  if (!pdfTypeface) {
    if (!nativeDesktop) throw Error('creative_pdf_font');
    pdfTypeface = invoke<ArrayBuffer>('read_export_font').catch(error => { pdfTypeface = undefined; throw error; });
  }
  return pdfTypeface;
}

export async function creativePdf(project: CreativeProject) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const { default: fontkit } = await import('@pdf-lib/fontkit');
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const { scenes } = projectScenes(project);
  const hasWide = /[^\u0000-\u00ff]/.test(JSON.stringify(scenes));
  const font = hasWide ? await document.embedFont(await exportFont(), { subset: true })
    : await document.embedFont(StandardFonts.Helvetica);
  const color = (hex: string) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
  document.setTitle(project.title);
  document.setAuthor('Office Workspace');
  for (const visual of scenes) {
    const page = document.addPage([960, 540]);
    const drawText = (value: string, x: number, y: number, size: number, fill: string, width: number, height: number) => {
      let fontSize = size;
      const lines = value.split('\n');
      const widest = Math.max(...lines.map(line => font.widthOfTextAtSize(line, fontSize)), 1);
      fontSize = Math.min(fontSize, fontSize * width / widest, height / Math.max(1, lines.length) / 1.18);
      for (const [index, line] of lines.entries()) {
        if (line) page.drawText(line, { x, y: 540 - y - fontSize - index * fontSize * 1.18, size: fontSize, font, color: color(fill) });
      }
    };
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: color(visual.background) });
    for (const shape of visual.shapes) {
      if (shape.fill) page.drawRectangle({ x: shape.x, y: 540 - shape.y - shape.height, width: shape.width, height: shape.height, color: color(shape.fill) });
      if (shape.text) drawText(shape.text.value, shape.x, shape.y, shape.text.size, shape.text.color, shape.width, shape.height);
      if (shape.chart) {
        const rows = shape.chart.rows;
        const magnitude = Math.max(...rows.map(row => Math.abs(row.value)), 1);
        const min = Math.min(0, ...rows.map(row => row.value / magnitude));
        const max = Math.max(0, ...rows.map(row => row.value / magnitude));
        const range = max - min || 1;
        const zero = -min / range;
        const rowHeight = shape.height / rows.length;
        const left = shape.x + shape.width * .27;
        const plotWidth = shape.width * .57;
        for (const [index, row] of rows.entries()) {
          const y = shape.y + index * rowHeight;
          const at = (row.value / magnitude - min) / range;
          drawText(row.label, shape.x, y + rowHeight * .33, 15, '#213451', shape.width * .24, rowHeight * .6);
          page.drawRectangle({ x: left + Math.min(at, zero) * plotWidth, y: 540 - y - rowHeight * .74,
            width: Math.abs(at - zero) * plotWidth, height: rowHeight * .48, color: color(shape.chart.color) });
          drawText(String(row.value), shape.x + shape.width * .87, y + rowHeight * .33, 14, '#213451', shape.width * .13, rowHeight * .6);
        }
      }
    }
  }
  return new Blob([new Uint8Array(await document.save())], { type: 'application/pdf' });
}
