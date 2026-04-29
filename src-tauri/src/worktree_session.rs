use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use serde::Serialize;

use crate::git;

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeState {
    pub head: String,
    pub dirty: bool,
}

pub type Snapshot = HashMap<PathBuf, WorktreeState>;

/// Walk a project root to find all git repos, then for each repo enumerate its worktrees.
/// Returns a flat Vec of worktree paths (each repo contributes 1+ worktrees).
///
/// Discovery rules:
/// - BFS walk from `project_root`, depth-capped at 4
/// - Skip `node_modules`, `target`, `dist`, `build`, `.next`, `.cache`, hidden dirs
///   (starting with `.`) EXCEPT the project root itself
/// - A directory is a repo if it contains a `.git` entry (file OR dir)
/// - Once a repo is found, do not descend further into it
pub fn discover_worktrees(project_root: &Path) -> Vec<PathBuf> {
    let mut repos: Vec<PathBuf> = Vec::new();
    let mut queue: Vec<(PathBuf, u32)> = vec![(project_root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        let git_path = dir.join(".git");
        if git_path.exists() {
            repos.push(dir);
            continue; // don't descend into a repo
        }
        if depth >= 4 {
            continue;
        }

        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
            ) {
                continue;
            }
            if name.starts_with('.') && depth > 0 {
                continue;
            }
            queue.push((path, depth + 1));
        }
    }

    // For each repo, get its worktree list. Collect all worktree paths.
    let mut all: Vec<PathBuf> = Vec::new();
    for repo in &repos {
        if let Ok(wts) = git::worktree_list(repo) {
            for wt in wts {
                all.push(wt.path);
            }
        }
    }
    all
}

pub fn take_snapshot(worktrees: &[PathBuf]) -> Snapshot {
    let mut snap: Snapshot = HashMap::new();
    for wt in worktrees {
        let head = git::head_sha(wt).unwrap_or_default();
        let dirty = git::is_dirty(wt).unwrap_or(false);
        snap.insert(wt.clone(), WorktreeState { head, dirty });
    }
    snap
}

/// Returns the set of worktrees that are "linked" to a session given:
/// - the session's snapshot
/// - the current state of the same paths (recomputed at query time)
/// - manual pins for that session
///
/// Linked rules (from spec):
/// - Worktree did NOT exist in the snapshot (created since spawn)
/// - HEAD differs between snapshot and current
/// - Current dirty == true AND snapshot dirty == false (became dirty since spawn)
/// - Worktree is in the manual pin set
pub fn compute_linked(
    snapshot: &Snapshot,
    current_worktrees: &[PathBuf],
    manual_pins: &HashSet<PathBuf>,
) -> HashSet<PathBuf> {
    let mut linked: HashSet<PathBuf> = HashSet::new();

    for wt in current_worktrees {
        if manual_pins.contains(wt) {
            linked.insert(wt.clone());
            continue;
        }

        let cur_head = git::head_sha(wt).unwrap_or_default();
        let cur_dirty = git::is_dirty(wt).unwrap_or(false);

        match snapshot.get(wt) {
            None => {
                linked.insert(wt.clone());
            }
            Some(prev) => {
                if prev.head != cur_head {
                    linked.insert(wt.clone());
                } else if cur_dirty && !prev.dirty {
                    linked.insert(wt.clone());
                }
            }
        }
    }

    // Also: any path in manual_pins that isn't in current_worktrees should still be
    // considered "linked" intent — but only if it still exists on disk.
    // (User may have manually pinned, then the worktree moved.)
    for pin in manual_pins {
        if pin.exists() && !linked.contains(pin) {
            linked.insert(pin.clone());
        }
    }

    linked
}
