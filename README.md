# Vector (Windows port)

An agent-first terminal. Every tab starts inside your favorite coding agent
(Claude Code, Codex, Cursor Agent, GitHub Copilot CLI, Aider, Gemini, Amazon
Q, OpenCode, Crush, Goose, Amp, Plandex, Continue, Qodo — or a raw shell),
not a shell prompt.

> **About this repository.** This is a Windows port of
> [avram19/vector](https://github.com/avram19/vector), which is macOS
> (Apple Silicon) only upstream. All original work and copyright belong to the
> upstream author; this fork adds Windows platform support (PTY/ConPTY,
> path handling, agent-binary resolution, file-manager/editor integration,
> credential reading) and is redistributed under the same
> [PolyForm Noncommercial License 1.0.0](./LICENSE). See
> [`WINDOWS_PORT.md`](./WINDOWS_PORT.md) for the port scope and progress.

<p align="center">
  <img src="src/logo.png" alt="Vector" width="96" />
</p>

## Table of Contents

- [Features](#features)
  - [Agent-native tabs](#agent-native-tabs)
  - [Claude Profiles](#claude-profiles)
  - [Pane splits](#pane-splits)
  - [File Previewer](#file-previewer)
  - [Sidebar — files & worktrees](#sidebar--files--worktrees)
  - [Resume Claude sessions](#resume-claude-sessions)
  - [Auto-detect installed agents](#auto-detect-installed-agents)
  - [Project picker](#project-picker)
  - [Per-tab agent swap](#per-tab-agent-swap)
  - [Claude usage meter](#claude-usage-meter)
  - [Terminal context menu](#terminal-context-menu)
  - [Bell notifications](#bell-notifications)
  - [Theme](#theme)
  - [Tab layout](#tab-layout)
  - [Per-agent icons and chips](#per-agent-icons-and-chips)
- [Shortcuts](#shortcuts)
- [Claude Profiles (in depth)](#claude-profiles-in-depth)
- [How it was built](#how-it-was-built)
- [Try it](#try-it)
- [Build from source](#build-from-source)
- [Add a custom agent](#add-a-custom-agent)
- [License](#license)

## Features

### Agent-native tabs

`⌘T` opens a new tab already inside an agent, scoped to a project folder you pick.

### Claude Profiles

Map folders to separate Claude accounts (`CLAUDE_CONFIG_DIR` under the hood). Open `~/work` with your work account, `~/personal` with your personal one — no more `/logout` → `/login`. [Read more](#claude-profiles-in-depth).

### Pane splits

Split a tab into a grid of agent panes with `⌘D` / `⌘⇧D`, drag dividers to resize, drag panes between tabs. Each pane runs its own agent.

### File Previewer

⌘-click any file path printed by an agent to open a read-only preview in a side pane on the same tab. Supports Markdown (with embedded Mermaid diagrams), standalone Mermaid, syntax-highlighted code (js/ts/py/rs/rb and other common formats), PDF, and images. ⌘⇧-click pins a second preview for side-by-side compare. Right-click any path or preview pane for **Reveal in Finder**, **Open in default app**, or **Copy path**.

### Sidebar — files & worktrees

A collapsible sidebar with two tabs, both scoped to the focused tab's project:

- **Files** — VSCode-style tree of the project root with hidden-files toggle. Click to open a preview, ⌘⇧-click to pin a second preview. Right-click for Reveal in Finder, Open in default app, Open in installed editor (VS Code / Cursor / Zed / Windsurf / WebStorm / IntelliJ / PyCharm / Sublime), or Copy path. Tree refreshes live as the agent writes files.
- **Worktrees** — every git repo discovered under the project, grouped by repo. Each worktree expands to show **Uncommitted** and **Committed (vs base)** changes. Click a change to open a unified diff with syntax highlighting in the preview pane. Toggle between flat and tree views from the search bar; both persist across restarts. Right-click a worktree for Reveal / Open / Open in editor.

Sidebar width, active tab, collapsed state, hidden-files toggle, and worktrees view mode all persist via `~/.config/vector/ui.toml`.

### Resume Claude sessions

The project picker surfaces the session history for the folder you chose, so you can jump back into a conversation instead of starting fresh.

### Auto-detect installed agents

Scans `PATH` for known CLIs; only shows ones you actually have.

### Project picker

Remembers recents, one picker per new tab.

### Per-tab agent swap

Change agent from the topbar dropdown; session restarts cleanly.

### Claude usage meter

Live 5-hour and 7-day usage bars in the topbar when a Claude pane is active.

### Terminal context menu

Right-click a URL or file path to Open / Reveal in Finder / Copy. Right-click a selection to **Copy as plain text** (strips NBSP, zero-width chars, and Claude's indent gutter so pasting into Slack or docs doesn't look weird).

### Bell notifications

When an agent emits `\x07` (asking for input) and the tab is inactive or the window is unfocused, the tab is highlighted and a macOS notification fires.

### Theme

Dark or Solarized Light.

### Tab layout

Horizontal on top, or vertical sidebar.

### Per-agent icons and chips

Per-agent icons and chips in every tab.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab (opens project picker) |
| `⌘W` | Close active pane |
| `⌘D` / `⌘⇧D` | Split pane right / down |
| `⌘⌥←` `⌘⌥→` `⌘⌥↑` `⌘⌥↓` | Focus adjacent pane |
| `⌘⇧R` | Reload (restart) active agent |
| `⌘1`…`⌘9` | Switch tab |
| `⌃⇥` / `⌃⇧⇥` | Next / previous tab |
| `⌘,` | Open Settings |
| `⇧↵` | Multi-line input (Claude Code) |
| `⌘←` / `⌘→` | Cursor to line start / end (while typing) |
| `⌥←` / `⌥→` | Cursor back / forward one word |
| `⌘⌫` / `⌥⌫` | Delete to line start / word start |

## Claude Profiles (in depth)

If you juggle two Claude accounts — say personal and work — the usual flow is painful: Claude Code keeps a single login in `~/.claude/`, so switching means `/logout` then `/login` every time you move between folders.

Vector solves this by mapping **folders → profiles**, where each profile is an isolated Claude home (`~/.claude-profiles/<id>/`) injected via `CLAUDE_CONFIG_DIR` when a Claude session starts in a matched folder.

- **Open Settings** (`⌘,`) → **Claude Profiles** → **Add profile**.
- Pick a name, the folders that should use it, and (under **Advanced**) a **Seed from** source — defaults to `~/.claude`, or point it at `~/.claude-work` / any existing Claude home. Credentials, `settings.json`, and `projects/` history are copied over so the new profile starts with your real state instead of a blank install.
- macOS stores Claude credentials in Keychain by default; seeding copies everything else but the new profile will still prompt `/login` once — after that it sticks.
- Each Claude tab shows a small pill with the active profile. Click it to override for just that tab (ephemeral) or jump to **Manage profiles**.

Folders not mapped to any profile continue to use your existing `~/.claude/` — upgrading Vector never touches your default login.

## How it was built

**This is a vibe-coded app.** A human supplied the requirements in plain
English, and the implementation — Rust backend, React/TypeScript frontend,
Tauri packaging, icon generation, all of it — was produced by an AI coding
agent following those requirements. No line of code here was hand-written by
the human who scoped the project.

If you're curious what "agentic software development" looks like end-to-end,
this repository is one example: read the requirements, read the code, and
judge for yourself.

## Install on Windows

**Requirements:** Windows 10/11 (x64). The
[Microsoft Edge WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
is required — it ships with current Windows 11 and is auto-installed by the
setup if missing.

1. Go to the [**Releases**](https://github.com/prateekraj3711-alt/vector-windows/releases)
   page and download one of:
   - `Vector_<version>_x64-setup.exe` — **NSIS installer** (recommended; per-user, no admin needed)
   - `Vector_<version>_x64_en-US.msi` — **MSI installer** (for managed/Group-Policy deploys)
2. Run the installer.
3. **SmartScreen warning:** because the build is not yet code-signed, Windows
   SmartScreen will show *"Windows protected your PC."* Click **More info →
   Run anyway** to proceed. (This goes away once the app is signed with an
   OV/EV certificate.)
4. Launch **Vector** from the Start menu.

Vector auto-detects any AI CLIs already on your `PATH` (Claude Code, Codex,
Gemini, …). Install at least one — e.g. Claude Code via `npm i -g
@anthropic-ai/claude-code` — and it appears in the new-tab agent list.

> **Note on keyboard shortcuts (Windows):** the in-app `⌘`-based shortcuts are
> being remapped for Windows (tracked in `WINDOWS_PORT.md`). For now, use the
> on-screen controls (the **+** button for a new tab, the topbar dropdowns,
> right-click context menus). Core terminal keys (Ctrl+C, etc.) pass straight
> through to your agent.

## Install on macOS

Download the latest `.dmg` from the
[upstream Releases](https://github.com/avram19/vector/releases) page, drag
Vector into `/Applications`, and open it. Because the build is unsigned,
Gatekeeper blocks it the first time — bypass with **right-click → Open → Open**,
or `xattr -dr com.apple.quarantine /Applications/Vector.app`.

## Build from source

**Requirements:**

- **Rust** (stable, MSVC host on Windows) — <https://rustup.rs>
- **Node 20+**
- **Windows:** Visual Studio 2022 **C++ build tools** (the
  *Desktop development with C++* workload) + a Windows 10/11 SDK, and the
  WebView2 runtime.
- **macOS:** Xcode command-line tools. **Linux:** the usual `webkit2gtk`/`gtk` dev packages.

```bash
npm install
npm run tauri dev       # dev build with hot reload
npm run tauri build     # release build + installers
```

On Windows, `npm run tauri build` produces, under
`src-tauri/target/release/bundle/`:

- `nsis/Vector_<version>_x64-setup.exe`
- `msi/Vector_<version>_x64_en-US.msi`

To produce signed updater artifacts locally, set the signing env vars before
building (CI sets these from repo secrets automatically):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.vector-windows-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<your key password>"
npm run tauri build
```

## Releasing (automated)

Pushing a version tag builds and publishes the Windows installers
automatically via [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml):

```bash
git tag v0.3.4-win.1
git push origin v0.3.4-win.1   # → GitHub Actions builds + signs + creates the Release
```

The workflow can also be run manually from the **Actions** tab (provide a tag).
It signs the updater bundle with the repo secrets `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and uploads the NSIS/MSI installers
plus `latest.json` (consumed by the in-app auto-updater).

## Add a custom agent

Drop a TOML file at `%APPDATA%\vector\config.toml` (Windows) or
`~/.config/vector/config.toml` (macOS/Linux):

```toml
default = "claude"

[agents.myagent]
label = "My Custom Agent"
command = ["my-cli", "--flag"]

[agents.myagent.env]
MY_API_KEY = "..."
```

Vector merges this with the built-in list on every launch.

## License

Source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

Anyone is free to read, modify, redistribute, and use Vector for non-commercial
purposes (personal use, research, hobby projects, internal use at a nonprofit,
etc.). **Commercial use requires a separate license** — open an issue or
contact the maintainer.

Vector bundles and invokes third-party CLIs (Claude Code, Codex, Cursor
Agent, Copilot CLI, etc.) — those are governed by their own licenses and
terms of service.
