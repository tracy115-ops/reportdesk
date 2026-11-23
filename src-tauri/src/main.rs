#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_activity;
mod agent_workspace;
mod browser;
mod codex;
mod mcp;
mod project_preview;
mod providers;
mod sources;
#[cfg(windows)]
mod windows_proxy;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(sources::Sources::load(dir.join("sources.json"))?);
            app.manage(codex::CodexJob::default());
            app.manage(agent_workspace::AgentFolders::load(dir.join("agent-folders.json")));
            app.manage(mcp::McpRegistry::new(dir.join("mcp-servers.json"))?);
            app.manage(project_preview::PreviewServer::default());
            app.manage(providers::Providers::new(dir.join("providers.json"))?);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::DragDrop(DragDropEvent::Enter { .. }) => {
                    let _ = window.emit("office-dragging", true);
                }
                WindowEvent::DragDrop(DragDropEvent::Leave) => {
                    let _ = window.emit("office-dragging", false);
                }
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    let _ = window.emit("office-dragging", false);
                    let window = window.clone();
                    let paths = paths.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let selection = window.state::<sources::Sources>().register(paths);
                        let _ = window.emit("office-sources-dropped", &selection);
                    });
                }
                WindowEvent::Destroyed => window.state::<codex::CodexJob>().cancel(),
                _ => {}
            }
        })
        .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::Wry>| {
          if invoke.message.webview().label() != "main" {
              invoke.resolver.reject("unavailable");
              return true;
          }
          let dispatch: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_action,
            browser::browser_check,
            project_preview::preview_html,
            project_preview::preview_pick_folder,
            project_preview::preview_stop,
            project_preview::mini_program_open,
            project_preview::mini_program_check,
            mcp::mcp_servers,
            mcp::mcp_save,
            mcp::mcp_remove,
            mcp::mcp_tools,
            mcp::mcp_call,
            sources::list_sources,
            sources::pick_sources,
            sources::remove_source,
            sources::relink_source,
            sources::replace_workspace_sources,
            sources::set_workspace_restore,
            sources::pick_workspace_backup,
            sources::scan_source,
            sources::read_material,
            sources::open_material,
            sources::open_artifact,
            sources::save_artifact,
            sources::read_export_font,
            codex::codex_status,
            codex::agent_cli_details,
            agent_workspace::agent_pick_folder,
            agent_workspace::agent_open_folder,
            agent_workspace::agent_reveal_file,
            codex::agent_open_terminal,
            codex::assistant_chat,
            codex::polish_report,
            codex::office_assist,
            codex::cancel_polish,
            providers::provider_list,
            providers::provider_save,
            providers::provider_remove,
            providers::provider_test,
            providers::provider_models,
            providers::provider_text,
            providers::provider_cancel_text,
            providers::provider_embeddings,
            providers::provider_image,
            providers::provider_speech,
            providers::provider_video_start,
            providers::provider_video_status,
            providers::provider_video_download,
          ];
          dispatch(invoke)
        })
        .run(tauri::generate_context!())
        .expect("could not start Office Workspace");
}
