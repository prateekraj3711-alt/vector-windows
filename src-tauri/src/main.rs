#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod pty;
mod sessions;
mod usage;

use serde::Serialize;
use std::sync::Arc;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    registry: Arc<pty::PtyRegistry>,
    config: parking_lot::Mutex<config::Config>,
}

#[derive(Serialize)]
struct AgentMeta {
    id: String,
    label: String,
    available: bool,
}

#[tauri::command]
async fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentMeta>, String> {
    let cfg = state.config.lock().clone();
    let mut out: Vec<AgentMeta> = cfg.agents.iter().map(|(id, spec)| {
        let bin = spec.command.first().cloned().unwrap_or_default();
        AgentMeta {
            id: id.clone(),
            label: spec.label.clone().unwrap_or_else(|| id.clone()),
            available: config::which(&bin),
        }
    }).collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

#[tauri::command]
async fn default_agent(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock();
    Ok(cfg.default.clone().unwrap_or_else(|| "__shell__".into()))
}

fn default_shell() -> Vec<String> {
    if cfg!(windows) {
        vec!["powershell.exe".into()]
    } else {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())]
    }
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    agent_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    resume_id: Option<String>,
    continue_latest: Option<bool>,
) -> Result<(), String> {
    let (program, mut env) = {
        let cfg = state.config.lock();
        if agent_id == "__shell__" {
            (default_shell(), vec![])
        } else if let Some(spec) = cfg.agents.get(&agent_id) {
            let env: Vec<(String, String)> = spec.env.clone().into_iter().collect();
            (spec.command.clone(), env)
        } else {
            return Err(format!("unknown agent: {agent_id}"));
        }
    };

    // Resolve the binary against an augmented PATH so macOS GUI apps find
    // homebrew / user-installed tools that their minimal default PATH misses.
    let mut resolved = program.clone();
    if !resolved.is_empty() {
        if let Some(p) = config::which_path(&resolved[0]) {
            resolved[0] = p.to_string_lossy().to_string();
        } else if agent_id != "__shell__" {
            return Err(format!("binary not found in PATH: {}", resolved[0]));
        }
    }

    // Append agent-specific session arguments.
    match agent_id.as_str() {
        "claude" => {
            if let Some(sid) = resume_id.as_ref().filter(|s| !s.is_empty()) {
                resolved.push("--resume".into());
                resolved.push(sid.clone());
            } else if continue_latest.unwrap_or(false) {
                resolved.push("--continue".into());
            }
        }
        _ => {}
    }

    // Also inject the augmented PATH so child processes spawned by the agent
    // (git, node, etc.) can be found.
    let path = config::augmented_path();
    env.push(("PATH".into(), path.to_string_lossy().to_string()));
    // Set TERM so TUIs (Claude Code, etc.) agree with xterm.js on capabilities.
    if !env.iter().any(|(k, _)| k == "TERM") {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    if !env.iter().any(|(k, _)| k == "COLORTERM") {
        env.push(("COLORTERM".into(), "truecolor".into()));
    }
    // Advertise as iTerm so Claude Code (and any other TUI that branches on
    // terminal capability) picks the OSC 9 notification channel. pty.rs strips
    // + forwards those notifies as pty-notify events.
    if !env.iter().any(|(k, _)| k == "TERM_PROGRAM") {
        env.push(("TERM_PROGRAM".into(), "iTerm.app".into()));
    }
    if !env.iter().any(|(k, _)| k == "TERM_PROGRAM_VERSION") {
        env.push(("TERM_PROGRAM_VERSION".into(), "3.6.6".into()));
    }

    let cwd = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .or_else(dirs::home_dir);
    state.registry
        .spawn(app, session_id, &resolved, &env, cwd, cols, rows, agent_id == "claude")
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_stdin(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    state.registry.write(&session_id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize_pty(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.registry.resize(&session_id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn kill_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.registry.kill(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(agent_id: String, cwd: String) -> Result<Vec<sessions::SessionSummary>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => Ok(sessions::list_claude_sessions(&p)),
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn search_sessions(agent_id: String, cwd: String, query: String) -> Result<Vec<sessions::SessionSummary>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => Ok(sessions::search_claude_sessions(&p, &query)),
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn get_session(agent_id: String, cwd: String, session_id: String) -> Result<Option<sessions::SessionDetail>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => Ok(sessions::get_claude_session(&p, &session_id)),
        _ => Ok(None),
    }
}

#[tauri::command]
async fn supported_resume_agents() -> Result<Vec<String>, String> {
    Ok(vec!["claude".into()])
}

#[tauri::command]
async fn get_claude_usage() -> Result<Option<usage::ClaudeUsage>, String> {
    usage::fetch_claude_usage().await
}

/// Set the macOS Dock badge. 0 clears it. No-op on other platforms.
#[tauri::command]
async fn set_badge_count(app: AppHandle, count: u32) -> Result<(), String> {
    let value = if count == 0 { None } else { Some(count as i64) };
    if let Some(win) = app.get_webview_window("main") {
        win.set_badge_count(value).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a URL, file, or folder with the OS default handler. Expands a
/// leading `~/` or bare `~` against `$HOME` first so paths lifted out of
/// shell output work without manual expansion.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let target: String = if path == "~" {
        dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or(path)
    } else if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or(path)
    } else {
        path
    };

    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("/usr/bin/open").arg(&target).spawn();
    #[cfg(target_os = "linux")]
    let spawn = std::process::Command::new("xdg-open").arg(&target).spawn();
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("cmd").args(["/C", "start", "", &target]).spawn();

    spawn.map(|_| ()).map_err(|e| e.to_string())
}


fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            registry: Arc::new(pty::PtyRegistry::new()),
            config: parking_lot::Mutex::new(config::load()),
        })
        .invoke_handler(tauri::generate_handler![
            list_agents, default_agent, start_session, write_stdin, resize_pty, kill_session,
            list_sessions, search_sessions, get_session, supported_resume_agents, open_path,
            set_badge_count, get_claude_usage
        ])
        .setup(|app| {
            let _ = app.get_webview_window("main");

            // Native menu bar. Replacing the default menu loses macOS's built-in
            // items, so we rebuild App / Edit / View / Window / Help explicitly.
            let about_meta = AboutMetadataBuilder::new()
                .name(Some("Vector"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .build();
            let app_menu = SubmenuBuilder::new(app, "Vector")
                .about(Some(about_meta))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            let check_updates = MenuItemBuilder::new("Check for Updates…")
                .id("check_updates")
                .build(app)?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&check_updates)
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &window_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|handle, event| {
                if event.id() == "check_updates" {
                    let _ = handle.emit("menu://check-updates", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vector");
}
