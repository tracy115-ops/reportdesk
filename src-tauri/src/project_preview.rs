use std::{
    collections::HashSet,
    ffi::OsStr,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const HTML_LIMIT: usize = 32 * 1024 * 1024;
const REQUEST_LIMIT: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 24;
const POLICY: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
    media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; \
    frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

#[derive(Default)]
pub struct PreviewServer(Mutex<Option<Session>>);

struct Session {
    active: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

enum Site {
    Html(Vec<u8>),
    Folder(PathBuf),
}

impl PreviewServer {
    fn start(&self, site: Site) -> Result<String, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let host = listener.local_addr().map_err(failed)?.to_string();
        let prefix = format!("/{}/", Uuid::new_v4().simple());
        let url = format!("http://{host}{prefix}");
        let active = Arc::new(AtomicBool::new(true));
        let enabled = Arc::clone(&active);
        let worker = thread::Builder::new()
            .name("office-preview".into())
            .spawn(move || serve(listener, enabled, SiteConfig { host, prefix, site }))
            .map_err(failed)?;
        let mut current = self.0.lock().map_err(failed)?;
        *current = Some(Session {
            active,
            worker: Some(worker),
        });
        Ok(url)
    }

    fn stop(&self) -> Result<(), String> {
        let mut current = self.0.lock().map_err(failed)?;
        *current = None;
        Ok(())
    }
}

fn failed(_: impl std::fmt::Display) -> String {
    "preview_failed".into()
}

#[tauri::command]
pub fn preview_html(state: State<'_, PreviewServer>, html: String) -> Result<String, String> {
    if html.trim().is_empty() || html.len() > HTML_LIMIT {
        return Err("preview_invalid".into());
    }
    state.start(Site::Html(html.into_bytes()))
}

#[tauri::command]
pub async fn preview_pick_folder(
    app: AppHandle,
    state: State<'_, PreviewServer>,
) -> Result<Option<String>, String> {
    let Some(folder) = choose_folder(app).await? else {
        return Ok(None);
    };
    let root = canonical_folder(&folder).map_err(failed)?;
    let path = root.join("index.html");
    if checked_file(&root, &path).is_none() {
        return Err("preview_missing_index".into());
    }
    state.start(Site::Folder(root)).map(Some)
}

#[tauri::command]
pub fn preview_stop(state: State<'_, PreviewServer>) -> Result<(), String> {
    state.stop()
}

async fn choose_folder(app: AppHandle) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|file| file.into_path().map_err(failed))
            .transpose()
    })
    .await
    .map_err(failed)?
}

fn canonical_folder(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    if is_unc(path) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let path = fs::canonicalize(path)?;
    #[cfg(windows)]
    if is_unc(&path) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    if !path.is_dir() {
        return Err(std::io::ErrorKind::NotADirectory.into());
    }
    Ok(path)
}

#[cfg(windows)]
fn is_unc(path: &Path) -> bool {
    use std::path::Prefix;
    matches!(path.components().next(), Some(Component::Prefix(prefix)) if
        matches!(prefix.kind(), Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _)))
}

struct SiteConfig {
    host: String,
    prefix: String,
    site: Site,
}

struct Connection(Arc<AtomicUsize>);

impl Drop for Connection {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn serve(listener: TcpListener, active: Arc<AtomicBool>, config: SiteConfig) {
    let config = Arc::new(config);
    let open = Arc::new(AtomicUsize::new(0));
    while active.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, address)) if address.ip().is_loopback() => {
                if open.load(Ordering::Acquire) >= MAX_CONNECTIONS {
                    continue;
                }
                open.fetch_add(1, Ordering::AcqRel);
                let guard = Connection(Arc::clone(&open));
                let config = Arc::clone(&config);
                let active = Arc::clone(&active);
                let _ = thread::Builder::new()
                    .name("office-preview-request".into())
                    .spawn(move || {
                        let _guard = guard;
                        if active.load(Ordering::Acquire) {
                            let _ = respond(stream, &config, &active);
                        }
                    });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20))
            }
            Err(_) => break,
        }
    }
}

struct Request {
    path: String,
    host: String,
    referer: Option<String>,
    range: Option<String>,
    head: bool,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    let end = loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 || bytes.len() + count > REQUEST_LIMIT {
            return Ok(None);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|pair| pair == b"\r\n\r\n") {
            break end;
        }
    };
    let Ok(headers) = std::str::from_utf8(&bytes[..end]) else {
        return Ok(None);
    };
    let mut lines = headers.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split_ascii_whitespace();
    let method = request.next().unwrap_or_default();
    let path = request.next().unwrap_or_default();
    let version = request.next().unwrap_or_default();
    if !matches!(method, "GET" | "HEAD")
        || !path.starts_with('/')
        || path.starts_with("//")
        || !matches!(version, "HTTP/1.1" | "HTTP/1.0")
        || request.next().is_some()
    {
        return Ok(None);
    }
    let header = |name: &str| {
        lines.clone().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    Ok(Some(Request {
        path: path.to_owned(),
        host: header("host").unwrap_or_default(),
        referer: header("referer"),
        range: header("range"),
        head: method == "HEAD",
    }))
}

fn respond(mut stream: TcpStream, config: &SiteConfig, active: &AtomicBool) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(8)))?;
    let Some(request) = read_request(&mut stream)? else {
        return empty(&mut stream, "400 Bad Request");
    };
    if request.host != config.host || !active.load(Ordering::Acquire) {
        return empty(&mut stream, "404 Not Found");
    }
    let path = request.path.split('?').next().unwrap_or_default();
    let Some(relative) = path.strip_prefix(&config.prefix) else {
        let entry = config.prefix.trim_end_matches('/');
        if path == entry {
            return redirect(&mut stream, &config.prefix);
        }
        // Root-relative assets can re-enter with a valid same-origin referrer.
        let referer_prefix = format!("http://{}{}", config.host, config.prefix);
        if matches!(config.site, Site::Folder(_))
            && request
                .referer
                .as_ref()
                .is_some_and(|value| value.starts_with(&referer_prefix))
            && relative_path(path.trim_start_matches('/')).is_some()
        {
            return redirect(
                &mut stream,
                &format!("{}{}", config.prefix, request.path.trim_start_matches('/')),
            );
        }
        return empty(&mut stream, "404 Not Found");
    };
    match &config.site {
        Site::Html(bytes) if relative.is_empty() || relative == "index.html" => send_content(
            &mut stream,
            request,
            "text/html; charset=utf-8",
            bytes.len() as u64,
            &mut std::io::Cursor::new(bytes),
        ),
        Site::Html(_) => empty(&mut stream, "404 Not Found"),
        Site::Folder(root) => {
            let Some(relative) = relative_path(relative) else {
                return empty(&mut stream, "404 Not Found");
            };
            let path = root.join(relative);
            let Some((mut file, canonical, length)) =
                checked_file(root, &path).or_else(|| checked_file(root, &path.join("index.html")))
            else {
                return empty(&mut stream, "404 Not Found");
            };
            send_content(&mut stream, request, mime(&canonical), length, &mut file)
        }
    }
}

fn empty(stream: &mut TcpStream, status: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
}

fn redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 307 Temporary Redirect\r\nConnection: close\r\nCache-Control: no-store\r\n\
        Referrer-Policy: same-origin\r\nContent-Length: 0\r\nLocation: {location}\r\n\r\n"
    )
}

fn send_content(
    stream: &mut TcpStream,
    request: Request,
    mime: &str,
    length: u64,
    file: &mut (impl Read + Seek),
) -> std::io::Result<()> {
    let range = match request.range {
        Some(value) => match byte_range(&value, length) {
            Some(range) => Some(range),
            None => {
                return write!(
                    stream,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\n\
                Content-Length: 0\r\nContent-Range: bytes */{length}\r\n\r\n"
                )
            }
        },
        None => None,
    };
    let (status, offset, count) = range.map_or(("200 OK", 0, length), |(start, end)| {
        ("206 Partial Content", start, end - start + 1)
    });
    write!(stream,"HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\n\
        Content-Type: {mime}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\n\
        X-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\nContent-Security-Policy: {POLICY}\r\n")?;
    if let Some((start, end)) = range {
        write!(stream, "Content-Range: bytes {start}-{end}/{length}\r\n")?;
    }
    write!(stream, "\r\n")?;
    if !request.head {
        file.seek(SeekFrom::Start(offset))?;
        std::io::copy(&mut file.take(count), stream)?;
    }
    Ok(())
}

fn byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let last = length.checked_sub(1)?;
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?;
        return (count > 0).then_some((length.saturating_sub(count), last));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        last
    } else {
        end.parse::<u64>().ok()?.min(last)
    };
    (start <= end).then_some((start, end))
}

fn relative_path(path: &str) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for part in path.split('/').filter(|value| !value.is_empty()) {
        let value = decode_path_segment(part)?;
        if value.starts_with('.')
            || value.ends_with(['.', ' '])
            || value
                .chars()
                .any(|character| character.is_control() || "/\\:".contains(character))
        {
            return None;
        }
        result.push(value);
    }
    Some(result)
}

fn decode_path_segment(raw: &str) -> Option<String> {
    let mut result = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let digit = |value: u8| (value as char).to_digit(16).map(|digit| digit as u8);
            result.push(digit(bytes.next()?)? * 16 + digit(bytes.next()?)?);
        } else {
            result.push(byte);
        }
    }
    String::from_utf8(result).ok()
}

fn checked_file(root: &Path, path: &Path) -> Option<(File, PathBuf, u64)> {
    let relative = path.strip_prefix(root).ok()?;
    let mut verified = root.to_owned();
    for component in relative.components() {
        verified.push(component);
        let metadata = fs::symlink_metadata(&verified).ok()?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return None;
        }
    }
    let canonical = fs::canonicalize(path).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let file = File::open(&canonical).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || !opened_inside(&file, root) {
        return None;
    }
    let length = metadata.len();
    Some((file, canonical, length))
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn opened_inside(file: &File, root: &Path) -> bool {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut path = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            0,
        )
    } as usize;
    length > 0
        && length < path.len()
        && PathBuf::from(std::ffi::OsString::from_wide(&path[..length])).starts_with(root)
}

#[cfg(target_os = "linux")]
fn opened_inside(file: &File, root: &Path) -> bool {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .is_ok_and(|path| path.starts_with(root))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn opened_inside(_: &File, _: &Path) -> bool {
    true
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub async fn mini_program_open(app: AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = choose_folder(app).await? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let root = mini_program_root(&folder)?;
        let cli = wechat_cli().ok_or("mini_program_tools_missing")?;
        launch_wechat(&cli, &root)?;
        Ok(Some(display_path(&root)))
    })
    .await
    .map_err(|_| "mini_program_open_failed".to_owned())?
}

fn mini_program_root(folder: &Path) -> Result<PathBuf, String> {
    let invalid = || "mini_program_invalid".to_owned();
    let root = canonical_folder(folder).map_err(|_| invalid())?;
    let config = read_config(&root, &root.join("project.config.json")).ok_or_else(invalid)?;
    if config
        .get("compileType")
        .is_some_and(|value| value.as_str() != Some("miniprogram"))
    {
        return Err(invalid());
    }
    let content = match config.get("miniprogramRoot") {
        Some(value) => value.as_str().ok_or_else(invalid)?,
        None => "",
    };
    let content = Path::new(content);
    if content
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid());
    }
    let app = read_config(&root, &root.join(content).join("app.json")).ok_or_else(invalid)?;
    if !app
        .get("pages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|pages| {
            !pages.is_empty()
                && pages
                    .iter()
                    .all(|page| page.as_str().is_some_and(|path| !path.trim().is_empty()))
        })
    {
        return Err(invalid());
    }
    Ok(root)
}

#[derive(serde::Serialize)]
pub struct MiniProgramCheck {
    path: String,
    pages: usize,
    issues: Vec<MiniProgramIssue>,
}

#[derive(serde::Serialize)]
struct MiniProgramIssue {
    code: &'static str,
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[tauri::command]
pub async fn mini_program_check(app: AppHandle) -> Result<Option<MiniProgramCheck>, String> {
    let Some(folder) = choose_folder(app).await? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || check_mini_program(&folder).map(Some))
        .await
        .map_err(|_| "mini_program_invalid".to_owned())?
}

const MAX_MINI_PAGES: usize = 2048;
const MAX_MINI_ISSUES: usize = 1000;
const MAX_MINI_COMPONENT_REFERENCES: usize = 4096;
const MINI_CONFIG_LIMIT: u64 = 512 * 1024;

impl MiniProgramCheck {
    fn issue(&mut self, code: &'static str, file: &str, detail: Option<&str>) {
        if self.issues.len() >= MAX_MINI_ISSUES {
            if self.issues.len() == MAX_MINI_ISSUES {
                self.issues.push(MiniProgramIssue {
                    code: "mini_check_limit",
                    file: file.to_owned(),
                    detail: None,
                });
            }
            return;
        }
        self.issues.push(MiniProgramIssue {
            code,
            file: file.to_owned(),
            detail: detail.map(|text| text.chars().take(240).collect()),
        });
    }

    fn config(
        &mut self,
        root: &Path,
        path: &str,
        optional: bool,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        match inspect_config(root, path) {
            Ok(json) => Some(json),
            Err(ConfigProblem::Missing) if optional => None,
            Err(ConfigProblem::Missing) => {
                self.issue("mini_check_missing_config", path, None);
                None
            }
            Err(ConfigProblem::Outside) => {
                self.issue("mini_check_outside_project", path, None);
                None
            }
            Err(ConfigProblem::Limit) => {
                self.issue("mini_check_limit", path, None);
                None
            }
            Err(ConfigProblem::Invalid(detail)) => {
                self.issue("mini_check_invalid_json", path, detail.as_deref());
                None
            }
        }
    }

    fn check_source(&mut self, root: &Path, base: &str) {
        for extension in ["js", "wxml"] {
            let file = format!("{base}.{extension}");
            match project_file(root, &file) {
                Ok(_) => {}
                Err(ConfigProblem::Outside) => {
                    self.issue("mini_check_outside_project", &file, None)
                }
                Err(_) => self.issue("mini_check_missing_file", &file, None),
            }
        }
    }
}

enum ConfigProblem {
    Missing,
    Outside,
    Limit,
    Invalid(Option<String>),
}

fn inspect_config(
    root: &Path,
    relative: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, ConfigProblem> {
    let file = project_file(root, relative)?;
    let bytes = config_bytes(file)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ConfigProblem::Invalid(Some(format!("{}:{}", error.line(), error.column())))
    })
}

fn project_file(root: &Path, relative: &str) -> Result<File, ConfigProblem> {
    let mut path = root.to_owned();
    for part in relative.split('/') {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ConfigProblem::Missing
            } else {
                ConfigProblem::Invalid(None)
            }
        })?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(ConfigProblem::Outside);
        }
    }
    let file = File::open(path).map_err(|_| ConfigProblem::Invalid(None))?;
    if !opened_inside(&file, root) {
        return Err(ConfigProblem::Outside);
    }
    if !file
        .metadata()
        .map_err(|_| ConfigProblem::Invalid(None))?
        .is_file()
    {
        return Err(ConfigProblem::Invalid(None));
    }
    Ok(file)
}

// Accept the trailing separator convention for package roots, but never reinterpret parent paths.
fn mini_relative(value: &str, directory: bool) -> Option<String> {
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.len() > 512 {
        return None;
    }
    let path = if directory {
        let mut directory = normalized.trim_end_matches('/');
        while let Some(relative) = directory.strip_prefix("./") {
            directory = relative;
        }
        directory
    } else {
        normalized.as_str()
    };
    if directory && (path.is_empty() || path == ".") {
        return Some(String::new());
    }
    if path.split('/').any(|part| !mini_segment(part)) {
        return None;
    }
    Some(path.to_owned())
}

fn mini_segment(part: &str) -> bool {
    !part.is_empty()
        && !part.ends_with(['.', ' '])
        && !part
            .chars()
            .any(|character| character.is_control() || ":*?\"<>|".contains(character))
}

fn join_mini(base: &str, child: &str) -> String {
    if base.is_empty() {
        child.to_owned()
    } else {
        format!("{base}/{child}")
    }
}

fn check_mini_program(folder: &Path) -> Result<MiniProgramCheck, String> {
    use serde_json::Value;
    let root = canonical_folder(folder).map_err(|_| "mini_program_invalid")?;
    let mut report = MiniProgramCheck {
        path: display_path(&root),
        pages: 0,
        issues: Vec::new(),
    };
    let project_path = "project.config.json";
    let project = report.config(&root, project_path, false);
    let content = match project
        .as_ref()
        .and_then(|config| config.get("miniprogramRoot"))
    {
        None => String::new(),
        Some(value) => match value.as_str().and_then(|path| mini_relative(path, true)) {
            Some(path) => path,
            None => {
                let code = if value.is_string() {
                    "mini_check_outside_project"
                } else {
                    "mini_check_invalid_config"
                };
                report.issue(code, project_path, Some("miniprogramRoot"));
                return Ok(report);
            }
        },
    };
    if project
        .as_ref()
        .and_then(|config| config.get("compileType"))
        .is_some_and(|kind| kind.as_str() != Some("miniprogram"))
    {
        report.issue(
            "mini_check_invalid_config",
            project_path,
            Some("compileType"),
        );
    }
    let app_path = join_mini(&content, "app.json");
    let Some(app) = report.config(&root, &app_path, false) else {
        return Ok(report);
    };
    let mut routes = Vec::new();
    let mut packages = HashSet::new();
    let has_two_names = app.contains_key("subPackages") && app.contains_key("subpackages");
    if has_two_names {
        report.issue(
            "mini_check_invalid_subpackages",
            &app_path,
            Some("subPackages / subpackages"),
        );
    }
    collect_mini_routes(&mut report, &mut routes, &app_path, "", app.get("pages"));
    match app.get("subPackages").or_else(|| app.get("subpackages")) {
        Some(Value::Array(declarations)) => {
            if declarations.len() > MAX_MINI_PAGES {
                report.issue("mini_check_limit", &app_path, Some("subPackages"));
            }
            for package in declarations.iter().take(MAX_MINI_PAGES) {
                let Some(base) = package.get("root").and_then(Value::as_str) else {
                    report.issue("mini_check_invalid_subpackages", &app_path, Some("root"));
                    continue;
                };
                let Some(base) = mini_relative(base, true).filter(|path| !path.is_empty()) else {
                    report.issue("mini_check_outside_project", &app_path, Some(base));
                    continue;
                };
                if !packages.insert(base.clone()) {
                    report.issue("mini_check_invalid_subpackages", &app_path, Some(&base));
                }
                collect_mini_routes(
                    &mut report,
                    &mut routes,
                    &app_path,
                    &base,
                    package.get("pages"),
                );
                if routes.len() >= MAX_MINI_PAGES {
                    break;
                }
            }
        }
        Some(_) => report.issue(
            "mini_check_invalid_subpackages",
            &app_path,
            Some("subPackages"),
        ),
        None => {}
    }
    let mut distinct = HashSet::new();
    let mut components = ComponentCheck::new(&root, &content, &mut report);
    components.references("app.json", &app);
    for route in routes {
        let key = if cfg!(windows) {
            route.to_lowercase()
        } else {
            route.clone()
        };
        if !distinct.insert(key) {
            components
                .report
                .issue("mini_check_duplicate_route", &app_path, Some(&route));
            continue;
        }
        let source = join_mini(&content, &route);
        components.report.check_source(&root, &source);
        let owner = format!("{route}.json");
        if let Some(page) = components
            .report
            .config(&root, &join_mini(&content, &owner), true)
        {
            components.references(&owner, &page);
        }
    }
    components.inspect();
    report.pages = distinct.len();
    Ok(report)
}

struct ComponentCheck<'a> {
    root: &'a Path,
    content: &'a str,
    report: &'a mut MiniProgramCheck,
    visited: HashSet<String>,
    pending: Vec<String>,
    references: usize,
}

impl<'a> ComponentCheck<'a> {
    fn new(root: &'a Path, content: &'a str, report: &'a mut MiniProgramCheck) -> Self {
        Self {
            root,
            content,
            report,
            visited: HashSet::new(),
            pending: Vec::new(),
            references: 0,
        }
    }

    fn references(&mut self, owner: &str, config: &serde_json::Map<String, serde_json::Value>) {
        let Some(mapping) = config.get("usingComponents") else {
            return;
        };
        let file = join_mini(self.content, owner);
        let Some(mapping) = mapping.as_object() else {
            self.report.issue(
                "mini_check_invalid_components",
                &file,
                Some("usingComponents"),
            );
            return;
        };
        for (tag, target) in mapping {
            if self.references >= MAX_MINI_COMPONENT_REFERENCES {
                if self.references == MAX_MINI_COMPONENT_REFERENCES {
                    self.report
                        .issue("mini_check_limit", &file, Some("usingComponents"));
                    self.references += 1;
                }
                break;
            }
            self.references += 1;
            let Some(target) = target.as_str().filter(|value| !value.trim().is_empty()) else {
                self.report
                    .issue("mini_check_invalid_components", &file, Some(tag));
                continue;
            };
            if tag.is_empty()
                || !tag.bytes().all(|value| {
                    value.is_ascii_lowercase() || value.is_ascii_digit() || b"-_".contains(&value)
                })
            {
                self.report
                    .issue("mini_check_invalid_components", &file, Some(tag));
                continue;
            }
            match self.resolve(owner, target) {
                ComponentTarget::Local(route) => {
                    let key = if cfg!(windows) {
                        route.to_lowercase()
                    } else {
                        route.clone()
                    };
                    if self.visited.insert(key) {
                        self.pending.push(route);
                    }
                }
                ComponentTarget::Unresolved => {
                    self.report
                        .issue("mini_check_component_unresolved", &file, Some(target))
                }
                ComponentTarget::Outside => {
                    self.report
                        .issue("mini_check_outside_project", &file, Some(target))
                }
                ComponentTarget::Invalid => {
                    self.report
                        .issue("mini_check_invalid_components", &file, Some(target))
                }
            }
        }
    }

    fn resolve(&self, owner: &str, target: &str) -> ComponentTarget {
        if target.len() > 512 || target.trim() != target || target.chars().any(char::is_control) {
            return ComponentTarget::Invalid;
        }
        let normalized = target.replace('\\', "/");
        let target = normalized.as_str();
        if [
            "plugin://",
            "dynamicLib://",
            "wx://",
            "ext://",
            "@/",
            "~/",
            "#",
            "~@/",
        ]
        .iter()
        .any(|prefix| target.starts_with(prefix))
        {
            return ComponentTarget::Unresolved;
        }
        if target.starts_with("//") || target.as_bytes().get(1) == Some(&b':') {
            return ComponentTarget::Outside;
        }
        let explicit =
            target.starts_with('/') || target.starts_with("./") || target.starts_with("../");
        let mut segments: Vec<&str> = if target.starts_with('/') {
            Vec::new()
        } else {
            owner
                .rsplit_once('/')
                .map_or_else(Vec::new, |(directory, _)| directory.split('/').collect())
        };
        for part in target.strip_prefix('/').unwrap_or(target).split('/') {
            match part {
                "." => {}
                ".." => {
                    if segments.pop().is_none() {
                        return ComponentTarget::Outside;
                    }
                }
                part if mini_segment(part) => segments.push(part),
                _ => return ComponentTarget::Invalid,
            }
        }
        if segments.is_empty()
            || [".js", ".json", ".wxml", ".wxss"]
                .iter()
                .any(|extension| target.ends_with(extension))
        {
            return ComponentTarget::Invalid;
        }
        let route = segments.join("/");
        if explicit || self.local_component_exists(&route) {
            return ComponentTarget::Local(route);
        }
        if let Some(installed) =
            mini_relative(target, false).map(|path| format!("miniprogram_npm/{path}"))
        {
            if self.local_component_exists(&installed) {
                return ComponentTarget::Local(installed);
            }
        }
        ComponentTarget::Unresolved
    }

    fn local_component_exists(&self, route: &str) -> bool {
        let route = join_mini(self.content, route);
        ["json", "js", "wxml"].iter().any(|extension| {
            !matches!(
                project_file(self.root, &format!("{route}.{extension}")),
                Err(ConfigProblem::Missing)
            )
        })
    }

    fn inspect(mut self) {
        while let Some(route) = self.pending.pop() {
            let source = join_mini(self.content, &route);
            self.report.check_source(self.root, &source);
            let owner = format!("{route}.json");
            let file = join_mini(self.content, &owner);
            if let Some(config) = self.report.config(self.root, &file, false) {
                if config.get("component").and_then(serde_json::Value::as_bool) != Some(true) {
                    self.report
                        .issue("mini_check_component_flag", &file, Some("component"));
                }
                self.references(&owner, &config);
            }
        }
    }
}

enum ComponentTarget {
    Local(String),
    Unresolved,
    Outside,
    Invalid,
}

fn collect_mini_routes(
    report: &mut MiniProgramCheck,
    routes: &mut Vec<String>,
    file: &str,
    package: &str,
    pages: Option<&serde_json::Value>,
) {
    let Some(pages) = pages
        .and_then(serde_json::Value::as_array)
        .filter(|pages| !pages.is_empty())
    else {
        report.issue(
            "mini_check_invalid_pages",
            file,
            Some(if package.is_empty() { "pages" } else { package }),
        );
        return;
    };
    let available = MAX_MINI_PAGES.saturating_sub(routes.len());
    if pages.len() > available {
        report.issue("mini_check_limit", file, Some("pages"));
    }
    for page in pages.iter().take(available) {
        let Some(raw) = page.as_str().filter(|route| !route.trim().is_empty()) else {
            report.issue("mini_check_invalid_route", file, None);
            continue;
        };
        if let Some(route) = mini_relative(raw, false) {
            routes.push(join_mini(package, &route));
        } else {
            report.issue("mini_check_outside_project", file, Some(raw));
        }
    }
}

fn read_config(root: &Path, path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let (file, _, _) = checked_file(root, path)?;
    serde_json::from_slice(&config_bytes(file).ok()?).ok()
}

fn config_bytes(file: File) -> Result<Vec<u8>, ConfigProblem> {
    let mut bytes = Vec::new();
    file.take(MINI_CONFIG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ConfigProblem::Invalid(None))?;
    if bytes.len() as u64 > MINI_CONFIG_LIMIT {
        return Err(ConfigProblem::Limit);
    }
    if bytes.starts_with(b"\xef\xbb\xbf") {
        bytes.drain(..3);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned()
}

#[cfg(not(windows))]
fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn wechat_cli() -> Option<PathBuf> {
    const PRODUCT_FOLDERS: &[&str] = &[
        "Tencent/微信web开发者工具",
        "Tencent/微信开发者工具",
        "Tencent/WeChat DevTools",
        "微信web开发者工具",
        "微信开发者工具",
        "WeChat DevTools",
        "wechatwebdevtools",
    ];
    let roots = [
        "ProgramW6432",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
    ]
    .into_iter()
    .filter_map(std::env::var_os)
    .map(PathBuf::from)
    .filter(|root| root.is_absolute());
    for root in roots {
        for name in PRODUCT_FOLDERS {
            for base in [root.join(name), root.join("Programs").join(name)] {
                if let Some(cli) = cli_at(&base) {
                    return Some(cli);
                }
            }
        }
    }
    let exe = std::env::var_os("SystemRoot")
        .map(PathBuf::from)?
        .join("System32/reg.exe");
    for key in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\wechatwebdevtools.exe",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\wechatwebdevtools.exe",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\wechatwebdevtools.exe",
    ] {
        let output = tool_command(&exe)
            .args(["query", key, "/ve"])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some((_, value)) = line.split_once("REG_SZ") {
                let path = PathBuf::from(value.trim().trim_matches('"'));
                if let Some(cli) = path
                    .parent()
                    .filter(|base| base.is_absolute())
                    .and_then(cli_at)
                {
                    return Some(cli);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn cli_at(base: &Path) -> Option<PathBuf> {
    ["cli.exe", "cli.bat"]
        .into_iter()
        .map(|name| base.join(name))
        .find(|file| file.is_file())
}

#[cfg(target_os = "macos")]
fn wechat_cli() -> Option<PathBuf> {
    [
        "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
        "/Applications/微信开发者工具.app/Contents/MacOS/cli",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|file| file.is_file())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn wechat_cli() -> Option<PathBuf> {
    None
}

fn tool_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn launch_wechat(cli: &Path, root: &Path) -> Result<(), String> {
    let args = wechat_arguments(cli, root)?;
    let mut child = tool_command(cli)
        .args(args)
        .current_dir(cli.parent().ok_or("mini_program_open_failed")?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "mini_program_open_failed")?;
    let deadline = Instant::now() + Duration::from_secs(18);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => return Err("mini_program_open_failed".into()),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("mini_program_open_failed".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(120)),
        }
    }
}

fn wechat_arguments(cli: &Path, root: &Path) -> Result<[String; 3], String> {
    let project = display_path(root);
    #[cfg(windows)]
    if cli
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bat"))
        && project
            .chars()
            .any(|character| character.is_control() || "%!^&|<>\"".contains(character))
    {
        return Err("mini_program_open_failed".into());
    }
    #[cfg(not(windows))]
    let _ = cli;
    Ok(["open".into(), "--project".into(), project])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, path: &str, headers: &str) -> String {
        let host = url.trim_start_matches("http://").split('/').next().unwrap();
        let mut stream = TcpStream::connect(host).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {host}\r\n{headers}Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut result = String::new();
        stream.read_to_string(&mut result).unwrap();
        result
    }

    fn url_path(url: &str) -> &str {
        let base = url.trim_start_matches("http://");
        &base[base.find('/').unwrap()..]
    }

    #[test]
    fn generated_preview_expires_when_stopped() {
        let server = PreviewServer::default();
        let url = server
            .start(Site::Html(b"<h1>Preview QA</h1>".to_vec()))
            .unwrap();
        let path = url_path(&url);
        assert!(url.starts_with("http://127.0.0.1:"));
        let response = request(&url, path, "");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Content-Type: text/html; charset=utf-8"));
        assert!(response.contains("connect-src 'self'"));
        assert!(response.ends_with("<h1>Preview QA</h1>"));
        assert!(request(&url, "/", "").starts_with("HTTP/1.1 404"));
        server.stop().unwrap();
        assert!(
            TcpStream::connect(url.trim_start_matches("http://").split('/').next().unwrap())
                .is_err()
        );
    }

    #[test]
    fn static_preview_has_mime_ranges_and_directory_boundaries() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("sample site");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(
            root.join("index.html"),
            "<script type='module' src='/assets/site.js'></script>",
        )
        .unwrap();
        fs::write(root.join("assets/site.js"), "document.title = 'Static QA'").unwrap();
        fs::write(root.join(".env"), "synthetic fixture").unwrap();
        fs::write(fixture.path().join("outside.txt"), "outside fixture").unwrap();
        let server = PreviewServer::default();
        let url = server
            .start(Site::Folder(canonical_folder(&root).unwrap()))
            .unwrap();
        let base = url_path(&url);
        assert!(request(&url, &format!("{base}assets/site.js"), "")
            .contains("Content-Type: text/javascript; charset=utf-8"));
        let range = request(
            &url,
            &format!("{base}assets/site.js"),
            "Range: bytes=0-7\r\n",
        );
        assert!(range.starts_with("HTTP/1.1 206"));
        assert!(range.ends_with("document"));
        assert!(request(&url, "/assets/site.js", "").starts_with("HTTP/1.1 404"));
        assert!(
            request(&url, "/assets/site.js", &format!("Referer: {url}\r\n"))
                .contains(&format!("Location: {base}assets/site.js"))
        );
        for suffix in [
            "%2e%2e/outside.txt",
            "assets%2fsite.js",
            ".env",
            "%5c..%5coutside.txt",
        ] {
            assert!(request(&url, &format!("{base}{suffix}"), "").starts_with("HTTP/1.1 404"));
        }
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(
            fixture.path().join("outside.txt"),
            root.join("outside.txt"),
        )
        .is_ok()
        {
            assert!(request(&url, &format!("{base}outside.txt"), "").starts_with("HTTP/1.1 404"));
        }
    }

    #[test]
    fn mini_program_reads_config_and_validates_cli_arguments() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("sample project");
        fs::create_dir_all(root.join("miniprogram")).unwrap();
        fs::write(
            root.join("project.config.json"),
            r#"{"compileType":"miniprogram","miniprogramRoot":"miniprogram/"}"#,
        )
        .unwrap();
        assert_eq!(
            mini_program_root(&root).unwrap_err(),
            "mini_program_invalid"
        );
        fs::write(
            root.join("miniprogram/app.json"),
            r#"{"pages":["pages/index/index"],"window":{"navigationBarTitleText":"Preview"}}"#,
        )
        .unwrap();
        let project = mini_program_root(&root).unwrap();
        let cli = fixture.path().join("cli.bat");
        assert_eq!(
            wechat_arguments(&cli, &project).unwrap(),
            ["open", "--project", &display_path(&project)]
        );
        #[cfg(windows)]
        {
            // A synthetic executable fixture records its inputs without starting DevTools.
            fs::write(
                &cli,
                "@echo off\r\n(echo %~1&echo %~2&echo %~3)>args.txt\r\n",
            )
            .unwrap();
            launch_wechat(&cli, &project).unwrap();
            let args = fs::read_to_string(fixture.path().join("args.txt")).unwrap();
            assert_eq!(
                args.lines().collect::<Vec<_>>(),
                ["open", "--project", &display_path(&project)]
            );
        }
        fs::write(
            root.join("project.config.json"),
            r#"{"miniprogramRoot":"../"}"#,
        )
        .unwrap();
        assert_eq!(
            mini_program_root(&root).unwrap_err(),
            "mini_program_invalid"
        );
    }

    #[test]
    fn offline_mini_program_accepts_main_pages_and_nested_packages() {
        let fixture = tempfile::tempdir().unwrap();
        let site = fixture.path().join("mini source");
        fs::create_dir_all(site.join("pages/index")).unwrap();
        fs::create_dir_all(site.join("extra/inspect")).unwrap();
        fs::write(
            fixture.path().join("project.config.json"),
            r#"{"miniprogramRoot":"./mini source/","compileType":"miniprogram"}"#,
        )
        .unwrap();
        fs::write(site.join("app.json"), r#"{"pages":["pages/index/index"],"subPackages":[{"root":"extra/","pages":["inspect/inspect"]}]}"#).unwrap();
        for route in ["pages/index/index", "extra/inspect/inspect"] {
            fs::write(site.join(format!("{route}.js")), "Page({})").unwrap();
            fs::write(site.join(format!("{route}.wxml")), "<view>Fixture</view>").unwrap();
        }
        fs::write(
            site.join("pages/index/index.json"),
            r#"{"navigationBarTitleText":"Fixture"}"#,
        )
        .unwrap();
        let result = check_mini_program(fixture.path()).unwrap();
        assert_eq!(result.pages, 2);
        assert!(result.issues.is_empty());
    }

    #[test]
    fn offline_mini_program_reports_invalid_json_routes_scope_and_missing_files() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir_all(root.join("main/demo")).unwrap();
        fs::write(
            root.join("project.config.json"),
            r#"{"compileType":"miniprogram","miniprogramRoot":"main/"}"#,
        )
        .unwrap();
        fs::write(root.join("main/app.json"), r#"{"pages":["demo/item","demo/item",7,"../outside"],"subpackages":[{"root":"../escape","pages":["index"]},{"root":"extra","pages":"invalid"}]}"#).unwrap();
        fs::write(root.join("main/demo/item.json"), "{\n malformed}").unwrap();
        let report = check_mini_program(root).unwrap();
        let contains = |code, file| {
            report
                .issues
                .iter()
                .any(|issue| issue.code == code && issue.file == file)
        };
        assert_eq!(report.pages, 1);
        for code in [
            "mini_check_duplicate_route",
            "mini_check_invalid_route",
            "mini_check_outside_project",
            "mini_check_invalid_pages",
        ] {
            assert!(contains(code, "main/app.json"));
        }
        assert!(contains("mini_check_missing_file", "main/demo/item.js"));
        assert!(contains("mini_check_missing_file", "main/demo/item.wxml"));
        assert!(contains("mini_check_invalid_json", "main/demo/item.json"));
        let invalid = report
            .issues
            .iter()
            .find(|issue| issue.code == "mini_check_invalid_json")
            .unwrap();
        assert!(invalid
            .detail
            .as_deref()
            .is_some_and(|detail| detail.starts_with("2:")));
        fs::write(
            root.join("project.config.json"),
            r#"{"miniprogramRoot":"../"}"#,
        )
        .unwrap();
        let report = check_mini_program(root).unwrap();
        assert_eq!(report.pages, 0);
        assert_eq!(report.issues[0].code, "mini_check_outside_project");
    }

    #[test]
    fn offline_mini_program_validates_components_in_app_pages_and_installed_packages() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let content = root.join("miniprogram");
        fs::create_dir_all(content.join("pages/index")).unwrap();
        fs::write(
            root.join("project.config.json"),
            r#"{"miniprogramRoot":"miniprogram/"}"#,
        )
        .unwrap();
        fs::write(content.join("app.json"), r#"{"pages":["pages/index/index"],"usingComponents":{"global-card":"/components/card/index"}}"#).unwrap();
        let page = content.join("pages/index/index");
        fs::write(page.with_extension("js"), "Page({})").unwrap();
        fs::write(page.with_extension("wxml"), "<global-card/><npm-icon/>").unwrap();
        fs::write(page.with_extension("json"), r#"{"usingComponents":{"page-card":"../../components/card/index","npm-icon":"@qa/icons/glyph"}}"#).unwrap();
        for (route, config) in [
            (
                "components/card/index",
                r#"{"component":true,"usingComponents":{"nested":"../nested/index"}}"#,
            ),
            (
                "components/nested/index",
                r#"{"component":true,"usingComponents":{"cyclic":"/components/card/index"}}"#,
            ),
            ("miniprogram_npm/@qa/icons/glyph", r#"{"component":true}"#),
        ] {
            let file = content.join(route);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file.with_extension("js"), "Component({})").unwrap();
            fs::write(file.with_extension("wxml"), "<view>Test</view>").unwrap();
            fs::write(file.with_extension("json"), config).unwrap();
        }
        let check = check_mini_program(root).unwrap();
        assert_eq!(check.pages, 1);
        assert!(check.issues.is_empty());
    }

    #[test]
    fn offline_mini_program_distinguishes_bad_local_components_and_deferred_resolution() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir_all(root.join("components/card")).unwrap();
        fs::create_dir_all(root.join("pages/index")).unwrap();
        fs::write(root.join("project.config.json"), "{}").unwrap();
        fs::write(root.join("app.json"), r#"{"pages":["pages/index/index"],"usingComponents":{"card":"/components/card/index","icon":"plugin://icons/glyph","alias":"@/components/alias","npm":"@qa/icons/icon","invalid":5}}"#).unwrap();
        let page = root.join("pages/index/index");
        fs::write(page.with_extension("js"), "Page({})").unwrap();
        fs::write(page.with_extension("wxml"), "<view/>").unwrap();
        fs::write(page.with_extension("json"), r#"{"usingComponents":{"escaped":"../../../outside","card":"../../components/card/index"}}"#).unwrap();
        fs::write(root.join("components/card/index.js"), "Component({})").unwrap();
        fs::write(
            root.join("components/card/index.json"),
            r#"{"component":false,"usingComponents":[]}"#,
        )
        .unwrap();
        let report = check_mini_program(root).unwrap();
        let count = |code, file| {
            report
                .issues
                .iter()
                .filter(|issue| issue.code == code && issue.file == file)
                .count()
        };
        assert_eq!(report.pages, 1);
        assert_eq!(count("mini_check_component_unresolved", "app.json"), 3);
        assert_eq!(count("mini_check_invalid_components", "app.json"), 1);
        assert_eq!(
            count("mini_check_outside_project", "pages/index/index.json"),
            1
        );
        assert_eq!(
            count("mini_check_missing_file", "components/card/index.wxml"),
            1
        );
        assert_eq!(
            count("mini_check_component_flag", "components/card/index.json"),
            1
        );
        assert_eq!(
            count(
                "mini_check_invalid_components",
                "components/card/index.json"
            ),
            1
        );
        assert_eq!(report.issues.len(), 8);
    }
}
