use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone)]
struct CachedInfo { title: String, msg_count: u32 }

static INFO_CACHE: OnceLock<Mutex<HashMap<(PathBuf, u64), CachedInfo>>> = OnceLock::new();
fn info_cache() -> &'static Mutex<HashMap<(PathBuf, u64), CachedInfo>> {
    INFO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cached_info(path: &Path, modified_ms: u64) -> Option<CachedInfo> {
    info_cache().lock().ok()?.get(&(path.to_path_buf(), modified_ms)).cloned()
}
fn store_info(path: &Path, modified_ms: u64, info: CachedInfo) {
    if let Ok(mut c) = info_cache().lock() {
        c.insert((path.to_path_buf(), modified_ms), info);
    }
}

// Read up to 4 MB of a session file, compute title + message count in one pass.
//
// Title preference (strongest → weakest):
//   1. custom-title line (user-set via `/title`) — last occurrence wins
//   2. agent-name line (named agents) — last occurrence wins
//   3. first non-system user message text
fn scan_file_summary(path: &Path) -> CachedInfo {
    let Ok(file) = File::open(path) else { return CachedInfo { title: String::new(), msg_count: 0 } };
    let mut raw: Vec<u8> = Vec::new();
    let _ = file.take(4 * 1024 * 1024).read_to_end(&mut raw);

    let text = match std::str::from_utf8(&raw) { Ok(s) => s, Err(_) => return CachedInfo { title: String::new(), msg_count: 0 } };
    let mut custom_title = String::new();
    let mut agent_name = String::new();
    let mut first_user_title = String::new();
    let mut msg_count: u32 = 0;
    for line in text.lines() {
        if line.trim().is_empty() { continue; }

        if line.contains("\"type\":\"custom-title\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(s) = v.get("customTitle").and_then(|s| s.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() { custom_title = truncate(s, 80); }
                }
            }
            continue;
        }
        if line.contains("\"type\":\"agent-name\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(s) = v.get("agentName").and_then(|s| s.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() { agent_name = truncate(s, 80); }
                }
            }
            continue;
        }

        let is_msg = line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"");
        if !is_msg { continue; }
        msg_count += 1;
        if first_user_title.is_empty() && line.contains("\"type\":\"user\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(t) = extract_text(v.get("message")) {
                    if classify_system(&t).is_none() { first_user_title = truncate(&t, 80); }
                }
            }
        }
    }

    let title = if !custom_title.is_empty() { custom_title }
        else if !agent_name.is_empty() { agent_name }
        else { first_user_title };
    CachedInfo { title, msg_count }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub modified_ms: u64,
    pub message_count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMessage {
    pub role: String,
    pub kind: String,
    pub label: Option<String>,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub modified_ms: u64,
    pub messages: Vec<PreviewMessage>,
}

fn encode_path_for_claude(p: &Path) -> String {
    p.to_string_lossy().replace('/', "-")
}

fn claude_sessions_dir(cwd: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".claude").join("projects").join(encode_path_for_claude(cwd)))
}

fn file_modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max { return trimmed.to_string(); }
    let taken: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    format!("{taken}…")
}

fn classify_system(text: &str) -> Option<&'static str> {
    let t = text.trim_start();
    // exact prefix → label
    for (marker, label) in [
        ("<task-notification>", "task notification"),
        ("<system-reminder>", "system reminder"),
        ("<bash-input>", "bash input"),
        ("<bash-stdout>", "bash output"),
        ("<bash-stderr>", "bash error"),
        ("<user-prompt-submit-hook>", "prompt hook"),
    ] {
        if t.starts_with(marker) { return Some(label); }
    }
    // generic catch-alls for tag families we don't want in previews
    for prefix in ["<local-command-", "<command-", "<ide-", "<tool-result>", "<tool_use_result>"] {
        if t.starts_with(prefix) { return Some("system"); }
    }
    None
}

fn extract_text(msg: Option<&serde_json::Value>) -> Option<String> {
    let m = msg?;
    if let Some(s) = m.get("content").and_then(|c| c.as_str()) {
        return Some(s.to_string());
    }
    if let Some(arr) = m.get("content").and_then(|c| c.as_array()) {
        let mut out = String::new();
        for item in arr {
            let t = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if t == "text" {
                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() { out.push('\n'); }
                    out.push_str(t);
                }
            } else if t == "tool_use" {
                if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                    if !out.is_empty() { out.push('\n'); }
                    out.push_str(&format!("[tool: {name}]"));
                }
            }
        }
        if !out.is_empty() { return Some(out); }
    }
    None
}

pub fn list_claude_sessions(cwd: &Path) -> Vec<SessionSummary> {
    let dir = match claude_sessions_dir(cwd) { Some(d) => d, None => return vec![] };
    let read = match fs::read_dir(&dir) { Ok(r) => r, Err(_) => return vec![] };

    // Collect file paths first so we can do the heavy work in parallel threads.
    let mut paths: Vec<(String, PathBuf, u64, u64)> = vec![];
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let id = match path.file_stem().and_then(|s| s.to_str()) { Some(s) => s.to_string(), None => continue };
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let size = meta.len();
        if size < 16 { continue; }
        let modified_ms = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        paths.push((id, path, modified_ms, size));
    }

    let handles: Vec<_> = paths
        .into_iter()
        .map(|(id, path, modified_ms, _size)| {
            std::thread::spawn(move || {
                let info = cached_info(&path, modified_ms).unwrap_or_else(|| {
                    let info = scan_file_summary(&path);
                    if !info.title.is_empty() { store_info(&path, modified_ms, info.clone()); }
                    info
                });
                if info.title.is_empty() { return None; }
                Some(SessionSummary { id, agent_id: "claude".into(), title: info.title, modified_ms, message_count: info.msg_count })
            })
        })
        .collect();

    let mut out: Vec<SessionSummary> = handles.into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn search_claude_sessions(cwd: &Path, query: &str) -> Vec<SessionSummary> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() { return list_claude_sessions(cwd); }
    let dir = match claude_sessions_dir(cwd) { Some(d) => d, None => return vec![] };
    let read = match fs::read_dir(&dir) { Ok(r) => r, Err(_) => return vec![] };

    let mut paths: Vec<(String, PathBuf, u64, u64)> = vec![];
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let id = match path.file_stem().and_then(|s| s.to_str()) { Some(s) => s.to_string(), None => continue };
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let size = meta.len();
        if size < 16 { continue; }
        let modified_ms = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        paths.push((id, path, modified_ms, size));
    }

    let handles: Vec<_> = paths.into_iter().map(|(id, path, modified_ms, _size)| {
        let needle = needle.clone();
        std::thread::spawn(move || scan_for_needle(&path, &needle, modified_ms).map(|info| {
            SessionSummary { id, agent_id: "claude".into(), title: info.title, modified_ms, message_count: info.msg_count }
        }))
    }).collect();

    let mut out: Vec<SessionSummary> = handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

// Raw byte-scan for the needle. Info (title + count) comes from cache when possible.
fn scan_for_needle(path: &Path, needle_lower: &str, modified_ms: u64) -> Option<CachedInfo> {
    const CAP: u64 = 4 * 1024 * 1024;
    let file = File::open(path).ok()?;
    let mut raw: Vec<u8> = Vec::new();
    file.take(CAP).read_to_end(&mut raw).ok()?;

    for b in raw.iter_mut() { b.make_ascii_lowercase(); }
    let hay = std::str::from_utf8(&raw).ok()?;
    if !hay.contains(needle_lower) { return None; }

    if let Some(info) = cached_info(path, modified_ms) { return Some(info); }
    let info = scan_file_summary(path);
    if !info.title.is_empty() { store_info(path, modified_ms, info.clone()); }
    Some(info)
}

pub fn get_claude_session(cwd: &Path, session_id: &str) -> Option<SessionDetail> {
    let dir = claude_sessions_dir(cwd)?;
    let path = dir.join(format!("{session_id}.jsonl"));
    let content = fs::read_to_string(&path).ok()?;
    let modified_ms = file_modified_ms(&path);
    let mut messages = vec![];
    let mut custom_title = String::new();
    let mut agent_name = String::new();
    let mut first_user_title = String::new();
    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if t == "custom-title" {
            if let Some(s) = v.get("customTitle").and_then(|s| s.as_str()) {
                let s = s.trim();
                if !s.is_empty() { custom_title = truncate(s, 80); }
            }
            continue;
        }
        if t == "agent-name" {
            if let Some(s) = v.get("agentName").and_then(|s| s.as_str()) {
                let s = s.trim();
                if !s.is_empty() { agent_name = truncate(s, 80); }
            }
            continue;
        }
        if t == "user" || t == "assistant" {
            if let Some(text) = extract_text(v.get("message")) {
                let sys = classify_system(&text);
                if first_user_title.is_empty() && t == "user" && sys.is_none() {
                    first_user_title = truncate(&text, 80);
                }
                messages.push(match sys {
                    Some(label) => PreviewMessage {
                        role: t.to_string(),
                        kind: "system".into(),
                        label: Some(label.to_string()),
                        text: String::new(),
                    },
                    None => PreviewMessage {
                        role: t.to_string(),
                        kind: "text".into(),
                        label: None,
                        text: truncate(&text, 1200),
                    },
                });
            }
        }
    }
    let title = if !custom_title.is_empty() { custom_title }
        else if !agent_name.is_empty() { agent_name }
        else { first_user_title };
    Some(SessionDetail { id: session_id.into(), agent_id: "claude".into(), title, modified_ms, messages })
}
