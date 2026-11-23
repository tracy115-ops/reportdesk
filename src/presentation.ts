import type { PresentationRequest } from './presentation.worker';
import type { SlideVisual } from './slide-visual';

function run<T>(request: PresentationRequest, buffers: ArrayBuffer[], signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./presentation.worker.ts', import.meta.url), { type: 'module' });
    const timeout = window.setTimeout(() => { clean(); reject('file_parse_timeout'); }, 45000);
    const abort = () => { clean(); reject(signal?.reason ?? 'file_parse'); };
    function clean() {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      clean();
      if (data.error) reject(data.error);
      else resolve(data as T);
    };
    worker.onerror = () => { clean(); reject('ppt_package_invalid'); };
    try { worker.postMessage(request, buffers); }
    catch (error) { clean(); reject(error); }
  });
}

export async function renderDeckPage(read: () => Promise<ArrayBuffer>, page: number, signal?: AbortSignal) {
  const bytes = await read();
  return (await run<{ visual: SlideVisual }>({ action: 'preview', bytes, page }, [bytes], signal)).visual;
}

export async function normalizePresentation(file: Blob) {
  const bytes = await file.arrayBuffer();
  const result = await run<{ bytes: Uint8Array }>({ action: 'normalize', bytes }, [bytes]);
  return new Blob([new Uint8Array(result.bytes)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

export async function createPresentation(files: Blob[], pages: { source: number; page: number }[], title: string) {
  const sources = await Promise.all(files.map(file => file.arrayBuffer()));
  const result = await run<{ bytes: Uint8Array; count: number; fitted: number }>({ action: 'assemble', sources, pages, title }, sources);
  return { ...result, file: new Blob([new Uint8Array(result.bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }) };
}
