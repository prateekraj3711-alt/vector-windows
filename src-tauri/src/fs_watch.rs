use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _join: std::thread::JoinHandle<()>,
}

/// Returns `true` for paths that are too noisy or irrelevant for the file viewer.
/// `.git` internals are filtered at the sub-path level (objects, index.lock) so
/// that `.git/HEAD` and `.git/refs/` — useful for worktree detection — still pass.
fn is_filtered(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(
            s.as_ref(),
            "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
        )
    }) || path.to_string_lossy().contains("/.git/objects/")
        || path
            .file_name()
            .map(|n| n == "index.lock")
            .unwrap_or(false)
}

/// Start a filesystem watcher rooted at `root` for the given `session_id`.
///
/// Events are debounced for 150 ms after the *last* received event, then emitted
/// as a single `fs-changed-{session_id}` Tauri event with payload
/// `{ "paths": ["/absolute/path", ...] }`.
///
/// Dropping the returned `WatcherHandle` stops the watcher and background thread.
pub fn start_watcher(
    session_id: String,
    root: PathBuf,
    app: AppHandle,
) -> Result<WatcherHandle, String> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let app_clone = app.clone();
    let session_id_clone = session_id.clone();

    let join = std::thread::spawn(move || {
        let mut buf: HashSet<PathBuf> = HashSet::new();
        let mut last_event = Instant::now();
        let debounce = Duration::from_millis(150);

        loop {
            match rx.recv_timeout(debounce) {
                Ok(Ok(ev)) => {
                    last_event = Instant::now();
                    for p in ev.paths {
                        if !is_filtered(&p) {
                            buf.insert(p);
                        }
                    }
                }
                Ok(Err(e)) => eprintln!("fs_watch error: {e}"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !buf.is_empty() && last_event.elapsed() >= debounce {
                        let paths: Vec<String> = buf
                            .drain()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();
                        let _ = app_clone.emit(
                            &format!("fs-changed-{}", session_id_clone),
                            serde_json::json!({ "paths": paths }),
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(WatcherHandle {
        _watcher: watcher,
        _join: join,
    })
}
