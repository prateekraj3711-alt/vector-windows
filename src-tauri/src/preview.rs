use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
pub struct PathInfo {
    pub abs_path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct ReadFileResult {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub size_bytes: u64,
    pub mime: Option<String>,
}

fn expand_tilde(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

#[tauri::command]
pub fn path_exists(abs_path: String) -> Result<Option<PathInfo>, String> {
    let p = expand_tilde(&abs_path);
    let canonical = match std::fs::canonicalize(&p) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let meta = match std::fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    Ok(Some(PathInfo {
        abs_path: canonical.to_string_lossy().to_string(),
        is_dir: meta.is_dir(),
    }))
}

fn guess_mime(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "mmd" | "mermaid" => "text/x-mermaid",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(mime.to_string())
}

#[tauri::command]
pub fn read_file_bytes(path: String, cap_bytes: u64) -> Result<ReadFileResult, String> {
    let p = expand_tilde(&path);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("path is a directory".to_string());
    }
    let size_bytes = meta.len();
    let mime = guess_mime(&p);
    if size_bytes > cap_bytes {
        return Ok(ReadFileResult {
            bytes: Vec::new(),
            truncated: true,
            size_bytes,
            mime,
        });
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(ReadFileResult {
        bytes,
        truncated: false,
        size_bytes,
        mime,
    })
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = expand_tilde(&path);
    Command::new("open")
        .arg("-R")
        .arg(&p)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_default_app(path: String) -> Result<(), String> {
    let p = expand_tilde(&path);
    Command::new("open")
        .arg(&p)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}
