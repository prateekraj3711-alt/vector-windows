# Vector

An agent-first terminal. Every tab starts inside your favorite coding agent
(Claude Code, Codex, Cursor Agent, GitHub Copilot CLI, Aider, Gemini, Amazon
Q, OpenCode, Crush, Goose, Amp, Plandex, Continue, Qodo — or a raw shell),
not a shell prompt.

<p align="center">
  <img src="src/logo.png" alt="Vector" width="96" />
</p>

## What it does

- **Agent-native tabs** — `⌘T` opens a new tab already inside an agent, scoped to a project folder you pick.
- **Claude Profiles** — map folders to separate Claude accounts (`CLAUDE_CONFIG_DIR` under the hood). Open `~/work` with your work account, `~/personal` with your personal one — no more `/logout` → `/login`. Seed a new profile from an existing Claude home to carry over login, settings, and session history. A small pill on each Claude tab shows the active profile with a dropdown to override.
- **Pane splits** — split a tab into a grid of agent panes with `⌘D` / `⌘⇧D`, drag dividers to resize, drag panes between tabs. Each pane runs its own agent.
- **Resume Claude sessions** — the project picker surfaces the session history for the folder you chose, so you can jump back into a conversation instead of starting fresh.
- **Auto-detect installed agents** — scans `PATH` for known CLIs; only shows ones you actually have.
- **Project picker** — remembers recents, one picker per new tab.
- **Per-tab agent swap** — change agent from the topbar dropdown; session restarts cleanly.
- **Claude usage meter** — live 5-hour and 7-day usage bars in the topbar when a Claude pane is active.
- **Terminal context menu** — right-click a URL or file path to Open/Copy. Right-click a selection to **Copy as plain text** (strips NBSP, zero-width chars, and Claude's indent gutter so pasting into Slack or docs doesn't look weird).
- **Bell notifications** — when an agent emits `\x07` (asking for input) and the tab is inactive or the window is unfocused, the tab is highlighted and a macOS notification fires.
- **Theme** — dark or Solarized Light.
- **Tab layout** — horizontal on top, or vertical sidebar.
- **Per-agent icons and chips** in every tab.

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

## Claude Profiles

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

## Try it

Download the latest `.dmg` from the [Releases](https://github.com/avram19/vector/releases)
page, drag Vector into `/Applications`, and open it.

Because the build is unsigned, macOS Gatekeeper will block it the first time.
To bypass once:

```
# Option A — right-click Open
Right-click Vector.app → Open → Open

# Option B — remove the quarantine attribute
xattr -dr com.apple.quarantine /Applications/Vector.app
```

After the first launch, you can open it normally from Launchpad or
Spotlight.

On first launch Vector will ask for Notification permission (so agents can
alert you when they need input) — grant it in System Settings if you dismiss
the prompt.

## Build from source

Requirements: Rust (stable), Node 20+, macOS / Linux / Windows.

```bash
npm install
npm run tauri dev       # dev build with HMR
npm run tauri build     # produce .app + .dmg in src-tauri/target/release/bundle/
```

## Add a custom agent

Drop a TOML file at `~/.config/vector/config.toml`:

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
