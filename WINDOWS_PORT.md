# Vector — Windows Port Scope

Status: **Phase 0 + backend shims implemented** (branch `windows-port`) · Target platform: **Windows 10/11 x86_64** · Source baseline: `v0.3.4`

## Progress log

Implemented on branch `windows-port` (backend compiles clean on `x86_64-pc-windows-msvc`):

- ✅ **Blocker — Claude session path encoding** (`sessions.rs`): Windows now flattens `\`, `/`, **and** `:` → `-` (verified `C:\Users\..` → `C--Users-..` against the real `.claude\projects` tree). Resume/search/auto-resume work.
- ✅ **Blocker — raw shell session** (`main.rs`): Windows branch spawns `pwsh.exe`/`powershell.exe -NoLogo`; zsh trampoline confined to non-Windows.
- ✅ **Blocker (discovered) — agent binary resolution** (`config.rs::which_path`): on Windows, executable extensions (`.exe/.cmd/.bat`) now take priority over a bare extensionless match — npm ships a non-runnable `claude` sh-shim next to `claude.cmd`, which the old order would have returned.
- ✅ **Blocker (discovered) — spawning `.cmd`/`.bat` shims** (`pty.rs`): batch shims (e.g. npm's `claude.cmd`) can't be launched via `CreateProcessW`; Windows now wraps them in `cmd.exe /c`. Native `.exe`s spawn directly.
- ✅ **Feature shim — reveal/open** (`preview.rs`): Windows `explorer /select,` + `cmd /C start`.
- ✅ **Feature shim — usage meter** (`usage.rs`): Windows reads the OAuth token from `<config_dir>\.credentials.json` instead of the macOS Keychain.
- ✅ **Feature shim — editor detection** (`sidebar.rs`): Windows detects editors by CLI shim on PATH (`code`/`cursor`/`windsurf`/`zed`/…) and launches them directly.
- ℹ️ **Verified safe** — `portable-pty` seeds the child env from `std::env::vars_os()` on Windows, so PowerShell/Claude inherit `USERPROFILE`/`APPDATA`/`SystemRoot`. The native menu, `set_badge_count`, and autostart plugin all compile on Windows.

Toolchain confirmed on this machine: Rust 1.96 (msvc), VS 2022 BuildTools + Win SDK 10.0.26100, Node 24, WebView2 149.

**Still open (Phase 1+):** keyboard scheme (frontend still uses `metaKey`/⌘ — app shortcuts won't fire on Windows; the on-screen `+`/buttons still work), `⌘` glyph labels, live cwd tracking, build/release/signing.

---

Target platform: **Windows 10/11 x86_64** · Source baseline: `v0.3.4`

Vector is a Tauri v2 desktop app where each terminal tab is a PTY running an AI
coding CLI (Claude Code, Codex, …) rendered into xterm.js. The architecture is
already cross-platform — `portable-pty` uses **ConPTY** on Windows, and several
Windows affordances already exist (`which_path` `.exe/.cmd/.bat` branch,
`default_shell()` → `powershell.exe`, `open_path` Windows arm,
`#![windows_subsystem = "windows"]`, `icon.ico` + Windows Store logos).

This doc is the implementation checklist. Work is **moderate and well-bounded**:
replace ~6 macOS shell-outs, fix one path-encoding bug, solve the keyboard-shortcut
design, and stand up Windows build/release/signing. No architectural rewrite.

---

## Key design decision (lock before coding)

**Keyboard scheme.** macOS uses ⌘ for app actions, leaving Ctrl for the
terminal. Windows has no Cmd, and Ctrl is load-bearing *inside* the terminal
(Ctrl+C/D/R/A…), so ⌘→Ctrl is wrong. Adopt the **Windows Terminal / VS Code**
convention — app actions on `Ctrl+Shift+<key>` — implemented as a single
platform keymap layer, not scattered `cfg` checks.

| macOS | Windows |
|---|---|
| ⌘T / ⌘W | Ctrl+Shift+T / Ctrl+Shift+W |
| ⌘D / ⌘⇧D (split) | Ctrl+Shift+D / Ctrl+Shift+E |
| ⌘1…9 (switch tab) | Alt+1…9 |
| ⌘, (settings) | Ctrl+, |
| ⌘-click (preview) | Ctrl+click |
| ⌘/⌥+arrows (readline) | leave to the agent; don't intercept |

---

## Phase 0 — "it runs" (~1–2 days)

Goal: green `tauri build` on Windows; open a tab, Claude runs, resume works.

- [ ] **🔴 Fix Claude session path encoding** — `src-tauri/src/sessions.rs:135`
  `encode_path_for_claude` only does `.replace('/', "-")`. On Windows Claude
  encodes drive `:` **and** every `\` to `-` (e.g. `C:\Users\me\proj` →
  `C--Users-me-proj`). Without this, session picker, search, auto-resume, and
  `--resume` all find nothing. Add a `#[cfg(windows)]` encoder that replaces
  `\`, `/`, and `:` with `-`. Verify against a real `%USERPROFILE%\.claude\projects\` dir.
- [ ] **🔴 Fix raw shell session** — `src-tauri/src/main.rs:232` (`start_shell_session`)
  Hardcodes `/bin/zsh -l` and a zsh OSC-7 trampoline; not `cfg`-guarded.
  Add a Windows branch: spawn PowerShell (no `-l`), skip or reimplement the
  cwd trampoline (PowerShell `prompt` function emitting OSC 7).
- [ ] Attempt `npm run tauri build` on Windows; resolve any remaining compile
  errors (likely just the macOS-only items below being referenced unguarded).
- [ ] Smoke test: new tab → Claude Code launches in a ConPTY → input/output/resize
  work → resume picker lists real sessions.

---

## Phase 1 — feature parity (~1–2 weeks)

- [ ] **🟠 Editor detection + open-in-editor** — `src-tauri/src/sidebar.rs:41-294`
  Currently macOS-only (`mdfind` + bundle IDs; `open -b <bundle_id>`). Rewrite
  for Windows: detect editors via PATH shims (`code`, `cursor`, `windsurf`,
  `zed`) and/or registry / known install paths; launch the executable directly.
  Replace the hardcoded `EDITORS` bundle-id table with a platform-specific list.
- [ ] **🟠 Claude usage meter** — `src-tauri/src/usage.rs:81`
  Drop the `/usr/bin/security` Keychain call on Windows. Claude stores the token
  in a file: `%USERPROFILE%\.claude\.credentials.json` (namespaced per
  `CLAUDE_CONFIG_DIR`). Add a `#[cfg(windows)]` reader that parses the JSON and
  pulls `claudeAiOauth.accessToken`. (Simpler than mac.)
- [ ] **🟠 Reveal / Open-in-default** — `src-tauri/src/preview.rs:134-154`
  Both hardcode `/usr/bin/open`. Windows: reveal via `explorer /select,<path>`,
  open via `cmd /C start "" <path>`. Relabel context-menu "Reveal in Finder" →
  "Reveal in Explorer" (`src/sidebar/contextMenu.tsx`, `src/preview/contextMenu.tsx`).
- [ ] **🟡 Keyboard scheme** — `src/App.tsx` (all `metaKey` handlers, ~lines
  1203–1230, 3777–3835) + `⌘` glyphs in tooltips/labels. Implement the keymap
  layer from the design decision above; render Ctrl/Ctrl+Shift labels on Windows.
- [ ] **🟡 Polish:**
  - `augmented_path()` `src-tauri/src/config.rs:169` — add `%APPDATA%\npm`; the
    mac dirs are harmless but pointless on Windows.
  - Native menu `src-tauri/src/main.rs:802` — `.services()/.hide_others()` are
    mac-isms; build a Windows-appropriate menu (or rely on the in-app UI).
  - `set_badge_count` `src-tauri/src/main.rs:627` — graceful no-op / taskbar
    overlay fallback on Windows.
  - Re-tune the `cols-3` xterm width fudge for WebView2 (it's tuned for WKWebView).
  - Re-test xterm renderer on WebView2 — WebGL/Canvas were removed because they
    rendered worse on WKWebView; they may be fine (or better) on WebView2. DOM is
    the safe default; only change after testing.

---

## Phase 2 — build, release & distribution (~3–5 days)

- [ ] **GitHub Actions matrix** building macOS + Windows, replacing the mac-only
  `scripts/release.sh` (bash, dmg/app.tar.gz paths, `date -u`).
- [ ] **Updater manifest** — `tauri.conf.json` has a pubkey but `latest.json`
  only carries `darwin-aarch64`. Add `windows-x86_64`, sign Windows artifacts
  with the same updater key, assemble a combined `latest.json`.
- [ ] **Installer** — `targets: "all"` produces MSI (WiX) + NSIS on Windows;
  ensure the WiX/NSIS toolchain is available in CI. Icons already present.
- [ ] **Code signing / SmartScreen** — unsigned Windows builds trigger SmartScreen.
  Either obtain an OV/EV cert or document the "More info → Run anyway" bypass
  (analogous to the macOS Gatekeeper note in the README).

---

## Phase 3 — nice-to-have

- [ ] **🔵 Live cwd tracking** — `src-tauri/src/main.rs:690` (`read_agent_cwd`)
  Uses macOS `libproc`/`proc_pidinfo`; returns `None` elsewhere. Querying another
  process's cwd on Windows is harder (NtQueryInformationProcess + PEB read, or a
  shell trampoline that reports cwd). Ship v1 with the `None` fallback (spawn-time
  cwd — same as today's non-mac behavior); add real tracking later.

---

## Already cross-platform (no work)

- PTY core (`pty.rs`) — `portable-pty` → ConPTY on Windows. VT filtering is byte-level.
- `git.rs` — all via `which_path("git")`; works if git is installed/on PATH.
- Claude **profiles** — `CLAUDE_CONFIG_DIR` works on Windows; seeding works
  *better* (credentials are a file, not Keychain, so login persists after seed).
  `credentials_in_keychain` is already `cfg!(target_os = "macos")`-guarded.
- `which_path` `.exe/.cmd/.bat` branch, `default_shell()`, `open_path` Windows
  arm, `#![windows_subsystem = "windows"]`, `icon.ico` + Store logos.
- Config paths: `dirs::config_dir()` → `%APPDATA%\vector\` on Windows (README's
  `~/.config/vector` is mac/linux — doc note only).

---

## Strategy

This is open source ([avram19/vector](https://github.com/avram19/vector)) and the
maintainer is open to contributions. Prefer **upstream PRs behind `cfg`/platform
layers** over a hard fork — the codebase is already structured for it.

## Rough timeline

- Daily-drivable internal Windows build: **~2 weeks** (Phases 0–1).
- Polished, signed, auto-updating public release: **~1 more week** (Phase 2).
