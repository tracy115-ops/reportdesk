export interface BrowserCapture {
  url: string;
  title: string;
  text: string;
  capturedAt: number;
  selection: boolean;
  truncated: boolean;
}

export function linksInRequest(request: string) {
  const links = new Set<string>();
  for (const match of request.matchAll(/https?:\/\/[^\s<>"'，。、；！？（）【】《》]+/giu)) {
    try {
      const clean = match[0].replace(/[),.;!?]+$/u, '');
      const url = new URL(clean);
      if (url.hostname && !url.username && !url.password) links.add(url.href);
    } catch { /* Leave invalid addresses in the original message. */ }
  }
  return [...links];
}

export function webMaterialMarkdown(capture: BrowserCapture, title: string, period?: readonly [string, string]) {
  const scope = capture.selection ? 'Selected text' : 'Current page';
  const limit = capture.truncated ? ' (capture limit reached)' : '';
  return [
    '# ' + title.trim(),
    'Source URL: ' + capture.url,
    'Captured at: ' + new Date(capture.capturedAt).toISOString(),
    'Capture scope: ' + scope + limit,
    ...(period ? ['Reporting period: ' + period.join(' to ')] : []),
    '',
    capture.text,
  ].join('\n');
}

export function webpageSource(paragraphs: readonly { text: string }[]) {
  if (!paragraphs[2]?.text.startsWith('Captured at: ') || !paragraphs[3]?.text.startsWith('Capture scope: ')) return;
  const source = paragraphs[1]?.text;
  if (source?.startsWith('Source URL: ')) return linksInRequest(source)[0];
}
