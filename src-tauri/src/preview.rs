use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[derive(Serialize)]
pub struct PreviewMeta {
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

/// Cheap stat-only check used by the preview pane before fetching bytes.
/// Returns size + mime + whether the file exceeds `cap_bytes`. Async +
/// `spawn_blocking` so the metadata syscall never stalls the main thread.
#[tauri::command]
pub async fn preview_meta(path: String, cap_bytes: u64) -> Result<PreviewMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand_tilde(&path);
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err("path is a directory".to_string());
        }
        let size_bytes = meta.len();
        let mime = guess_mime(&p);
        Ok(PreviewMeta { truncated: size_bytes > cap_bytes, size_bytes, mime })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stream raw file bytes back to the frontend as binary. Tauri v2's
/// `ipc::Response` puts the bytes on the wire as an ArrayBuffer instead of
/// expanding them into a JSON `number[]` (which inflates ~4× and parses on
/// the WebView main thread — the preview hang root cause).
#[tauri::command]
pub async fn read_file_raw(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let p = expand_tilde(&path);
        std::fs::read(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Reveal a path in the OS file manager, selecting the entry.
/// macOS: `open -R`. Linux: `xdg-open` on the parent dir (no portable "select").
/// Windows: `explorer /select,<path>`.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = expand_tilde(&path);

    #[cfg(target_os = "macos")]
    {
        let open_bin = crate::config::which_path("open").unwrap_or_else(|| std::path::PathBuf::from("/usr/bin/open"));
        Command::new(open_bin).arg("-R").arg(&p).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // explorer.exe returns nonzero even on success, so don't check status.
        // /select, must be a single argument joined to the path with no space.
        crate::config::silent_command("explorer.exe")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let target = p.parent().unwrap_or(&p).to_path_buf();
        Command::new("xdg-open").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a path with the OS default handler.
/// macOS: `open`. Linux: `xdg-open`. Windows: `cmd /C start "" <path>`.
#[tauri::command]
pub fn open_default_app(path: String) -> Result<(), String> {
    let p = expand_tilde(&path);

    #[cfg(target_os = "macos")]
    {
        let open_bin = crate::config::which_path("open").unwrap_or_else(|| std::path::PathBuf::from("/usr/bin/open"));
        Command::new(open_bin).arg(&p).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // The empty "" is start's title argument — required so a quoted path
        // isn't consumed as the window title.
        crate::config::silent_command("cmd")
            .args(["/C", "start", ""])
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&p).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
