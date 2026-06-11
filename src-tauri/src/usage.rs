// Anthropic rate-limit usage (same data Claude Code's `/usage` shows).
//
// Endpoint: https://api.anthropic.com/api/oauth/usage
// Auth:     Bearer <claudeAiOauth.accessToken> from the macOS Keychain
//           ("Claude Code-credentials"). We exec `security find-generic-password`
//           rather than depending on a keychain crate — the output is small
//           JSON and the call is rare (polled once per minute).

use crate::config;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, Clone, Deserialize, Default)]
struct RawBucket {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct RawUsage {
    #[serde(default)]
    five_hour: Option<RawBucket>,
    #[serde(default)]
    seven_day: Option<RawBucket>,
    #[serde(default)]
    seven_day_sonnet: Option<RawBucket>,
    #[serde(default)]
    seven_day_opus: Option<RawBucket>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: Option<Bucket>,
    pub seven_day: Option<Bucket>,
    pub seven_day_sonnet: Option<Bucket>,
    pub seven_day_opus: Option<Bucket>,
}

impl From<RawBucket> for Bucket {
    fn from(b: RawBucket) -> Self {
        Self { utilization: b.utilization.unwrap_or(0.0), resets_at: b.resets_at }
    }
}

/// Pull the OAuth access token out of a Claude credentials JSON blob.
/// Two observed shapes: `{ claudeAiOauth: { accessToken } }` or `{ accessToken }`.
fn parse_access_token(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v.get("claudeAiOauth").and_then(|o| o.get("accessToken")).and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

/// Keychain service name Claude Code uses for a given profile id (macOS only).
///
/// Default profile (None / `"__default__"`) → `"Claude Code-credentials"`.
/// Custom profile → `"Claude Code-credentials-<sha8>"`, where the suffix is
/// the first 8 hex chars of SHA-256 over the profile's absolute config dir
/// path. This mirrors how Claude Code namespaces tokens per `CLAUDE_CONFIG_DIR`.
#[cfg(target_os = "macos")]
fn keychain_service_for_profile(profile_id: Option<&str>) -> Option<String> {
    match profile_id {
        None | Some("") | Some("__default__") => Some("Claude Code-credentials".into()),
        Some(id) => {
            let dir = config::profile_config_dir(id)?;
            let path_str = dir.to_string_lossy();
            let mut hasher = Sha256::new();
            hasher.update(path_str.as_bytes());
            let digest = hasher.finalize();
            let hex: String = digest.iter().take(4).map(|b| format!("{:02x}", b)).collect();
            Some(format!("Claude Code-credentials-{hex}"))
        }
    }
}

/// macOS keeps the token in the login Keychain; read it via `security`.
#[cfg(target_os = "macos")]
fn read_oauth_token(profile_id: Option<&str>) -> Option<String> {
    // `security find-generic-password -s "<service>" -w` returns the password
    // (the JSON blob) on stdout. We parse out accessToken.
    let service = keychain_service_for_profile(profile_id)?;
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &service, "-w"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let raw = String::from_utf8(out.stdout).ok()?;
    parse_access_token(&raw)
}

/// Windows / Linux keep the token in a file: `<config_dir>/.credentials.json`,
/// where `<config_dir>` is `CLAUDE_CONFIG_DIR` for a custom profile or
/// `~/.claude` for the default. (No OS keychain involved — simpler than macOS.)
#[cfg(not(target_os = "macos"))]
fn read_oauth_token(profile_id: Option<&str>) -> Option<String> {
    let config_dir = match profile_id {
        None | Some("") | Some("__default__") => dirs::home_dir()?.join(".claude"),
        Some(id) => config::profile_config_dir(id)?,
    };
    // `.credentials.json` is the canonical name; tolerate `credentials.json` too.
    for name in [".credentials.json", "credentials.json"] {
        let path = config_dir.join(name);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(tok) = parse_access_token(&raw) {
                return Some(tok);
            }
        }
    }
    None
}

pub async fn fetch_claude_usage(profile_id: Option<&str>) -> Result<Option<ClaudeUsage>, String> {
    let token = match read_oauth_token(profile_id) { Some(t) => t, None => return Ok(None) };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        // Don't treat auth/server errors as fatal — surface None so the UI hides.
        return Ok(None);
    }
    let raw: RawUsage = resp.json().await.map_err(|e| e.to_string())?;
    Ok(Some(ClaudeUsage {
        five_hour: raw.five_hour.map(Into::into),
        seven_day: raw.seven_day.map(Into::into),
        seven_day_sonnet: raw.seven_day_sonnet.map(Into::into),
        seven_day_opus: raw.seven_day_opus.map(Into::into),
    }))
}
