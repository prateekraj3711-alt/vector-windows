use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use serde::Serialize;
use tauri::State;

use crate::{config, git, worktree_session, AppState};

// ─── Public structs ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeEntry {
    pub path: PathBuf,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeChanges {
    pub uncommitted: Vec<ChangeEntry>,
    pub committed: Vec<ChangeEntry>,
    pub base_ref: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditorInfo {
    pub bundle_id: String,
    pub display_name: String,
}

// ─── Hardcoded editor list ────────────────────────────────────────────────────

const EDITORS: &[(&str, &str)] = &[
    ("com.microsoft.VSCode", "Visual Studio Code"),
    ("com.todesktop.230313mzl4w4u92", "Cursor"),
    ("com.codeium.windsurf", "Windsurf"),
    ("dev.zed.Zed", "Zed"),
    ("com.jetbrains.intellij", "IntelliJ IDEA"),
    ("com.jetbrains.WebStorm", "WebStorm"),
    ("com.jetbrains.pycharm", "PyCharm"),
    ("com.sublimetext.4", "Sublime Text"),
];

// ─── Commands ─────────────────────────────────────────────────────────────────

/// List directory contents, optionally including hidden entries. Directories
/// come first (alphabetically), then files (alphabetically).
#[tauri::command]
pub async fn list_dir(path: PathBuf, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;

        let mut dirs: Vec<DirEntry> = Vec::new();
        let mut files: Vec<DirEntry> = Vec::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let entry = DirEntry {
                name: name.clone(),
                path: entry.path(),
                is_dir,
            };
            if is_dir {
                dirs.push(entry);
            } else {
                files.push(entry);
            }
        }

        dirs.sort_by(|a, b| a.name.cmp(&b.name));
        files.sort_by(|a, b| a.name.cmp(&b.name));
        dirs.extend(files);
        Ok(dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// BFS-walk `root` (same rules as `worktree_session::discover_worktrees`) and
/// return only the repo roots (directories that contain a `.git` entry).
#[tauri::command]
pub async fn list_repos_in_project(root: PathBuf) -> Result<Vec<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(worktree_session::discover_repos(&root)))
        .await
        .map_err(|e| e.to_string())?
}

/// Thin wrapper around `git::worktree_list`.
#[tauri::command]
pub async fn list_worktrees_for_repo(repo: PathBuf) -> Result<Vec<git::WorktreeInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || git::worktree_list(&repo))
        .await
        .map_err(|e| e.to_string())?
}

/// Return the set of worktrees "linked" to `session_id`.
///
/// Because the Tauri PTY registry does not expose a project-root field, the
/// caller supplies `project_root` directly (matches the session's CWD at
/// spawn time, which the frontend already tracks).
#[tauri::command]
pub async fn list_linked_worktrees(
    state: State<'_, AppState>,
    session_id: String,
    project_root: PathBuf,
) -> Result<Vec<PathBuf>, String> {
    // Missing snapshot = background discovery still in progress. Return empty
    // so the frontend renders everything as unlinked (the safe default) until
    // the snapshot arrives, instead of treating every worktree as "new since
    // spawn" (which compute_linked would do on an empty snapshot).
    let snapshot = match state.session_snapshots.lock().get(&session_id) {
        Some(s) => s.clone(),
        None => return Ok(Vec::new()),
    };
    let manual_pins = state.session_manual_pins.lock().get(&session_id).cloned().unwrap_or_default();

    // The slow part — discover + compute. Off main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let current_worktrees = worktree_session::discover_worktrees(&project_root);
        let linked = worktree_session::compute_linked(&snapshot, &current_worktrees, &manual_pins);
        let mut result: Vec<PathBuf> = linked.into_iter().collect();
        result.sort();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return uncommitted + committed changes for a worktree relative to a base
/// branch. If `base_ref` is not provided, it is resolved automatically.
#[tauri::command]
pub async fn worktree_changes(
    worktree: PathBuf,
    base_ref: Option<String>,
) -> Result<WorktreeChanges, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_base = match base_ref {
            Some(r) if !r.is_empty() => r,
            _ => git::resolve_base_ref(&worktree)?,
        };

        let uncommitted: Vec<ChangeEntry> = git::status_porcelain(&worktree)?
            .into_iter()
            .map(|e| ChangeEntry {
                path: e.path,
                status: e.status,
                additions: None,
                deletions: None,
            })
            .collect();

        let committed: Vec<ChangeEntry> = git::diff_name_status(&worktree, &resolved_base)?
            .into_iter()
            .map(|e| ChangeEntry {
                path: e.path,
                status: e.status,
                additions: e.additions,
                deletions: e.deletions,
            })
            .collect();

        Ok(WorktreeChanges {
            uncommitted,
            committed,
            base_ref: resolved_base,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return raw diff text for a single file in a worktree.
///
/// `base` is either `"head"` (unstaged diff) or `"base"` (diff against merge-base).
#[tauri::command]
pub async fn worktree_diff(
    worktree: PathBuf,
    file: PathBuf,
    base: String,
    base_ref: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if base == "head" {
            git::diff_file(&worktree, &file, git::DiffBase::Head, None)
        } else {
            // base == "base" — resolve the ref string
            let resolved = match base_ref {
                Some(r) if !r.is_empty() => r,
                _ => git::resolve_base_ref(&worktree)?,
            };
            git::diff_file(&worktree, &file, git::DiffBase::Ref, Some(&resolved))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add or remove a manual pin for a worktree on a given session.
#[tauri::command]
pub fn pin_worktree(
    state: State<'_, AppState>,
    session_id: String,
    worktree: PathBuf,
    pinned: bool,
) -> Result<(), String> {
    let mut pins = state.session_manual_pins.lock();
    let entry = pins.entry(session_id).or_insert_with(HashSet::new);
    if pinned {
        entry.insert(worktree);
    } else {
        entry.remove(&worktree);
    }
    Ok(())
}

/// Return the list of code editors that are currently installed on this
/// machine. Results are cached in `AppState` after the first call.
#[tauri::command]
pub fn installed_editors(state: State<'_, AppState>) -> Result<Vec<EditorInfo>, String> {
    // Fast path: return cached value
    {
        let cache = state.installed_editors.lock();
        if let Some(ref cached) = *cache {
            return Ok(cached.clone());
        }
    }

    // Slow path: probe each editor
    let mdfind = match config::which_path("mdfind") {
        Some(p) => p,
        None => {
            // mdfind not available — return empty list gracefully
            let mut cache = state.installed_editors.lock();
            *cache = Some(vec![]);
            return Ok(vec![]);
        }
    };

    let mut found: Vec<EditorInfo> = Vec::new();
    for &(bundle_id, display_name) in EDITORS {
        let query = format!("kMDItemCFBundleIdentifier == '{}'", bundle_id);
        let output = Command::new(&mdfind)
            .arg(&query)
            .output();
        if let Ok(out) = output {
            if out.status.success() && !out.stdout.is_empty() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if !stdout.trim().is_empty() {
                    found.push(EditorInfo {
                        bundle_id: bundle_id.to_string(),
                        display_name: display_name.to_string(),
                    });
                }
            }
        }
    }

    let mut cache = state.installed_editors.lock();
    *cache = Some(found.clone());
    Ok(found)
}

/// Open a path in the given editor using macOS `open -b <bundle_id> <path>`.
/// Fire-and-forget: we spawn `open` and don't wait for it (waiting blocks the
/// Tauri command thread for seconds while LaunchServices brings the app forward).
#[tauri::command]
pub fn open_in_editor(bundle_id: String, path: PathBuf) -> Result<(), String> {
    let open_bin = config::which_path("open").ok_or_else(|| "open not found in PATH".to_string())?;
    Command::new(open_bin)
        .args(["-b", &bundle_id])
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
