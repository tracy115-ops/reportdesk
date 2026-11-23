use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager, State,
};
use tauri_plugin_dialog::DialogExt;

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ZIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 300;
const MAX_ENTRIES: usize = 30_000;
const FORMAT_EXTENSIONS: &[&str] = &["docx", "xlsx", "pptx", "pdf", "csv", "txt", "md"];
const BACKUP_EXTENSION: &str = "officebackup";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    path: PathBuf,
    name: String,
    directory: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    relative: String,
    size: u64,
    modified: Option<String>,
}

#[derive(Serialize)]
pub struct ScanResult {
    files: Vec<Material>,
    skipped: usize,
    limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    sources: Vec<Source>,
    selected_ids: Vec<String>,
    added: usize,
    skipped: usize,
}

impl Selection {
    pub fn has_selection(&self) -> bool {
        !self.selected_ids.is_empty()
    }
}

pub struct Sources {
    file: PathBuf,
    entries: Mutex<Vec<Source>>,
    restoring: AtomicBool,
}

impl Sources {
    pub fn load(file: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let entries = match File::open(&file) {
            Ok(data) => serde_json::from_reader(data)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            file,
            entries: Mutex::new(entries),
            restoring: AtomicBool::new(false),
        })
    }

    fn find(&self, id: &str) -> Result<Source, String> {
        self.entries
            .lock()
            .map_err(io_error)?
            .iter()
            .find(|source| source.id == id)
            .cloned()
            .ok_or_else(|| "source_removed".into())
    }

    fn save(&self, entries: &[Source]) -> Result<(), String> {
        let directory = self.file.parent().ok_or("source_unavailable")?;
        let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(io_error)?;
        serde_json::to_writer(&mut staged, entries).map_err(io_error)?;
        staged.as_file().sync_all().map_err(io_error)?;
        staged.persist(&self.file).map_err(io_error)?;
        Ok(())
    }

    pub fn register(&self, paths: Vec<PathBuf>) -> Result<Selection, String> {
        let mut skipped = 0;
        let mut selected = Vec::new();
        for original in paths {
            let Ok(path) = canonical(&original) else {
                skipped += 1;
                continue;
            };
            let directory = path.is_dir();
            if !directory && (!path.is_file() || !supported(&path)) {
                skipped += 1;
                continue;
            }
            let path = PathBuf::from(display_path(&path));
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| display_path(&path));
            selected.push(Source {
                id: uuid::Uuid::new_v4().to_string(),
                path,
                name,
                directory,
                original_name: None,
            });
        }
        let mut entries = self.entries.lock().map_err(io_error)?;
        if self.restoring.load(Ordering::Acquire) {
            return Err("workspace_busy".into());
        }
        let mut next = entries.clone();
        let mut selected_ids = Vec::new();
        for source in selected {
            if let Some(existing) = next.iter().find(|item| item.path == source.path) {
                selected_ids.push(existing.id.clone());
            } else {
                selected_ids.push(source.id.clone());
                next.push(source);
            }
        }
        let added = next.len() - entries.len();
        if added > 0 {
            self.save(&next)?;
            *entries = next;
        }
        Ok(Selection {
            sources: entries.clone(),
            selected_ids,
            added,
            skipped,
        })
    }
}

fn io_error(_: impl std::fmt::Display) -> String {
    "file_access".into()
}

fn supported(path: &Path) -> bool {
    let temporary = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("~$") || name.starts_with('.'));
    !temporary
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| FORMAT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|_| "source_unavailable".into())
}

pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

#[tauri::command]
pub fn list_sources(state: State<'_, Sources>) -> Result<Vec<Source>, String> {
    state
        .entries
        .lock()
        .map(|entries| entries.clone())
        .map_err(io_error)
}

#[tauri::command]
pub async fn pick_sources(
    app: AppHandle,
    directory: bool,
    state: State<'_, Sources>,
) -> Result<Selection, String> {
    let selection = tauri::async_runtime::spawn_blocking(move || {
        if directory {
            app.dialog()
                .file()
                .blocking_pick_folder()
                .into_iter()
                .collect()
        } else {
            app.dialog()
                .file()
                .add_filter("Office", FORMAT_EXTENSIONS)
                .blocking_pick_files()
                .unwrap_or_default()
        }
    })
    .await
    .map_err(io_error)?;
    state.register(
        selection
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .collect(),
    )
}

#[tauri::command]
pub fn remove_source(id: String, state: State<'_, Sources>) -> Result<Vec<Source>, String> {
    let mut entries = state.entries.lock().map_err(io_error)?;
    if state.restoring.load(Ordering::Acquire) {
        return Err("workspace_busy".into());
    }
    let mut next = entries.clone();
    next.retain(|source| source.id != id);
    state.save(&next)?;
    *entries = next;
    Ok(entries.clone())
}

#[tauri::command]
pub fn set_workspace_restore(active: bool, state: State<'_, Sources>) -> Result<(), String> {
    let _entries = state.entries.lock().map_err(io_error)?;
    state.restoring.store(active, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn replace_workspace_sources(
    sources: Vec<Source>,
    state: State<'_, Sources>,
) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for source in &sources {
        if uuid::Uuid::parse_str(&source.id).is_err()
            || !ids.insert(&source.id)
            || !source.path.is_absolute()
            || !paths.insert(&source.path)
            || source.name.trim().is_empty()
            || (!source.directory && !supported(&source.path))
        {
            return Err("backup_invalid".into());
        }
    }
    let mut entries = state.entries.lock().map_err(io_error)?;
    state.save(&sources)?;
    *entries = sources;
    Ok(())
}

#[tauri::command]
pub async fn relink_source(
    app: AppHandle,
    id: String,
    state: State<'_, Sources>,
) -> Result<Option<Vec<Source>>, String> {
    let source = state.find(&id)?;
    let directory = source.directory;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        if directory {
            picker.blocking_pick_folder()
        } else {
            picker
                .add_filter("Office", FORMAT_EXTENSIONS)
                .blocking_pick_file()
        }
    })
    .await
    .map_err(io_error)?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let current = canonical(&chosen.into_path().map_err(io_error)?)?;
    let valid = if directory {
        current.is_dir()
    } else {
        current.is_file() && supported(&current)
    };
    if !valid {
        return Err("source_unavailable".into());
    }
    let path = PathBuf::from(display_path(&current));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_path(&path));
    let mut entries = state.entries.lock().map_err(io_error)?;
    if state.restoring.load(Ordering::Acquire) {
        return Err("workspace_busy".into());
    }
    if entries
        .iter()
        .any(|item| item.id != id && item.path == path)
    {
        return Err("source_already_registered".into());
    }
    let mut next = entries.clone();
    let entry = next
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or("source_removed")?;
    if !directory && entry.original_name.is_none() && entry.name != name {
        entry.original_name = Some(entry.name.clone());
    }
    entry.path = path;
    entry.name = name;
    state.save(&next)?;
    *entries = next;
    Ok(Some(entries.clone()))
}

#[tauri::command]
pub async fn pick_workspace_backup(app: AppHandle) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let Some(selection) = app
            .dialog()
            .file()
            .add_filter("Office Workspace Backup", &[BACKUP_EXTENSION])
            .blocking_pick_file()
        else {
            return Ok(Vec::new());
        };
        let path = selection.into_path().map_err(io_error)?;
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(BACKUP_EXTENSION))
        {
            return Err("backup_invalid".into());
        }
        let file = File::open(path).map_err(io_error)?;
        let mut bytes = Vec::new();
        file.take(MAX_ZIP_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 > MAX_ZIP_BYTES {
            return Err("backup_too_large".into());
        }
        if bytes.is_empty() {
            return Err("backup_invalid".into());
        }
        Ok(bytes)
    })
    .await
    .map_err(io_error)??;
    Ok(Response::new(bytes))
}

fn source_root(source: &Source) -> Result<PathBuf, String> {
    let root = canonical(&source.path)?;
    if display_path(&root) != display_path(&source.path) {
        return Err("source_unavailable".into());
    }
    Ok(root)
}

fn metadata(relative: String, entry: fs::Metadata) -> Material {
    let modified = entry
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string());
    Material {
        relative,
        size: entry.len(),
        modified,
    }
}

fn scan(source: Source) -> Result<ScanResult, String> {
    let root = source_root(&source)?;
    let mut result = ScanResult {
        files: Vec::new(),
        skipped: 0,
        limited: false,
    };
    if !source.directory {
        let info = fs::metadata(root).map_err(io_error)?;
        if !info.is_file() {
            return Err("source_unavailable".into());
        }
        result.files.push(metadata(source.name, info));
        return Ok(result);
    }
    let mut directories = vec![root.clone()];
    let mut visited = 0;
    'walk: while let Some(dir) = directories.pop() {
        let Ok(current) = canonical(&dir) else {
            result.skipped += 1;
            continue;
        };
        if !current.starts_with(&root) || current != dir {
            continue;
        }
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) if current == root => return Err("source_unavailable".into()),
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let mut items = Vec::new();
        for entry in entries {
            visited += 1;
            if visited > MAX_ENTRIES {
                result.limited = true;
                break;
            }
            match entry {
                Ok(entry) => items.push(entry),
                Err(_) => result.skipped += 1,
            }
        }
        items.sort_by_key(|entry| entry.file_name());
        let mut children = Vec::new();
        for entry in items {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                result.skipped += 1;
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                children.push(path);
            } else if kind.is_file() && supported(&path) {
                if result.files.len() == MAX_FILES {
                    result.limited = true;
                    break 'walk;
                }
                let Ok(info) = entry.metadata() else {
                    result.skipped += 1;
                    continue;
                };
                let relative = path
                    .strip_prefix(&root)
                    .map_err(io_error)?
                    .to_string_lossy()
                    .into_owned();
                result.files.push(metadata(relative, info));
            }
        }
        if result.limited {
            break;
        }
        directories.extend(children.into_iter().rev());
    }
    result.files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(result)
}

#[tauri::command]
pub async fn scan_source(id: String, state: State<'_, Sources>) -> Result<ScanResult, String> {
    let source = state.find(&id)?;
    tauri::async_runtime::spawn_blocking(move || scan(source))
        .await
        .map_err(io_error)?
}

fn resolve_material(source: &Source, relative: &str) -> Result<PathBuf, String> {
    let root = source_root(&source)?;
    let path = if source.directory {
        let relative = Path::new(relative);
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("source_unavailable".into());
        }
        let target = canonical(&root.join(relative))?;
        if !target.starts_with(&root) {
            return Err("source_unavailable".into());
        }
        target
    } else if relative == source.name {
        root
    } else {
        return Err("source_unavailable".into());
    };
    if !supported(&path) || !fs::metadata(&path).map_err(io_error)?.is_file() {
        return Err("unsupported_file".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn read_material(
    id: String,
    relative: String,
    state: State<'_, Sources>,
) -> Result<Response, String> {
    let source = state.find(&id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let path = resolve_material(&source, &relative)?;
        let mut data = Vec::new();
        File::open(path)
            .map_err(io_error)?
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(io_error)?;
        if data.len() as u64 > MAX_FILE_BYTES {
            return Err("file_too_large".into());
        }
        Ok(data)
    })
    .await
    .map_err(io_error)??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn open_material(
    id: String,
    relative: String,
    state: State<'_, Sources>,
) -> Result<(), String> {
    let source = state.find(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_material(&source, &relative)?;
        open::that_detached(display_path(&path)).map_err(|_| "open_failed".into())
    })
    .await
    .map_err(io_error)?
}

fn artifact_request(
    request: Request<'_>,
) -> Result<(String, &'static str, &'static str, Vec<u8>), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("export_failed".into());
    };
    let len = body
        .get(..4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or("export_failed")? as usize;
    if len == 0 || len > 512 || body.len() <= 4 + len {
        return Err("export_failed".into());
    }
    let name = std::str::from_utf8(&body[4..4 + len]).map_err(|_| "export_extension")?;
    let (label, extension) = match Path::new(name).extension().and_then(|ext| ext.to_str()) {
        Some("docx") => ("Word", "docx"),
        Some("xlsx") => ("Excel", "xlsx"),
        Some("pptx") => ("PowerPoint", "pptx"),
        Some("pdf") => ("PDF", "pdf"),
        Some("html") => ("HTML", "html"),
        Some("png") => ("PNG", "png"),
        Some("mp3") => ("MP3", "mp3"),
        Some("mp4") => ("MP4", "mp4"),
        Some("zip") => ("ZIP", "zip"),
        Some(BACKUP_EXTENSION) => ("Office Workspace Backup", BACKUP_EXTENSION),
        _ => return Err("export_extension".into()),
    };
    let data = &body[4 + len..];
    let (limit, limit_error) = match extension {
        "zip" => (MAX_ZIP_BYTES, "zip_export_limit"),
        BACKUP_EXTENSION => (MAX_ZIP_BYTES, "backup_too_large"),
        _ => (MAX_FILE_BYTES, "export_limit"),
    };
    if data.len() as u64 > limit {
        return Err(limit_error.into());
    }
    let valid = match extension {
        "pdf" => data.starts_with(b"%PDF-"),
        "html" => data.starts_with(b"<!doctype html>"),
        "png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "mp3" => data.starts_with(b"ID3") || data.get(0..2).is_some_and(|bytes| bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0),
        "mp4" => data.get(4..8) == Some(b"ftyp"),
        _ => data.starts_with(b"PK\x03\x04"),
    };
    if !valid {
        return Err("export_failed".into());
    }
    let stem = name[..name.len() - extension.len() - 1]
        .chars()
        .filter(|ch| !ch.is_control() && !r#"<>:"/\|?*"#.contains(*ch))
        .take(100)
        .collect::<String>();
    let stem = stem.trim_matches(|ch: char| ch.is_whitespace() || ch == '.');
    Ok((
        format!(
            "{}.{extension}",
            if stem.is_empty() { "Document" } else { stem }
        ),
        label,
        extension,
        data.to_vec(),
    ))
}

#[tauri::command]
pub async fn read_export_font() -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let windows = std::env::var_os("WINDIR").map(PathBuf::from).ok_or("creative_pdf_font")?;
        for name in ["simhei.ttf", "Deng.ttf"] {
            let path = windows.join("Fonts").join(name);
            if !path.is_file() { continue; }
            let size = fs::metadata(&path).map_err(|_| "creative_pdf_font")?.len();
            if size > 24 * 1024 * 1024 { continue; }
            let bytes = fs::read(path).map_err(|_| "creative_pdf_font")?;
            return Ok(Response::new(bytes));
        }
        Err("creative_pdf_font".into())
    }).await.map_err(|_| "creative_pdf_font")?
}

#[tauri::command]
pub async fn save_artifact(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let (filename, label, extension, data) = artifact_request(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = app
            .dialog()
            .file()
            .add_filter(label, &[extension])
            .set_file_name(filename)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let mut path = selection.into_path().map_err(io_error)?;
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
        {
            return Err("export_extension".into());
        }
        if path.is_relative() {
            return Err("export_failed".into());
        }
        let parent = path.parent().ok_or("export_failed")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        staged.write_all(&data).map_err(io_error)?;
        staged.as_file().sync_all().map_err(io_error)?;
        path = parent.join(path.file_name().ok_or("export_failed")?);
        staged.persist(&path).map_err(io_error)?;
        Ok(Some(display_path(&path)))
    })
    .await
    .map_err(io_error)?
}

#[tauri::command]
pub async fn open_artifact(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let (filename, _, extension, data) = artifact_request(request)?;
    if extension == BACKUP_EXTENSION {
        return Err("export_extension".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .path()
            .app_cache_dir()
            .map_err(io_error)?
            .join("opened-copies");
        fs::create_dir_all(&root).map_err(io_error)?;
        let copy = tempfile::Builder::new()
            .prefix("copy-")
            .tempdir_in(root)
            .map_err(io_error)?;
        let path = copy.path().join(filename);
        fs::write(&path, data).map_err(io_error)?;
        open::that_detached(&path).map_err(|_| "open_failed")?;
        let _ = copy.keep();
        Ok(())
    })
    .await
    .map_err(io_error)?
}
