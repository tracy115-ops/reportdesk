use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentFolder {
    id: String,
    path: PathBuf,
}

pub struct AgentFolders {
    registry: PathBuf,
    folders: Mutex<Vec<AgentFolder>>,
}

impl AgentFolders {
    pub fn load(registry: PathBuf) -> Self {
        let folders = File::open(&registry)
            .ok()
            .and_then(|file| serde_json::from_reader(file).ok())
            .unwrap_or_default();
        Self {
            registry,
            folders: Mutex::new(folders),
        }
    }

    fn register(&self, path: PathBuf) -> Result<AgentFolder, String> {
        let canonical = fs::canonicalize(path).map_err(|_| "agent_folder_unavailable")?;
        if !canonical.is_dir() {
            return Err("agent_folder_unavailable".into());
        }
        let path = PathBuf::from(crate::sources::display_path(&canonical));
        let mut folders = self.folders.lock().map_err(|_| "storage_error")?;
        if let Some(folder) = folders.iter().find(|folder| folder.path == path) {
            return Ok(folder.clone());
        }
        let folder = AgentFolder {
            id: uuid::Uuid::new_v4().to_string(),
            path,
        };
        let mut updated = folders.clone();
        updated.push(folder.clone());
        let mut file =
            tempfile::NamedTempFile::new_in(self.registry.parent().ok_or("storage_error")?)
                .map_err(|_| "storage_error")?;
        serde_json::to_writer(&mut file, &updated).map_err(|_| "storage_error")?;
        file.as_file().sync_all().map_err(|_| "storage_error")?;
        file.persist(&self.registry).map_err(|_| "storage_error")?;
        *folders = updated;
        Ok(folder)
    }

    pub fn resolve(&self, id: &str) -> Result<PathBuf, String> {
        let path = self
            .folders
            .lock()
            .map_err(|_| "storage_error")?
            .iter()
            .find(|folder| folder.id == id)
            .map(|folder| folder.path.clone())
            .ok_or("agent_folder_unavailable")?;
        let canonical = fs::canonicalize(&path).map_err(|_| "agent_folder_unavailable")?;
        if !path.is_absolute()
            || !canonical.is_dir()
            || PathBuf::from(crate::sources::display_path(&canonical)) != path
        {
            return Err("agent_folder_unavailable".into());
        }
        Ok(path)
    }
}

#[tauri::command]
pub async fn agent_pick_folder(app: AppHandle) -> Result<Option<AgentFolder>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|file| {
                let path = file.into_path().map_err(|_| "agent_folder_unavailable")?;
                app.state::<AgentFolders>().register(path)
            })
            .transpose()
    })
    .await
    .map_err(|_| "agent_folder_unavailable".to_owned())?
}

#[tauri::command]
pub fn agent_open_folder(folders: State<'_, AgentFolders>, id: String) -> Result<(), String> {
    open::that_detached(folders.resolve(&id)?).map_err(|_| "open_failed".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanges {
    folder_id: String,
    files: Vec<WorkspaceFile>,
    limited: bool,
}

#[derive(Serialize)]
struct WorkspaceFile {
    path: String,
    change: &'static str,
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: Option<SystemTime>,
}

#[derive(Default)]
pub struct WorkspaceSnapshot {
    files: HashMap<PathBuf, FileStamp>,
    limited: bool,
}

fn ignored_directory(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".svn" | "node_modules" | "target" | ".venv" | "__pycache__"
    )
}

impl WorkspaceSnapshot {
    pub fn read(root: &Path) -> Self {
        let mut snapshot = Self::default();
        let Ok(root) = fs::canonicalize(root) else {
            snapshot.limited = true;
            return snapshot;
        };
        let mut directories = vec![root.clone()];
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut visited = 0;
        while let Some(dir) = directories.pop() {
            if fs::canonicalize(&dir).as_ref().ok() != Some(&dir) {
                snapshot.limited = true;
                continue;
            }
            let Ok(entries) = fs::read_dir(dir) else {
                snapshot.limited = true;
                continue;
            };
            for entry in entries {
                visited += 1;
                if visited > 12_000 || Instant::now() >= deadline {
                    snapshot.limited = true;
                    return snapshot;
                }
                let Ok(entry) = entry else {
                    snapshot.limited = true;
                    continue;
                };
                let Ok(info) = entry.metadata() else {
                    snapshot.limited = true;
                    continue;
                };
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if info.file_attributes() & 0x400 != 0 {
                        continue;
                    } // Reparse point
                }
                let path = entry.path();
                if info.is_dir() && !ignored_directory(&entry.file_name().to_string_lossy()) {
                    directories.push(path);
                } else if info.is_file() {
                    if let Ok(relative) = path.strip_prefix(&root) {
                        snapshot.files.insert(
                            relative.to_path_buf(),
                            FileStamp {
                                size: info.len(),
                                modified: info.modified().ok(),
                            },
                        );
                    }
                }
            }
        }
        snapshot
    }

    pub fn changes(self, after: Self, folder_id: String) -> WorkspaceChanges {
        let mut changes = Vec::new();
        for (path, stamp) in after.files {
            let change = match self.files.get(&path) {
                None if !self.limited => "created",
                Some(previous) if previous != &stamp => "modified",
                _ => continue,
            };
            changes.push((
                stamp.modified,
                WorkspaceFile {
                    path: path.to_string_lossy().into_owned(),
                    change,
                },
            ));
        }
        changes.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.path.cmp(&right.1.path))
        });
        let limited = self.limited || after.limited || changes.len() > 40;
        let files = changes.into_iter().take(40).map(|(_, file)| file).collect();
        WorkspaceChanges {
            folder_id,
            files,
            limited,
        }
    }
}

#[tauri::command]
pub async fn agent_reveal_file(app: AppHandle, id: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folders = app.state::<AgentFolders>();
        let root =
            fs::canonicalize(folders.resolve(&id)?).map_err(|_| "agent_folder_unavailable")?;
        let relative = Path::new(&path);
        if path.is_empty()
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("agent_file_unavailable".into());
        }
        let file = fs::canonicalize(root.join(relative)).map_err(|_| "agent_file_unavailable")?;
        if !file.starts_with(&root) || !file.is_file() {
            return Err("agent_file_unavailable".into());
        }
        open::that_detached(crate::sources::display_path(
            file.parent().ok_or("agent_file_unavailable")?,
        ))
        .map_err(|_| "open_failed".into())
    })
    .await
    .map_err(|_| "open_failed".to_owned())?
}
