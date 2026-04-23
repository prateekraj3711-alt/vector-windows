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
    profiles: parking_lot::Mutex<config::ProfilesFile>,
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
    // profile_override: None → resolve from cwd. Some("__default__") → force
    // default (~/.claude). Some(id) → use that profile.
    profile_override: Option<String>,
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

    // Per-project Claude profile: set CLAUDE_CONFIG_DIR so Claude Code uses an
    // isolated login/history for this folder. Precedence:
    //   1. explicit `profile_override` from the tab pill (wins over path resolution)
    //   2. path-based resolution from the profile → folder map
    //   3. nothing set → Claude defaults to ~/.claude
    if agent_id == "claude" {
        let resolved_dir: Option<std::path::PathBuf> = match profile_override.as_deref() {
            Some("__default__") => None, // explicit default — do not set CLAUDE_CONFIG_DIR
            Some(id) if !id.is_empty() => {
                let profiles = state.profiles.lock();
                let exists = profiles.profiles.iter().any(|p| p.id == id);
                drop(profiles);
                if !exists {
                    // Referenced profile was deleted. Fail loudly rather than
                    // silently falling back to the default profile — otherwise
                    // a `--resume <id>` under a deleted profile would surface
                    // as a confusing "session not found" inside Claude.
                    return Err(format!("profile override '{id}' no longer exists"));
                }
                config::profile_config_dir(id)
            }
            _ => cwd.as_ref().and_then(|c| {
                let profiles = state.profiles.lock();
                config::resolve_profile_for_path(&profiles, c)
                    .and_then(|p| config::profile_config_dir(&p.id))
            }),
        };
        if let Some(dir) = resolved_dir {
            let _ = std::fs::create_dir_all(&dir);
            if !env.iter().any(|(k, _)| k == "CLAUDE_CONFIG_DIR") {
                env.push(("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().to_string()));
            }
        }
    }

    state.registry
        .spawn(app, session_id, &resolved, &env, cwd, cols, rows, agent_id == "claude")
        .map_err(|e| e.to_string())
}

// ——— Claude profile commands ———

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProfileDto {
    id: String,
    name: String,
    color: String,
    folders: Vec<String>,
    created_ms: u64,
    config_dir: String,
    signed_in_email: Option<String>,
}

fn profile_to_dto(p: &config::ClaudeProfile) -> ClaudeProfileDto {
    let dir = config::profile_config_dir(&p.id).unwrap_or_default();
    let email = read_profile_email(&dir);
    ClaudeProfileDto {
        id: p.id.clone(),
        name: p.name.clone(),
        color: p.color.clone(),
        folders: p.folders.clone(),
        created_ms: p.created_ms,
        config_dir: dir.to_string_lossy().to_string(),
        signed_in_email: email,
    }
}

/// Best-effort read of the signed-in account email from a profile's config dir.
/// Claude Code writes `.claude.json` with an `oauthAccount.emailAddress` field
/// (format has shifted over versions; we try a couple of known paths).
fn read_profile_email(config_dir: &std::path::Path) -> Option<String> {
    let candidates = [
        config_dir.join(".claude.json"),
        config_dir.join("config.json"),
    ];
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        for ptr in ["/oauthAccount/emailAddress", "/account/email", "/user/email", "/email"] {
            if let Some(s) = v.pointer(ptr).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

#[tauri::command]
async fn list_claude_profiles(state: State<'_, AppState>) -> Result<Vec<ClaudeProfileDto>, String> {
    let profiles = state.profiles.lock();
    Ok(profiles.profiles.iter().map(profile_to_dto).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHomeValidation {
    valid: bool,
    expanded_path: String,
    has_credentials: bool,
    has_config: bool,
    has_projects: bool,
    /// Claude's default layout stores the main config as a sibling file
    /// `~/.claude.json` next to `~/.claude/`. When the user seeds from the dir
    /// we also want to pick up that sibling file.
    sibling_config_path: Option<String>,
    detected_email: Option<String>,
    /// Likely stored in macOS Keychain — `/login` will still be required even
    /// after seeding. Surfaced so the UI can warn the user.
    credentials_in_keychain: bool,
}

/// Best-effort lookup of the Claude sibling config file (e.g., for `~/.claude`
/// this is `~/.claude.json`). Returns `None` if none exists.
fn find_sibling_config(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = path.parent()?;
    let base = path.file_name()?.to_string_lossy().to_string();
    let candidate = parent.join(format!("{base}.json"));
    if candidate.is_file() { Some(candidate) } else { None }
}

#[tauri::command]
async fn validate_claude_home(path: String) -> Result<ClaudeHomeValidation, String> {
    let expanded = config::expand_tilde(&path);
    let has_credentials = expanded.join(".credentials.json").is_file()
        || expanded.join("credentials.json").is_file();
    let has_config_inside = expanded.join(".claude.json").is_file();
    let sibling = find_sibling_config(&expanded);
    let has_config = has_config_inside || sibling.is_some();
    let has_projects = expanded.join("projects").is_dir();
    // Accept as a Claude home if we find either config (inside or sibling),
    // credentials, or at least a `projects/` tree.
    let valid = expanded.is_dir() && (has_config || has_credentials || has_projects);
    // Email lookup: try the inside file first, then the sibling.
    let detected_email = if valid {
        read_profile_email(&expanded).or_else(|| {
            sibling.as_ref().and_then(|p| {
                let text = std::fs::read_to_string(p).ok()?;
                let v: serde_json::Value = serde_json::from_str(&text).ok()?;
                for ptr in ["/oauthAccount/emailAddress", "/account/email", "/user/email", "/email"] {
                    if let Some(s) = v.pointer(ptr).and_then(|x| x.as_str()) {
                        return Some(s.to_string());
                    }
                }
                None
            })
        })
    } else { None };
    // Credentials likely in macOS Keychain: the folder has a config file
    // (inside or sibling) but no `.credentials.json`. Requiring a config
    // prevents false positives on empty / unrelated dirs that happen to have a
    // `projects/` subfolder.
    let credentials_in_keychain =
        valid && has_config && !has_credentials && cfg!(target_os = "macos");
    Ok(ClaudeHomeValidation {
        valid,
        expanded_path: expanded.to_string_lossy().to_string(),
        has_credentials,
        has_config,
        has_projects,
        sibling_config_path: sibling.map(|p| p.to_string_lossy().to_string()),
        detected_email,
        credentials_in_keychain,
    })
}

/// Recursively copy a directory's contents into `dst`, tolerant of the mess that
/// accumulates in real `~/.claude` dirs (sockets from running IPC, broken symlinks,
/// files the user can't read, etc).
///
/// Symlinks are SKIPPED entirely (both file- and dir-targeted). A malicious or
/// accidental symlink to `/` or `~` inside the source would otherwise cause this
/// function to recurse across the whole filesystem until disk space is exhausted.
/// Users seeding from a legitimate Claude home don't rely on symlinks being
/// preserved — Claude regenerates its state on first launch.
///
/// Regular files and real directories are copied; everything else (sockets, fifos,
/// devices, broken symlinks) is skipped. Per-entry errors don't abort the copy.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    let iter = match std::fs::read_dir(src) {
        Ok(r) => r,
        Err(e) => return Err(e),
    };
    for entry in iter.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        // `symlink_metadata` does NOT follow symlinks — we classify by the
        // entry itself so a `~/.claude/foo -> /` can't cause a runaway copy.
        let meta = match std::fs::symlink_metadata(&from) {
            Ok(m) => m,
            Err(_) => continue, // perm denied, etc. — skip
        };
        let ft = meta.file_type();
        if ft.is_symlink() {
            // Explicitly skip — see doc comment.
            continue;
        }
        if ft.is_dir() {
            let _ = copy_dir_recursive(&from, &to);
        } else if ft.is_file() {
            if to.exists() { continue; }
            let _ = std::fs::copy(&from, &to);
        }
        // Other file types (sockets, fifos, block/char devices) → skip.
    }
    Ok(())
}

#[tauri::command]
async fn create_claude_profile(
    state: State<'_, AppState>,
    name: String,
    color: String,
    folders: Vec<String>,
    seed_from: Option<String>,
) -> Result<ClaudeProfileDto, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let dto = {
        let mut profiles = state.profiles.lock();
        let existing_ids: Vec<String> = profiles.profiles.iter().map(|p| p.id.clone()).collect();
        let id = config::slugify_profile_id(&name, &existing_ids);
        let prof = config::ClaudeProfile {
            id: id.clone(),
            name,
            color,
            folders,
            created_ms: config::now_ms(),
        };
        // Pre-create the config dir so first launch doesn't race.
        let profile_dir = config::profile_config_dir(&id);
        if let Some(ref dir) = profile_dir {
            let _ = std::fs::create_dir_all(dir);
        }
        // Seed from an existing Claude home if requested. Copies everything
        // under the source dir, plus the sibling `<src>.json` file (Claude's
        // default layout puts the main config at ~/.claude.json next to ~/.claude/).
        // Under CLAUDE_CONFIG_DIR, Claude expects .claude.json INSIDE the dir —
        // so we place the sibling file there on copy.
        if let (Some(ref dir), Some(seed)) = (profile_dir.as_ref(), seed_from.as_ref().filter(|s| !s.trim().is_empty())) {
            let src = config::expand_tilde(seed);
            if src.is_dir() {
                copy_dir_recursive(&src, dir)
                    .map_err(|e| format!("seed copy failed: {e}"))?;
                if let Some(sib) = find_sibling_config(&src) {
                    let dst_config = dir.join(".claude.json");
                    if !dst_config.exists() {
                        std::fs::copy(&sib, &dst_config)
                            .map_err(|e| format!("sibling config copy failed: {e}"))?;
                    }
                }
            } else {
                return Err(format!("seed folder not found: {}", src.display()));
            }
        }
        profiles.profiles.push(prof.clone());
        config::save_profiles(&profiles).map_err(|e| e.to_string())?;
        profile_to_dto(&prof)
    };
    Ok(dto)
}

#[tauri::command]
async fn update_claude_profile(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    folders: Option<Vec<String>>,
) -> Result<ClaudeProfileDto, String> {
    let mut profiles = state.profiles.lock();
    let prof = profiles.profiles.iter_mut().find(|p| p.id == id)
        .ok_or_else(|| format!("profile not found: {id}"))?;
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() { return Err("name is required".into()); }
        prof.name = n;
    }
    if let Some(c) = color { prof.color = c; }
    if let Some(f) = folders { prof.folders = f; }
    let dto = profile_to_dto(prof);
    config::save_profiles(&profiles).map_err(|e| e.to_string())?;
    Ok(dto)
}

#[tauri::command]
async fn delete_claude_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut profiles = state.profiles.lock();
    let before = profiles.profiles.len();
    profiles.profiles.retain(|p| p.id != id);
    if profiles.profiles.len() == before {
        return Err(format!("profile not found: {id}"));
    }
    config::save_profiles(&profiles).map_err(|e| e.to_string())?;
    // Note: we intentionally do NOT delete the config dir on disk — lets users
    // recover if they delete by mistake. They can remove ~/.claude-profiles/<id> manually.
    Ok(())
}

#[tauri::command]
async fn resolve_claude_profile(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Option<ClaudeProfileDto>, String> {
    let path = std::path::PathBuf::from(&cwd);
    let profiles = state.profiles.lock();
    Ok(config::resolve_profile_for_path(&profiles, &path).map(profile_to_dto))
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

/// Resolve the Claude `CLAUDE_CONFIG_DIR` for `cwd` given the current profile mappings.
/// Returns `None` when no profile matches (caller falls back to `~/.claude`).
fn claude_config_dir_for(state: &State<'_, AppState>, cwd: &std::path::Path) -> Option<std::path::PathBuf> {
    let profiles = state.profiles.lock();
    config::resolve_profile_for_path(&profiles, cwd)
        .and_then(|p| config::profile_config_dir(&p.id))
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>, agent_id: String, cwd: String) -> Result<Vec<sessions::SessionSummary>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => {
            let dir = claude_config_dir_for(&state, &p);
            Ok(sessions::list_claude_sessions(&p, dir.as_deref()))
        }
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn search_sessions(state: State<'_, AppState>, agent_id: String, cwd: String, query: String) -> Result<Vec<sessions::SessionSummary>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => {
            let dir = claude_config_dir_for(&state, &p);
            Ok(sessions::search_claude_sessions(&p, &query, dir.as_deref()))
        }
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn get_session(state: State<'_, AppState>, agent_id: String, cwd: String, session_id: String) -> Result<Option<sessions::SessionDetail>, String> {
    let p = std::path::PathBuf::from(&cwd);
    match agent_id.as_str() {
        "claude" => {
            let dir = claude_config_dir_for(&state, &p);
            Ok(sessions::get_claude_session(&p, &session_id, dir.as_deref()))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
async fn supported_resume_agents() -> Result<Vec<String>, String> {
    Ok(vec!["claude".into()])
}

#[tauri::command]
async fn get_claude_usage(profile_id: Option<String>) -> Result<Option<usage::ClaudeUsage>, String> {
    usage::fetch_claude_usage(profile_id.as_deref()).await
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
            profiles: parking_lot::Mutex::new(config::load_profiles()),
        })
        .invoke_handler(tauri::generate_handler![
            list_agents, default_agent, start_session, write_stdin, resize_pty, kill_session,
            list_sessions, search_sessions, get_session, supported_resume_agents, open_path,
            set_badge_count, get_claude_usage,
            list_claude_profiles, create_claude_profile, update_claude_profile,
            delete_claude_profile, resolve_claude_profile, validate_claude_home
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
