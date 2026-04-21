#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod pty;
mod sessions;

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

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
            list_sessions, search_sessions, get_session, supported_resume_agents
        ])
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vector");
}
