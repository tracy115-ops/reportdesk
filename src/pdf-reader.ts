import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { Parsed } from './domain';

GlobalWorkerOptions.workerSrc = worker;

export function startPdf(bytes: ArrayBuffer) {
  return getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: true });
}

export async function readPdf(bytes: ArrayBuffer, signal?: AbortSignal): Promise<Parsed> {
  signal?.throwIfAborted();
  const loading = startPdf(bytes);
  const cancel = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; cancel(); }, 25_000);
  try {
    const doc = await loading.promise;
    if (doc.numPages > 300) throw new Error('file_too_large');
    const pages: { index: number; text: string }[] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      const text = await page.getTextContent();
      pages.push({ index, text: text.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim().slice(0, 10000) });
    }
    return { kind: 'pdf', pages, pageCount: doc.numPages };
  } catch (error) {
    if (timedOut) throw new Error('file_parse_timeout');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    await loading.destroy().catch(() => {});
  }
}
