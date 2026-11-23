import { ArrowLeftOutlined, ArrowRightOutlined, CodeOutlined, FileSearchOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { Alert, Button, Input, InputNumber, Segmented, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nativeDesktop } from './desktop';
import './embedded-browser.css';

const browserCopy = {
  zh: {
    title: '工作浏览器', address: '网页地址', placeholder: '输入网址，例如 https://example.com', open: '打开',
    back: '后退', forward: '前进', reload: '刷新', invalid: '请输入有效的 HTTP 或 HTTPS 地址。',
    failed: '无法打开网页。检查地址或网络后重试。', desktop: '请在桌面版中使用工作浏览器。',
    viewport: '视口', fit: '填满', tablet: '平板', phone: '手机', custom: '自定义', width: '视口宽度',
    inspect: '开发者工具', inspectHint: '打开本地网页的 WebView2 开发者工具', inspector: '无法打开开发者工具。请使用 Windows 桌面版并打开本地网页。',
    check: '检查当前网页', checkHint: '检查本地网页在当前视口的结构、资源和横向溢出',
    checkFailed: '网页检查未完成。请等页面加载后重试。',
    checkChanged: '检查期间网页发生了跳转。请在当前页面重新检查。',
  },
  en: {
    title: 'Workspace browser', address: 'Web address', placeholder: 'Enter a URL, such as https://example.com', open: 'Open',
    back: 'Back', forward: 'Forward', reload: 'Reload', invalid: 'Enter a valid HTTP or HTTPS URL.',
    failed: 'The page could not open. Check the address or your network and try again.', desktop: 'Open the desktop app to browse the web here.',
    viewport: 'Viewport', fit: 'Fit', tablet: 'Tablet', phone: 'Phone', custom: 'Custom', width: 'Viewport width',
    inspect: 'DevTools', inspectHint: 'Open WebView2 DevTools for the local page', inspector: 'DevTools could not open. Open a local page in the Windows desktop app.',
    check: 'Check current page', checkHint: 'Check the local page structure, resources, and overflow at the current viewport',
    checkFailed: 'The page check did not finish. Wait for the page to load and try again.',
    checkChanged: 'The browser navigated during the check. Run it again on the current page.',
  },
};

type Bounds = { x: number; y: number; width: number; height: number };
type BrowserAction = 'back' | 'forward' | 'reload' | 'inspect';
type Viewport = 'fit' | 'tablet' | 'phone' | 'custom';
export type BrowserIntake = { url: string; key?: string };
export type BrowserQualityCode = 'missing_title' | 'missing_viewport' | 'missing_alt' | 'unlabeled_input' | 'broken_image' | 'horizontal_overflow';
export interface BrowserQualityReport {
  url: string;
  checkedAt: number;
  width: number;
  height: number;
  issues: { code: BrowserQualityCode; count: number; examples: string[] }[];
  truncated: boolean;
}

let browserOperations: Promise<unknown> = Promise.resolve();
function runBrowserCommand<T>(name: string, args: Record<string, unknown>) {
  const operation = browserOperations.catch(() => {}).then(() => invoke<T>(name, args));
  browserOperations = operation;
  return operation;
}

function normalizeAddress(value: string) {
  const clean = value.trim();
  if (!clean || /\s/.test(clean)) return;
  try {
    const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(clean);
    let url = new URL(explicitScheme ? clean : 'https://' + clean);
    if (!explicitScheme && loopback(url)) url = new URL('http://' + clean);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password) return url.href;
  } catch { return; }
}

function loopback(url: URL) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
}

function panelBounds(panel: HTMLElement): Bounds | null {
  const rect = panel.getBoundingClientRect();
  const viewport = panel.closest('.main-content')?.getBoundingClientRect();
  const x = Math.ceil(Math.max(0, rect.left, viewport?.left ?? 0));
  const y = Math.ceil(Math.max(0, rect.top, viewport?.top ?? 0));
  const width = Math.floor(Math.min(innerWidth, rect.right, viewport?.right ?? innerWidth)) - x;
  const height = Math.floor(Math.min(innerHeight, rect.bottom, viewport?.bottom ?? innerHeight)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function browserCovered(bounds: Bounds) {
  return [...document.querySelectorAll('.ant-modal-wrap, .ant-drawer-open, .sidebar-menu:not(.ant-dropdown-hidden)')].some(overlay => {
    const { left, right, top, bottom } = overlay.getBoundingClientRect();
    return left < bounds.x + bounds.width && right > bounds.x && top < bounds.y + bounds.height && bottom > bounds.y;
  });
}

export default function EmbeddedBrowser({ intake, onQualityReport }: { intake?: BrowserIntake; onQualityReport?: (report: BrowserQualityReport) => void }) {
  const { i18n } = useTranslation();
  const copy = i18n.language.startsWith('zh') ? browserCopy.zh : browserCopy.en;
  const [address, setAddress] = useState('');
  const [opened, setOpened] = useState(false);
  const [location, setLocation] = useState('');
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<'invalid' | 'failed' | 'inspector' | 'checkFailed' | 'checkChanged'>();
  const [viewport, setViewport] = useState<Viewport>('fit');
  const [customWidth, setCustomWidth] = useState<number | null>(520);
  const [visibleSize, setVisibleSize] = useState<{ width: number; height: number }>();
  const panel = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const localPage = Boolean(location && loopback(new URL(location)));
  const viewportWidth = viewport === 'phone' ? 390 : viewport === 'tablet' ? 768 : viewport === 'custom' ? Math.min(1600, Math.max(240, customWidth ?? 520)) : undefined;

  useEffect(() => {
    if (!nativeDesktop) return;
    return () => { void runBrowserCommand('browser_action', { action: 'close' }).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!opened) return;
    let active = true;
    let reading = false;
    async function updateAddress() {
      if (reading) return;
      reading = true;
      try {
        const url = await runBrowserCommand<string | null>('browser_action', { action: 'state' });
        if (active && url && /^https?:\/\//i.test(url)) {
          setLocation(url);
          if (!editing.current) setAddress(url);
        }
      } catch { /* The next read will retry. */ }
      finally { reading = false; }
    }
    void updateAddress();
    const interval = window.setInterval(updateAddress, 450);
    return () => { active = false; window.clearInterval(interval); };
  }, [opened]);

  useEffect(() => {
    if (!intake?.url) return;
    const timer = window.setTimeout(() => { void openAddress(intake.url); });
    return () => window.clearTimeout(timer);
  }, [intake?.url, intake?.key]);

  useEffect(() => {
    const surface = panel.current;
    if (!opened || !surface) return;
    let frame = 0;
    let previous = '';
    function scheduleBounds() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const position = panelBounds(surface!);
        const bounds = position && !browserCovered(position) ? position : null;
        const key = JSON.stringify(bounds);
        if (key === previous) return;
        previous = key;
        if (bounds) setVisibleSize({ width: bounds.width, height: bounds.height });
        void runBrowserCommand('browser_bounds', { bounds }).catch(() => {});
      });
    }
    const resize = new ResizeObserver(scheduleBounds);
    resize.observe(surface);
    const overlays = new MutationObserver(scheduleBounds);
    overlays.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    window.addEventListener('resize', scheduleBounds);
    window.addEventListener('scroll', scheduleBounds, true);
    scheduleBounds();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', scheduleBounds);
      window.removeEventListener('scroll', scheduleBounds, true);
    };
  }, [opened]);

  async function openAddress(value = address) {
    if (!nativeDesktop || opening || checking || !panel.current) return;
    const url = normalizeAddress(value);
    if (!url) { setError('invalid'); return; }
    const bounds = panelBounds(panel.current);
    if (!bounds) return;
    setOpening(true);
    setError(undefined);
    editing.current = false;
    setAddress(url);
    try {
      await runBrowserCommand('browser_open', { address: url, bounds });
      setOpened(true);
    } catch (problem) { setError(problem === 'browser_address' ? 'invalid' : 'failed'); }
    finally { setOpening(false); }
  }

  function go(action: BrowserAction) {
    if (!opened || opening || checking) return;
    editing.current = false;
    setError(undefined);
    void runBrowserCommand('browser_action', { action }).catch(() => setError(action === 'inspect' ? 'inspector' : 'failed'));
  }

  async function checkPage() {
    if (!onQualityReport || !localPage || opening || checking || !panel.current) return;
    const bounds = panelBounds(panel.current);
    if (!bounds) return;
    setChecking(true);
    setError(undefined);
    try {
      await runBrowserCommand('browser_bounds', { bounds });
      const report = await runBrowserCommand<BrowserQualityReport>('browser_check', {});
      if (panel.current) onQualityReport(report);
    } catch (problem) {
      if (panel.current) setError(problem === 'browser_check_changed' ? 'checkChanged' : 'checkFailed');
    } finally {
      if (panel.current) setChecking(false);
    }
  }

  return <section className="embedded-browser" aria-label={copy.title}>
    <form className="embedded-browser-bar" onSubmit={event => { event.preventDefault(); void openAddress(); }}>
      <div className="embedded-browser-navigation">
        <Tooltip title={copy.back}><Button type="text" aria-label={copy.back} icon={<ArrowLeftOutlined />} disabled={!opened || opening || checking} onClick={() => go('back')} /></Tooltip>
        <Tooltip title={copy.forward}><Button type="text" aria-label={copy.forward} icon={<ArrowRightOutlined />} disabled={!opened || opening || checking} onClick={() => go('forward')} /></Tooltip>
        <Tooltip title={copy.reload}><Button type="text" aria-label={copy.reload} icon={<ReloadOutlined />} disabled={!opened || opening || checking} onClick={() => go('reload')} /></Tooltip>
      </div>
      <Input aria-label={copy.address} placeholder={copy.placeholder} value={address} maxLength={4096} disabled={!nativeDesktop}
        status={error === 'invalid' ? 'error' : undefined} prefix={<GlobalOutlined />} spellCheck={false} autoCapitalize="none" autoComplete="off"
        onChange={event => { editing.current = true; setAddress(event.target.value); setError(undefined); }} />
      <Button type="primary" htmlType="submit" loading={opening} disabled={!nativeDesktop || checking || !address.trim()}>{copy.open}</Button>
    </form>
    {nativeDesktop && <div className="embedded-browser-viewport">
      <Segmented<Viewport> aria-label={copy.viewport} size="small" value={viewport} onChange={setViewport} disabled={checking}
        options={(['fit', 'tablet', 'phone', 'custom'] as const).map(value => ({ value, label: copy[value] }))} />
      {viewport === 'custom' && <InputNumber size="small" aria-label={copy.width} min={240} max={1600} value={customWidth} onChange={setCustomWidth} disabled={checking} suffix="px" />}
      {visibleSize && <span className="embedded-browser-dimensions">{visibleSize.width} × {visibleSize.height} px</span>}
      <div className="embedded-browser-tools">
        {onQualityReport && <Tooltip title={copy.checkHint}><Button size="small" icon={<FileSearchOutlined />} loading={checking}
          disabled={!opened || !localPage || opening} onClick={() => void checkPage()}>{copy.check}</Button></Tooltip>}
        <Tooltip title={copy.inspectHint}><Button size="small" type="text" icon={<CodeOutlined />} disabled={!opened || !localPage || opening || checking} onClick={() => go('inspect')}>{copy.inspect}</Button></Tooltip>
      </div>
    </div>}
    {error && <Alert type="error" showIcon title={copy[error]} />}
    {!nativeDesktop && <Alert type="info" showIcon title={copy.desktop} />}
    <div className="embedded-browser-stage">
      <div ref={panel} className="embedded-browser-surface" style={{ width: viewportWidth }}>
        {!opened && nativeDesktop && <div className="embedded-browser-start"><GlobalOutlined /><p>{copy.placeholder}</p></div>}
      </div>
    </div>
  </section>;
}
