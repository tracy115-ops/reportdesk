import { assembleDeck, normalizeGeneratedDeck } from './pptx-package';
import { previewDeckPage } from './pptx-layout';

export type PresentationRequest =
  | { action: 'preview'; bytes: ArrayBuffer; page: number }
  | { action: 'normalize'; bytes: ArrayBuffer }
  | { action: 'assemble'; sources: ArrayBuffer[]; pages: { source: number; page: number }[]; title: string };

self.addEventListener('message', (event: MessageEvent<PresentationRequest>) => {
  try {
    const request = event.data;
    if (request.action === 'preview') {
      self.postMessage({ visual: previewDeckPage(request.bytes, request.page) });
    } else if (request.action === 'normalize') {
      const bytes = normalizeGeneratedDeck(request.bytes);
      self.postMessage({ bytes }, { transfer: [bytes.buffer] });
    } else {
      const result = assembleDeck(request.sources, request.pages, request.title);
      self.postMessage(result, { transfer: [result.bytes.buffer] });
    }
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'ppt_package_invalid';
    self.postMessage({ error: code });
  }
});
