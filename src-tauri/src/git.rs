use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEntry {
    pub path: PathBuf,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    pub path: PathBuf,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Copy)]
pub enum DiffBase {
    Head,
    Ref,
}

fn git_bin() -> Result<PathBuf, String> {
    crate::config::which_path("git").ok_or_else(|| "git binary not found in PATH".to_string())
}

fn run_git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let git = git_bin()?;
    let out = Command::new(&git)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        let s = String::from_utf8(out.stdout)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        Ok(s)
    } else {
        let stderr = String::from_utf8(out.stderr)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        Err(stderr.trim().to_string())
    }
}

/// Like `run_git`, but treats nonzero exit as success when stdout is non-empty.
/// `git diff --no-index` exits 1 when files differ, with the diff on stdout.
fn run_git_capture_stdout(args: &[&str], cwd: &Path) -> Result<String, String> {
    let git = git_bin()?;
    let out = Command::new(&git)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8(out.stdout)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    if out.status.success() || !stdout.is_empty() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8(out.stderr)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        Err(stderr.trim().to_string())
    }
}

/// `git worktree list --porcelain`
pub fn worktree_list(repo_path: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let output = run_git(&["worktree", "list", "--porcelain"], repo_path)?;
    let mut results = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut is_first = true;

    let flush = |path: Option<PathBuf>,
                  head: Option<String>,
                  branch: Option<String>,
                  is_main: bool,
                  results: &mut Vec<WorktreeInfo>| {
        if let (Some(p), Some(h)) = (path, head) {
            results.push(WorktreeInfo {
                path: p,
                branch,
                head: h,
                is_main,
            });
        }
    };

    for line in output.lines() {
        if line.is_empty() {
            let was_first = is_first;
            flush(current_path.take(), current_head.take(), current_branch.take(), was_first, &mut results);
            if was_first { is_first = false; }
        } else if let Some(p) = line.strip_prefix("worktree ") {
            // If we already have a partial entry (no blank line separator), flush it
            if current_path.is_some() {
                let was_first = is_first;
                flush(current_path.take(), current_head.take(), current_branch.take(), was_first, &mut results);
                if was_first { is_first = false; }
            }
            current_path = Some(PathBuf::from(p));
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            current_head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            current_branch = b.strip_prefix("refs/heads/").map(|s| s.to_string()).or_else(|| Some(b.to_string()));
        }
        // "detached" and "bare" lines are handled by branch staying None
    }
    // Flush final entry (no trailing blank line)
    if current_path.is_some() {
        flush(current_path, current_head, current_branch, is_first, &mut results);
    }

    Ok(results)
}

/// `git rev-parse HEAD`
pub fn head_sha(worktree_path: &Path) -> Result<String, String> {
    let s = run_git(&["rev-parse", "HEAD"], worktree_path)?;
    Ok(s.trim().to_string())
}

/// `git status --porcelain` — non-empty = dirty
pub fn is_dirty(worktree_path: &Path) -> Result<bool, String> {
    let s = run_git(&["status", "--porcelain"], worktree_path)?;
    Ok(!s.trim().is_empty())
}

/// `git status --porcelain=v1`
pub fn status_porcelain(worktree_path: &Path) -> Result<Vec<StatusEntry>, String> {
    let output = run_git(&["status", "--porcelain=v1"], worktree_path)?;
    let mut entries = Vec::new();
    for line in output.lines() {
        if line.len() < 3 { continue; }
        let x = &line[0..1];
        let y = &line[1..2];
        // Pick most informative: X if not space, else Y
        let code = if x != " " { x } else { y };
        let rest = &line[3..];
        // Handle renames: "old -> new"
        let path = if code == "R" || rest.contains(" -> ") {
            if let Some((_, new)) = rest.split_once(" -> ") {
                PathBuf::from(new)
            } else {
                PathBuf::from(rest)
            }
        } else {
            PathBuf::from(rest)
        };
        entries.push(StatusEntry {
            path,
            status: code.to_string(),
        });
    }
    Ok(entries)
}

/// Refuse refs that would be parsed as a git flag (anything starting with `-`).
/// Defense-in-depth: callers should already pass refs returned by
/// `resolve_base_ref` or `git rev-parse`, but a corrupt config or malformed
/// caller payload must not be allowed to inject `--upload-pack=evil` etc.
fn check_ref(r: &str) -> Result<(), String> {
    if r.starts_with('-') || r.is_empty() {
        return Err(format!("refusing to use ref starting with '-' or empty: {:?}", r));
    }
    Ok(())
}

/// `git diff <base_ref>...HEAD --name-status` + `--numstat`, merged by path
pub fn diff_name_status(worktree_path: &Path, base_ref: &str) -> Result<Vec<DiffEntry>, String> {
    check_ref(base_ref)?;
    let range = format!("{}...HEAD", base_ref);

    // First pass: numstat for additions/deletions
    let numstat_out = run_git(&["diff", &range, "--numstat"], worktree_path)?;
    let mut numstat: HashMap<PathBuf, (u32, u32)> = HashMap::new();
    for line in numstat_out.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() == 3 {
            let add: u32 = parts[0].parse().unwrap_or(0);
            let del: u32 = parts[1].parse().unwrap_or(0);
            // For renames numstat uses "{old => new}" notation; use the full field as key
            // but we'll match by the name-status path below
            numstat.insert(PathBuf::from(parts[2]), (add, del));
        }
    }

    // Second pass: name-status for status codes
    let name_status_out = run_git(&["diff", &range, "--name-status"], worktree_path)?;
    let mut entries = Vec::new();
    for line in name_status_out.lines() {
        if line.is_empty() { continue; }
        // Format: "STATUS\tpath" or "Rnn\told\tnew"
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.is_empty() { continue; }
        let raw_status = parts[0];
        // Normalize: R100 → R, C100 → C
        let status = if raw_status.starts_with('R') {
            "R".to_string()
        } else if raw_status.starts_with('C') {
            "C".to_string()
        } else {
            raw_status.to_string()
        };

        let path = if (status == "R" || status == "C") && parts.len() == 3 {
            PathBuf::from(parts[2])
        } else if parts.len() >= 2 {
            PathBuf::from(parts[1])
        } else {
            continue;
        };

        let (additions, deletions) = numstat.get(&path)
            .copied()
            .map(|(a, d)| (Some(a), Some(d)))
            .unwrap_or((None, None));

        entries.push(DiffEntry {
            path,
            status,
            additions,
            deletions,
        });
    }

    Ok(entries)
}

/// Returns raw diff text for a single file
pub fn diff_file(
    worktree_path: &Path,
    file: &Path,
    base: DiffBase,
    base_ref: Option<&str>,
) -> Result<String, String> {
    let file_str = file.to_string_lossy();
    let output = match base {
        DiffBase::Head => {
            // `git diff -- file` only shows unstaged changes. To cover staged
            // changes too, diff against HEAD. For untracked files HEAD knows
            // nothing about the path, so fall back to `--no-index` against
            // /dev/null which produces a synthetic all-additions diff.
            let tracked = run_git(&["diff", "HEAD", "--", file_str.as_ref()], worktree_path)?;
            if !tracked.trim().is_empty() {
                tracked
            } else {
                let ls = run_git(
                    &["ls-files", "--others", "--exclude-standard", "--", file_str.as_ref()],
                    worktree_path,
                )
                .unwrap_or_default();
                if !ls.trim().is_empty() {
                    run_git_capture_stdout(
                        &["diff", "--no-index", "--", "/dev/null", file_str.as_ref()],
                        worktree_path,
                    )
                    .unwrap_or_default()
                } else {
                    tracked
                }
            }
        }
        DiffBase::Ref => {
            if let Some(r) = base_ref {
                check_ref(r)?;
                let range = format!("{}...HEAD", r);
                run_git(&["diff", &range, "--", file_str.as_ref()], worktree_path)?
            } else {
                run_git(&["diff", "--", file_str.as_ref()], worktree_path)?
            }
        }
    };
    Ok(output)
}

/// Resolve the base branch for diff comparisons with three fallbacks.
pub fn resolve_base_ref(worktree_path: &Path) -> Result<String, String> {
    // 1. symbolic-ref refs/remotes/origin/HEAD → strip "refs/remotes/"
    if let Ok(s) = run_git(&["symbolic-ref", "refs/remotes/origin/HEAD"], worktree_path) {
        let s = s.trim();
        if !s.is_empty() {
            let stripped = s.strip_prefix("refs/remotes/").unwrap_or(s);
            return Ok(stripped.to_string());
        }
    }

    // 2. config init.defaultBranch
    if let Ok(s) = run_git(&["config", "init.defaultBranch"], worktree_path) {
        let s = s.trim();
        if !s.is_empty() {
            return Ok(format!("origin/{}", s));
        }
    }

    // 3. last resort
    Ok("main".to_string())
}

