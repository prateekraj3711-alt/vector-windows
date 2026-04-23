use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub label: Option<String>,
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub default: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeProfile {
    /// Stable id (slugified from name at creation). Directory under ~/.claude-profiles/<id>.
    pub id: String,
    /// Display name — editable.
    pub name: String,
    /// Hex color for the avatar/pill (e.g. "#7fd6b5").
    pub color: String,
    /// Project folders this profile applies to. Absolute paths; leading `~` is expanded at match time.
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfilesFile {
    #[serde(default)]
    pub profiles: Vec<ClaudeProfile>,
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vector").join("config.toml"))
}

pub fn load() -> Config {
    let mut cfg = builtin();
    if let Some(p) = config_path() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(user) = toml::from_str::<Config>(&text) {
                if let Some(d) = user.default {
                    cfg.default = Some(d);
                }
                for (k, v) in user.agents {
                    cfg.agents.insert(k, v);
                }
            }
        }
    }
    cfg
}

fn builtin() -> Config {
    let known: &[(&str, &str, &[&str])] = &[
        ("claude",   "Claude Code",         &["claude"]),
        ("codex",    "Codex",               &["codex"]),
        ("cursor",   "Cursor Agent",        &["cursor-agent"]),
        ("copilot",  "GitHub Copilot CLI",  &["copilot", "gh-copilot"]),
        ("aider",    "Aider",               &["aider"]),
        ("gemini",   "Gemini CLI",          &["gemini"]),
        ("q",        "Amazon Q",            &["q"]),
        ("opencode", "OpenCode",            &["opencode"]),
        ("crush",    "Crush",               &["crush"]),
        ("goose",    "Goose",               &["goose"]),
        ("amp",      "Amp",                 &["amp"]),
        ("plandex",  "Plandex",             &["plandex"]),
        ("continue", "Continue",            &["continue", "cn"]),
        ("qodo",     "Qodo",                &["qodo", "qodo-gen"]),
    ];
    let mut agents = BTreeMap::new();
    for (id, label, bins) in known {
        let first = bins.iter().find(|b| which(b)).copied().unwrap_or(bins[0]);
        agents.insert(
            (*id).into(),
            AgentSpec { label: Some((*label).into()), command: vec![first.into()], env: Default::default() },
        );
    }
    Config { default: Some("claude".into()), agents }
}

pub fn augmented_path() -> std::ffi::OsString {
    let mut path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        let extra = [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
        ];
        let mut joined: Vec<PathBuf> = std::env::split_paths(&path).collect();
        for e in extra {
            if !joined.contains(&e) { joined.push(e); }
        }
        path = std::env::join_paths(joined).unwrap_or(path);
    }
    path
}

pub fn which_path(bin: &str) -> Option<PathBuf> {
    // Absolute / contains path sep: use as-is.
    let p = PathBuf::from(bin);
    if p.is_absolute() || bin.contains('/') {
        return if p.is_file() { Some(p) } else { None };
    }
    let path = augmented_path();
    for dir in std::env::split_paths(&path) {
        let full = dir.join(bin);
        if full.is_file() { return Some(full); }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let f = dir.join(format!("{bin}.{ext}"));
                if f.is_file() { return Some(f); }
            }
        }
    }
    None
}

pub fn which(bin: &str) -> bool {
    which_path(bin).is_some()
}

// ——— Claude profiles ———

fn profiles_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vector").join("profiles.toml"))
}

pub fn profiles_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude-profiles"))
}

pub fn profile_config_dir(id: &str) -> Option<PathBuf> {
    profiles_root().map(|r| r.join(id))
}

pub fn load_profiles() -> ProfilesFile {
    let Some(p) = profiles_path() else { return ProfilesFile::default() };
    let Ok(text) = std::fs::read_to_string(&p) else { return ProfilesFile::default() };
    toml::from_str(&text).unwrap_or_default()
}

pub fn save_profiles(pf: &ProfilesFile) -> std::io::Result<()> {
    let Some(p) = profiles_path() else {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no config dir"));
    };
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = toml::to_string_pretty(pf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    // Atomic write: tmp + rename.
    let tmp = p.with_extension("toml.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

/// Expand a leading `~` in `s` to the user's home dir. Non-`~` paths pass through.
pub fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~") {
        if let Some(home) = dirs::home_dir() {
            let rest = rest.strip_prefix('/').unwrap_or(rest);
            return home.join(rest);
        }
    }
    PathBuf::from(s)
}

/// Longest-prefix match: return the profile whose folder is the deepest ancestor
/// (or equal to) `cwd`. Ties broken by insertion order.
///
/// Intentionally does NOT call `fs::canonicalize` — it performs I/O and would
/// block the caller's critical section (start_session holds the profiles Mutex)
/// if one of the user's mapped folders is on a stalled NFS mount or a detached
/// external volume. Instead we normalise paths lexically: expand `~`, strip
/// trailing slashes, and compare as `Path`s. Callers that need canonicalisation
/// should do it upstream outside the lock.
pub fn resolve_profile_for_path<'a>(pf: &'a ProfilesFile, cwd: &Path) -> Option<&'a ClaudeProfile> {
    fn lexical_normalise(p: &Path) -> PathBuf {
        // Drop trailing separators so `/foo` and `/foo/` compare equal.
        let s = p.to_string_lossy();
        let trimmed = s.trim_end_matches('/');
        PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed })
    }
    let cwd = lexical_normalise(cwd);
    let mut best: Option<(&ClaudeProfile, usize)> = None;
    for prof in &pf.profiles {
        for folder in &prof.folders {
            let f = lexical_normalise(&expand_tilde(folder));
            if cwd == f || cwd.starts_with(&f) {
                let depth = f.components().count();
                if best.map(|(_, d)| depth > d).unwrap_or(true) {
                    best = Some((prof, depth));
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

/// Slugify a display name into a filesystem-safe id. Lowercased, non-alphanumerics
/// collapsed to `-`. If the result would collide with an existing id, a numeric
/// suffix is appended.
pub fn slugify_profile_id(name: &str, existing: &[String]) -> String {
    let mut base: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    // Collapse dashes.
    while base.contains("--") { base = base.replace("--", "-"); }
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "profile".to_string() } else { base };
    if !existing.iter().any(|e| e == &base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|e| e == &candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
