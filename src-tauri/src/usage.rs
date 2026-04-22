// Anthropic rate-limit usage (same data Claude Code's `/usage` shows).
//
// Endpoint: https://api.anthropic.com/api/oauth/usage
// Auth:     Bearer <claudeAiOauth.accessToken> from the macOS Keychain
//           ("Claude Code-credentials"). We exec `security find-generic-password`
//           rather than depending on a keychain crate — the output is small
//           JSON and the call is rare (polled once per minute).

use serde::{Deserialize, Serialize};
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

fn read_oauth_token() -> Option<String> {
    // `security find-generic-password -s "Claude Code-credentials" -w` returns
    // the password (the JSON blob) on stdout. We parse out accessToken.
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let raw = String::from_utf8(out.stdout).ok()?;
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    // Two observed shapes: { claudeAiOauth: { accessToken } } or { accessToken }.
    v.get("claudeAiOauth").and_then(|o| o.get("accessToken")).and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

pub async fn fetch_claude_usage() -> Result<Option<ClaudeUsage>, String> {
    let token = match read_oauth_token() { Some(t) => t, None => return Ok(None) };
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
