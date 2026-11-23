use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
};

const PANEL: &str = "office-browser";

#[derive(Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn rect(&self) -> Result<Rect, &'static str> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
            || self.width < 1.0
            || self.height < 1.0
        {
            return Err("browser_failed");
        }
        Ok(Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        })
    }
}

fn can_browse(url: &Url, app_origin: Option<&Url>) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            !matches!(host.trim_end_matches('.'), "tauri.localhost" | "ipc.localhost" | "asset.localhost")
        })
        && url.username().is_empty()
        && url.password().is_none()
        && app_origin.is_none_or(|origin| origin.origin() != url.origin())
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(host)) => host.is_loopback(),
        Some(url::Host::Ipv6(host)) => host.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost",
        None => false,
    }
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, address: String, bounds: Bounds) -> Result<(), String> {
    let dev_url = app.config().build.dev_url.clone();
    let url = Url::parse(&address)
        .ok()
        .filter(|url| can_browse(url, dev_url.as_ref()))
        .ok_or("browser_address")?;
    let rect = bounds.rect()?;
    if let Some(webview) = app.get_webview(PANEL) {
        webview.set_bounds(rect).map_err(|_| "browser_failed")?;
        return webview.navigate(url).map_err(|_| "browser_failed".into());
    }
    let window = app.get_window("main").ok_or("browser_failed")?;
    let builder = WebviewBuilder::new(PANEL, WebviewUrl::External(url))
        .incognito(true)
        .devtools(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| can_browse(url, dev_url.as_ref()) || url.as_str() == "about:blank")
        .on_new_window(|_, _| NewWindowResponse::Deny);
    window
        .add_child(builder, rect.position, rect.size)
        .map_err(|_| "browser_failed")?;
    Ok(())
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, bounds: Option<Bounds>) -> Result<(), String> {
    let Some(view) = app.get_webview(PANEL) else { return Ok(()) };
    if let Some(bounds) = bounds {
        view.set_bounds(bounds.rect()?).map_err(|_| "browser_failed")?;
        view.show().map_err(|_| "browser_failed".into())
    } else {
        view.hide().map_err(|_| "browser_failed".into())
    }
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, action: String) -> Result<Option<String>, String> {
    let Some(view) = app.get_webview(PANEL) else { return Ok(None) };
    if action == "state" {
        return view.url().map(|url| Some(url.to_string())).map_err(|_| "browser_failed".into());
    }
    if action == "inspect" {
        inspect_local(&view).await?;
        return Ok(None);
    }
    let result = match action.as_str() {
        "close" => view.close(),
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => return Err("browser_failed".into()),
    };
    result.map(|_| None).map_err(|_| "browser_failed".into())
}

#[cfg(windows)]
async fn inspect_local(view: &Webview) -> Result<(), String> {
    let url = view.url().map_err(|_| "browser_inspector")?;
    if !is_loopback(&url) {
        return Err("browser_inspector".into());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| {
        // The command runs through the parent window. The browser child receives no app capabilities.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|browser| browser.OpenDevToolsWindow())
        };
        let _ = sender.send(result.is_ok());
    }).map_err(|_| "browser_inspector")?;
    match tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(std::time::Duration::from_secs(4))).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err("browser_inspector".into()),
    }
}

#[cfg(not(windows))]
async fn inspect_local(_view: &Webview) -> Result<(), String> {
    Err("browser_inspector".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BrowserQualityCode {
    MissingTitle,
    MissingViewport,
    MissingAlt,
    UnlabeledInput,
    BrokenImage,
    HorizontalOverflow,
}

#[derive(Deserialize, Serialize)]
struct BrowserQualityIssue {
    code: BrowserQualityCode,
    count: u32,
    examples: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct BrowserPageSnapshot {
    url: String,
    width: u32,
    height: u32,
    issues: Vec<BrowserQualityIssue>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserQualityReport {
    #[serde(flatten)]
    page: BrowserPageSnapshot,
    checked_at: u64,
}

const QUALITY_CHECK: &str = r#"
(() => {
  const root = document.documentElement;
  if (!root || !document.body || document.readyState === 'loading') return null;
  const issues = new Map();
  function record(code, example) {
    if (!issues.has(code)) issues.set(code, { code, count: 0, examples: [] });
    const issue = issues.get(code);
    issue.count++;
    if (example && issue.examples.length < 3 && !issue.examples.includes(example)) {
      issue.examples.push(example.slice(0, 120));
    }
  }
  function description(element) {
    const tag = element.localName;
    if (element.id) return tag + '#' + element.id;
    const name = element.getAttribute('name');
    return name ? tag + ' [name=' + name + ']' : tag;
  }
  function labeled(element) {
    if (element.getAttribute('aria-label')?.trim()) return true;
    const references = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/, 12);
    if (references.some(id => id && document.getElementById(id)?.textContent?.trim())) return true;
    return Array.from(element.labels ?? []).slice(0, 12).some(label => label.textContent?.trim());
  }
  if (!document.title.trim()) record('missing_title', 'title');
  const viewport = document.head?.querySelector('meta[name="viewport" i]');
  if (!viewport?.getAttribute('content')?.trim()) record('missing_viewport', 'meta[name=viewport]');
  const availableWidth = root.clientWidth;
  const contentWidth = Math.max(root.scrollWidth, document.body.scrollWidth);
  if (contentWidth > availableWidth + 2) {
    record('horizontal_overflow', availableWidth + ' px → ' + contentWidth + ' px');
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let visited = 0;
  let element;
  while ((element = walker.nextNode()) && visited < 12_000) {
    visited++;
    if (element.localName === 'img') {
      if (!element.hasAttribute('alt')) record('missing_alt', description(element));
      if (element.complete && element.naturalWidth === 0 && (element.currentSrc || element.getAttribute('src')?.trim())) {
        record('broken_image', description(element));
      }
    }
    if (!['input', 'select', 'textarea'].includes(element.localName)) continue;
    const type = element.type;
    if (['hidden', 'submit', 'reset', 'button'].includes(type) || !element.getClientRects().length) continue;
    if (getComputedStyle(element).visibility !== 'visible') continue;
    if (type === 'image' && element.getAttribute('alt')?.trim()) continue;
    if (!labeled(element)) record('unlabeled_input', description(element));
  }
  return {
    url: location.href,
    width: innerWidth,
    height: innerHeight,
    issues: Array.from(issues.values()),
    truncated: Boolean(element),
  };
})()
"#;

#[tauri::command]
pub async fn browser_check(app: AppHandle) -> Result<BrowserQualityReport, String> {
    let view = app.get_webview(PANEL).ok_or("browser_check_local")?;
    let before = view.url().map_err(|_| "browser_check_failed")?;
    if !is_loopback(&before) || !can_browse(&before, app.config().build.dev_url.as_ref()) {
        return Err("browser_check_local".into());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    view.eval_with_callback(QUALITY_CHECK, move |value| {
        let _ = sender.try_send(value);
    }).map_err(|_| "browser_check_failed")?;
    let value = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(4)))
        .await
        .map_err(|_| "browser_check_failed")?
        .map_err(|_| "browser_check_failed")?;
    if value.len() > 16_000 || value == "null" {
        return Err("browser_check_failed".into());
    }
    let mut page: BrowserPageSnapshot = serde_json::from_str(&value).map_err(|_| "browser_check_failed")?;
    let after = view.url().map_err(|_| "browser_check_failed")?;
    if before != after || Url::parse(&page.url).ok().as_ref() != Some(&after) {
        return Err("browser_check_changed".into());
    }
    page.url = after.to_string();
    page.issues.truncate(6);
    for issue in &mut page.issues {
        issue.count = issue.count.min(12_000);
        issue.examples.truncate(3);
        for sample in &mut issue.examples {
            *sample = sample.chars().filter(|character| {
                !character.is_control() && !matches!(*character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            }).take(120).collect();
        }
    }
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "browser_check_failed")?
        .as_millis() as u64;
    Ok(BrowserQualityReport { page, checked_at })
}
