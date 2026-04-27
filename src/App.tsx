import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check as checkUpdate, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import logoUrl from "./logo.png";

// Compare two `X.Y.Z` version strings. Returns negative if a<b, 0 if equal, positive if a>b.
// Non-numeric chunks (pre-release tags like `-beta.1`) are ignored — we only ship stable releases.
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Minimal markdown → JSX renderer for the "What's new" modal. Supports the
// subset we actually write in release notes: `##` headings, `-` list items,
// `**bold**`, `` `code` ``, and `[label](url)` links. Anything else falls
// through as plain text — good enough for hand-authored release bodies.
function renderInline(text: string, k0 = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m: RegExpExecArray | null, k = k0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k++}>{m[2]}</code>);
    else if (m[3] !== undefined) {
      const url = m[4];
      out.push(
        <a key={k++} href="#" onClick={(e) => { e.preventDefault(); invoke("open_path", { path: url }).catch(() => {}); }}>{m[3]}</a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  let para: string[] | null = null;
  let key = 0;
  const flushList = () => {
    if (list) {
      const items = list;
      blocks.push(<ul key={key++} className="wn-list">{items.map((l, i) => <li key={i}>{renderInline(l)}</li>)}</ul>);
      list = null;
    }
  };
  const flushPara = () => {
    if (para && para.length) {
      blocks.push(<p key={key++}>{renderInline(para.join(" "))}</p>);
      para = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s+/.test(line)) {
      flushList(); flushPara();
      blocks.push(<h3 key={key++} className="wn-h">{renderInline(line.replace(/^#{1,6}\s+/, ""))}</h3>);
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!list) list = [];
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushList(); flushPara();
    } else {
      flushList();
      if (!para) para = [];
      para.push(line);
    }
  }
  flushList(); flushPara();
  return blocks;
}

type AgentMeta = { id: string; label: string; available: boolean };

type PaneLeaf = {
  kind: "leaf";
  id: string;
  agentId: string;
  cwd: string;
  resumeId?: string;
  continueLatest?: boolean;
  epoch: number;
  /** Per-pane Claude profile override. `undefined` → use path-based resolution.
   *  `null` → force default (~/.claude). String → use that profile id. */
  profileOverride?: string | null;
  /** User-entered pane name. Takes precedence over the PTY-emitted title. */
  userTitle?: string;
};
type PaneSplit = {
  kind: "split";
  id: string;
  direction: "row" | "column";
  children: [PaneNode, PaneNode];
  ratio: number;
};
type PaneNode = PaneLeaf | PaneSplit;
type Tab = { id: string; root: PaneNode; activePaneId: string; userTitle?: string };

// --- pane-tree helpers ---
function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id);
}
function firstLeafId(node: PaneNode): string {
  return node.kind === "leaf" ? node.id : firstLeafId(node.children[0]);
}
function allLeafIds(node: PaneNode): string[] {
  return node.kind === "leaf" ? [node.id] : [...allLeafIds(node.children[0]), ...allLeafIds(node.children[1])];
}
function mapLeaf(node: PaneNode, id: string, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === "leaf") return node.id === id ? fn(node) : node;
  return { ...node, children: [mapLeaf(node.children[0], id, fn), mapLeaf(node.children[1], id, fn)] };
}
function mapAllLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === "leaf") return fn(node);
  return { ...node, children: [mapAllLeaves(node.children[0], fn), mapAllLeaves(node.children[1], fn)] };
}
function splitLeaf(root: PaneNode, leafId: string, direction: "row" | "column", newAgentId: string): { root: PaneNode; newLeafId: string } {
  let newLeafId = "";
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      newLeafId = crypto.randomUUID();
      const newLeaf: PaneLeaf = { kind: "leaf", id: newLeafId, agentId: newAgentId, cwd: node.cwd, epoch: 0 };
      return { kind: "split", id: crypto.randomUUID(), direction, children: [node, newLeaf], ratio: 0.5 };
    }
    return { ...node, children: [walk(node.children[0]), walk(node.children[1])] };
  };
  return { root: walk(root), newLeafId };
}
function insertSubtreeBeside(
  root: PaneNode,
  targetLeafId: string,
  sub: PaneNode,
  direction: "row" | "column",
  position: "before" | "after",
): PaneNode {
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") {
      if (n.id !== targetLeafId) return n;
      const children: [PaneNode, PaneNode] = position === "before" ? [sub, n] : [n, sub];
      return { kind: "split", id: crypto.randomUUID(), direction, children, ratio: 0.5 };
    }
    return { ...n, children: [walk(n.children[0]), walk(n.children[1])] };
  };
  return walk(root);
}
function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.kind === "leaf") return root.id === leafId ? null : root;
  const a = removeLeaf(root.children[0], leafId);
  const b = removeLeaf(root.children[1], leafId);
  if (!a && !b) return null;
  if (!a) return b!;
  if (!b) return a!;
  return { ...root, children: [a, b] };
}
function updateRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId) return { ...root, ratio };
  return { ...root, children: [updateRatio(root.children[0], splitId, ratio), updateRatio(root.children[1], splitId, ratio)] };
}

// Compute each leaf's virtual rect [x,y,w,h] in the unit square for navigation.
function leafRects(node: PaneNode, rect: [number, number, number, number]): Array<{ id: string; rect: [number, number, number, number] }> {
  const [x, y, w, h] = rect;
  if (node.kind === "leaf") return [{ id: node.id, rect: [x, y, w, h] }];
  const { direction, children, ratio } = node;
  if (direction === "row") {
    return [
      ...leafRects(children[0], [x, y, w * ratio, h]),
      ...leafRects(children[1], [x + w * ratio, y, w * (1 - ratio), h]),
    ];
  } else {
    return [
      ...leafRects(children[0], [x, y, w, h * ratio]),
      ...leafRects(children[1], [x, y + h * ratio, w, h * (1 - ratio)]),
    ];
  }
}

function findAdjacentPane(root: PaneNode, activeId: string, dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null {
  const rects = leafRects(root, [0, 0, 1, 1]);
  const active = rects.find((r) => r.id === activeId);
  if (!active) return null;
  const [ax, ay, aw, ah] = active.rect;
  const acx = ax + aw / 2, acy = ay + ah / 2;
  let best: { id: string; score: number } | null = null;
  for (const c of rects) {
    if (c.id === activeId) continue;
    const [cx, cy, cw, ch] = c.rect;
    const ccx = cx + cw / 2, ccy = cy + ch / 2;
    let ok = false, score = 0;
    const EPS = 1e-6;
    if (dir === "ArrowRight") { ok = cx >= ax + aw - EPS; score = (cx - (ax + aw)) + Math.abs(ccy - acy) * 0.5; }
    else if (dir === "ArrowLeft") { ok = cx + cw <= ax + EPS; score = (ax - (cx + cw)) + Math.abs(ccy - acy) * 0.5; }
    else if (dir === "ArrowDown") { ok = cy >= ay + ah - EPS; score = (cy - (ay + ah)) + Math.abs(ccx - acx) * 0.5; }
    else if (dir === "ArrowUp") { ok = cy + ch <= ay + EPS; score = (ay - (cy + ch)) + Math.abs(ccx - acx) * 0.5; }
    if (!ok) continue;
    if (best === null || score < best.score) best = { id: c.id, score };
  }
  return best?.id ?? null;
}
function migrateTab(raw: any): Tab {
  const userTitle = typeof raw?.userTitle === "string" && raw.userTitle.trim() ? raw.userTitle.trim() : undefined;
  if (raw && raw.root) return { ...(raw as Tab), userTitle };
  // Old flat shape → single-leaf tree.
  const paneId = crypto.randomUUID();
  const leaf: PaneLeaf = {
    kind: "leaf",
    id: paneId,
    agentId: raw?.agentId ?? "__shell__",
    cwd: raw?.cwd ?? "",
    resumeId: raw?.resumeId,
    continueLatest: raw?.continueLatest,
    epoch: raw?.epoch ?? 0,
  };
  return { id: raw?.id ?? crypto.randomUUID(), root: leaf, activePaneId: paneId, userTitle };
}
type SessionSummary = { id: string; agentId: string; title: string; modifiedMs: number; messageCount: number; hasRecap?: boolean };
type PreviewMessage = { role: string; kind: "text" | "system" | "recap"; label?: string; text: string };
type SessionDetail = { id: string; agentId: string; title: string; modifiedMs: number; messages: PreviewMessage[] };
type Orientation = "horizontal" | "vertical";
type PickerState = { open: boolean; forTabId?: string };
type SettingsSection = "appearance" | "shortcuts" | "profiles";

type ClaudeProfileDto = {
  id: string;
  name: string;
  color: string;
  folders: string[];
  createdMs: number;
  configDir: string;
  signedInEmail: string | null;
};

const PROFILE_COLORS = ["#7fd6b5", "#8aa8ff", "#f08a9a", "#f5b14a", "#a88af0", "#7ad3e3"];
const DEFAULT_PROFILE_COLOR = PROFILE_COLORS[0];

/** Longest-prefix folder match, mirroring backend `resolve_profile_for_path`. */
function resolveProfileForCwd(profiles: ClaudeProfileDto[], cwd: string): ClaudeProfileDto | null {
  if (!cwd) return null;
  const norm = cwd.replace(/\/+$/, "");
  let best: { profile: ClaudeProfileDto; depth: number } | null = null;
  for (const p of profiles) {
    for (const folder of p.folders) {
      const f = folder.replace(/\/+$/, "");
      if (norm === f || norm.startsWith(f + "/")) {
        const depth = f.split("/").length;
        if (!best || depth > best.depth) best = { profile: p, depth };
      }
    }
  }
  return best?.profile ?? null;
}

const darkTheme: ITheme = { background: "#0b0b0f", foreground: "#e6e6e6", cursor: "#e6e6e6" };
// Solarized Light: easy on the eyes
const lightTheme: ITheme = {
  background: "#fdf6e3",
  foreground: "#586e75",
  cursor: "#586e75",
  black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
  blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
  brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
  brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
};

const AGENT_COLORS: Record<string, string> = {
  claude: "#ff8a4c",
  codex: "#10a37f",
  cursor: "#6a8dff",
  copilot: "#7c5bf6",
  aider: "#ffc857",
  __shell__: "#8a8aa0",
};

const RECENTS_KEY = "vector.recents";
const TABS_KEY = "vector.openTabs";
const MAX_RECENTS = 8;

function loadSavedTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(migrateTab);
  } catch { return []; }
}
function saveTabs(tabs: Tab[]) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch {}
}

function loadPref<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch { return []; }
}
function saveRecents(list: string[]) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS))); } catch {}
}
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "Symbols Nerd Font Mono", ui-monospace, "SF Mono", Menlo, "Apple Symbols", "Apple Color Emoji", "Segoe UI Symbol", monospace';
const DEFAULT_FONT_SIZE = 13;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? "#8a8aa0";
}

function AgentIcon({ id, size = 14 }: { id: string; size?: number }) {
  const color = agentColor(id);
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true as const };
  switch (id) {
    case "claude":
      // sparkle / 4-point star (Anthropic-ish)
      return (
        <svg {...common}><path d="M12 2 L13.8 10.2 L22 12 L13.8 13.8 L12 22 L10.2 13.8 L2 12 L10.2 10.2 Z" fill={color} /></svg>
      );
    case "codex":
      // hexagon rosette (OpenAI-ish)
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
          <path d="M12 7 L17 10 L17 14 L12 17 L7 14 L7 10 Z" />
        </svg>
      );
    case "cursor":
      // arrow cursor
      return (
        <svg {...common} fill={color}><path d="M5 3 L19 13 L12 13.5 L14.5 20 L12 21 L9 14.5 L4 17 Z" /></svg>
      );
    case "copilot":
      // infinity mark
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M7 12 C7 8.5 9 7 11 9 L13 15 C15 17 17 15.5 17 12 C17 8.5 15 7 13 9 L11 15 C9 17 7 15.5 7 12 Z" />
        </svg>
      );
    case "aider":
      // stylized A
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20 L12 4 L20 20" />
          <path d="M7 14 L17 14" />
        </svg>
      );
    case "__shell__":
      // terminal prompt ">_"
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7 L10 12 L5 17" />
          <path d="M13 18 L19 18" />
        </svg>
      );
    default:
      // fallback: filled circle with first letter
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill={color} />
          <text x="12" y="16" textAnchor="middle" fontSize="13" fontWeight="700" fill="#0b0b0f" fontFamily="ui-monospace, Menlo, monospace">
            {(id[0] ?? "?").toUpperCase()}
          </text>
        </svg>
      );
  }
}

async function ensureNotifPermission() {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  } catch { return false; }
}

export default function App() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<string>("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [fontFamily, setFontFamily] = useState<string>(() => {
    try {
      const raw = localStorage.getItem("vector.fontFamily");
      return raw && raw.length > 0 ? raw : DEFAULT_FONT_FAMILY;
    } catch { return DEFAULT_FONT_FAMILY; }
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("vector.fontSize");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 8 && n <= 40 ? n : DEFAULT_FONT_SIZE;
    } catch { return DEFAULT_FONT_SIZE; }
  });
  const [themeName, setThemeName] = useState<"dark" | "light" | "custom">(() => {
    try {
      const t = localStorage.getItem("vector.themeName");
      if (t === "dark" || t === "light" || t === "custom") return t;
      // Back-compat: migrate from the older "vector.theme" key
      const legacy = localStorage.getItem("vector.theme");
      return legacy === "light" ? "light" : "dark";
    } catch { return "dark"; }
  });
  const [customTheme, setCustomTheme] = useState<ITheme | null>(() => {
    try {
      const raw = localStorage.getItem("vector.themeCustom");
      return raw ? (JSON.parse(raw) as ITheme) : null;
    } catch { return null; }
  });
  const [transparency, setTransparency] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("vector.transparency");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
    } catch { return 0; }
  });
  const [orientation, setOrientation] = useState<Orientation>(() => loadPref<Orientation>("vector.orientation", "horizontal"));
  const [bellTabs, setBellTabs] = useState<Set<string>>(new Set());
  // Key is paneId, not tabId. The tab header reads the active pane's entry.
  const [paneTitles, setPaneTitles] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [picker, setPicker] = useState<PickerState>({ open: true });
  const tabsLoaded = useRef(false);
  const activeIdRef = useRef("");
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const dragFromRef = useRef<number | null>(null);
  type DndPayload = { kind: "pane"; fromTabId: string; paneId: string } | { kind: "tab"; tabId: string };
  const dndRef = useRef<DndPayload | null>(null);
  const getDnd = useCallback(() => dndRef.current, []);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [paneRenameDraft, setPaneRenameDraft] = useState("");
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null);
  const [claudeProfiles, setClaudeProfiles] = useState<ClaudeProfileDto[]>([]);
  const reloadClaudeProfiles = useCallback(async () => {
    try {
      const list = await invoke<ClaudeProfileDto[]>("list_claude_profiles");
      setClaudeProfiles(list);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { reloadClaudeProfiles(); }, [reloadClaudeProfiles]);
  type UsageBucket = { utilization: number; resetsAt?: string | null };
  type ClaudeUsage = { fiveHour?: UsageBucket | null; sevenDay?: UsageBucket | null; sevenDaySonnet?: UsageBucket | null; sevenDayOpus?: UsageBucket | null };
  // Usage is scoped per Claude profile — each profile has its own OAuth token
  // and its own 5-hour / 7-day buckets. Key is the profile id, or "__default__"
  // for the top-level ~/.claude login.
  const [usageByProfile, setUsageByProfile] = useState<Record<string, ClaudeUsage>>({});
  const [usageOpen, setUsageOpen] = useState(false);
  const leafStartedMs = useRef<Record<string, number>>({});
  const markLeafStarted = useCallback((leafId: string, epoch: number) => {
    leafStartedMs.current[`${leafId}:${epoch}`] = Date.now();
  }, []);

  const renameTab = useCallback((tabId: string, nextTitle: string | undefined) => {
    const trimmed = nextTitle?.trim();
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, userTitle: trimmed && trimmed.length > 0 ? trimmed : undefined } : t)));
  }, []);
  const startRename = useCallback((tab: Tab) => {
    setRenamingTabId(tab.id);
    setRenameDraft(tab.userTitle ?? "");
  }, []);
  const commitRename = useCallback(() => {
    if (!renamingTabId) return;
    renameTab(renamingTabId, renameDraft);
    setRenamingTabId(null);
    setRenameDraft("");
  }, [renamingTabId, renameDraft, renameTab]);
  const cancelRename = useCallback(() => { setRenamingTabId(null); setRenameDraft(""); }, []);
  const commitPaneRename = useCallback(() => {
    const pid = renamingPaneId;
    if (!pid) return;
    const next = paneRenameDraft.trim();
    setTabs((prev) => prev.map((t) => ({
      ...t,
      root: mapLeaf(t.root, pid, (leaf) => ({ ...leaf, userTitle: next.length > 0 ? next : undefined })),
    })));
    setRenamingPaneId(null);
    setPaneRenameDraft("");
  }, [renamingPaneId, paneRenameDraft]);

  const movePaneToNewTab = useCallback((fromTabId: string, paneId: string) => {
    setTabs((prev) => {
      const src = prev.find((t) => t.id === fromTabId);
      if (!src) return prev;
      // Sole pane of a tab → no-op (would just be renaming the tab).
      if (src.root.kind === "leaf" && src.root.id === paneId) return prev;
      const leaf = findLeaf(src.root, paneId);
      if (!leaf) return prev;
      const newRoot = removeLeaf(src.root, paneId);
      if (!newRoot) return prev;
      const newTab: Tab = { id: crypto.randomUUID(), root: { ...leaf }, activePaneId: leaf.id };
      const updated = prev.map((t) => t.id === fromTabId
        ? { ...t, root: newRoot, activePaneId: findLeaf(newRoot, t.activePaneId) ? t.activePaneId : firstLeafId(newRoot) }
        : t);
      setActiveId(newTab.id);
      return [...updated, newTab];
    });
  }, []);

  const movePaneIntoPane = useCallback((fromTabId: string, paneId: string, toTabId: string, targetPaneId: string, edge: "left" | "right" | "top" | "bottom") => {
    if (paneId === targetPaneId) return;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === fromTabId);
      if (!src) return prev;
      const leaf = findLeaf(src.root, paneId);
      if (!leaf) return prev;
      const dir: "row" | "column" = edge === "left" || edge === "right" ? "row" : "column";
      const pos: "before" | "after" = edge === "left" || edge === "top" ? "before" : "after";
      if (fromTabId === toTabId) {
        return prev.map((t) => {
          if (t.id !== fromTabId) return t;
          const r1 = removeLeaf(t.root, paneId);
          if (!r1) return t;
          const r2 = insertSubtreeBeside(r1, targetPaneId, leaf, dir, pos);
          return { ...t, root: r2, activePaneId: leaf.id };
        });
      }
      const updated: Tab[] = [];
      for (const t of prev) {
        if (t.id === fromTabId) {
          const r = removeLeaf(t.root, paneId);
          if (!r) continue; // drop empty source tab
          updated.push({ ...t, root: r, activePaneId: findLeaf(r, t.activePaneId) ? t.activePaneId : firstLeafId(r) });
        } else if (t.id === toTabId) {
          updated.push({ ...t, root: insertSubtreeBeside(t.root, targetPaneId, leaf, dir, pos), activePaneId: leaf.id });
        } else {
          updated.push(t);
        }
      }
      setActiveId(toTabId);
      return updated;
    });
  }, []);

  const moveTabIntoPane = useCallback((fromTabId: string, toTabId: string, targetPaneId: string, edge: "left" | "right" | "top" | "bottom") => {
    if (fromTabId === toTabId) return;
    setTabs((prev) => {
      const src = prev.find((t) => t.id === fromTabId);
      if (!src) return prev;
      const dir: "row" | "column" = edge === "left" || edge === "right" ? "row" : "column";
      const pos: "before" | "after" = edge === "left" || edge === "top" ? "before" : "after";
      const activePaneAfter = src.activePaneId;
      const updated = prev
        .filter((t) => t.id !== fromTabId)
        .map((t) => t.id === toTabId
          ? { ...t, root: insertSubtreeBeside(t.root, targetPaneId, src.root, dir, pos), activePaneId: activePaneAfter }
          : t);
      setActiveId(toTabId);
      return updated;
    });
  }, []);

  const onPaneDrop = useCallback((toTabId: string, targetPaneId: string, edge: "left" | "right" | "top" | "bottom") => {
    const dnd = dndRef.current;
    dndRef.current = null;
    if (!dnd) return;
    if (dnd.kind === "pane") movePaneIntoPane(dnd.fromTabId, dnd.paneId, toTabId, targetPaneId, edge);
    else moveTabIntoPane(dnd.tabId, toTabId, targetPaneId, edge);
  }, [movePaneIntoPane, moveTabIntoPane]);

  const moveTab = useCallback((from: number, to: number) => {
    if (from === to) return;
    setTabs((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to > prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    // Avoid wiping the persisted list before the initial restore runs.
    if (!tabsLoaded.current) return;
    saveTabs(tabs);
  }, [tabs]);
  const [recents, setRecents] = useState<string[]>([]);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "downloading" | "ready" | "error">("idle");
  const [showNotes, setShowNotes] = useState(false);
  const [aggregateNotes, setAggregateNotes] = useState<{ markdown: string; versions: number } | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<null | "checking" | "uptodate" | "error">(null);
  const notifReady = useRef(false);

  useEffect(() => {
    document.body.className = themeName === "light" ? "theme-light" : "theme-dark";
  }, [themeName]);
  useEffect(() => { try { localStorage.setItem("vector.fontFamily", fontFamily); } catch {} }, [fontFamily]);
  useEffect(() => { try { localStorage.setItem("vector.fontSize", String(fontSize)); } catch {} }, [fontSize]);
  useEffect(() => { try { localStorage.setItem("vector.themeName", themeName); } catch {} }, [themeName]);
  useEffect(() => {
    try {
      if (customTheme) localStorage.setItem("vector.themeCustom", JSON.stringify(customTheme));
      else localStorage.removeItem("vector.themeCustom");
    } catch {}
  }, [customTheme]);
  useEffect(() => { try { localStorage.setItem("vector.transparency", String(transparency)); } catch {} }, [transparency]);
  useEffect(() => {
    document.documentElement.style.setProperty("--window-alpha", String(1 - transparency));
  }, [transparency]);
  useEffect(() => { try { localStorage.setItem("vector.orientation", orientation); } catch {} }, [orientation]);

  useEffect(() => {
    (async () => {
      const [list, def] = await Promise.all([
        invoke<AgentMeta[]>("list_agents"),
        invoke<string>("default_agent"),
      ]);
      setAgents(list);
      const defAvailable = list.some((a) => a.id === def && a.available);
      const firstInstalled = list.find((a) => a.available)?.id;
      setDefaultAgent(defAvailable ? def : (firstInstalled ?? "__shell__"));
      setRecents(loadRecents());
      notifReady.current = await ensureNotifPermission();
      // Background update check — don't block startup.
      checkUpdate().then((u) => { if (u) setUpdate(u); }).catch(() => {});
      // Restore previously-open tabs. If a user explicitly picked a session,
      // keep that resumeId; otherwise mark the tab to resume the most-recent
      // conversation for its project (claude --continue).
      const saved = loadSavedTabs();
      if (saved.length > 0) {
        const restored: Tab[] = saved.map((raw) => {
          const t = migrateTab(raw);
          return {
            ...t,
            root: mapAllLeaves(t.root, (leaf) => ({
              ...leaf,
              epoch: (leaf.epoch ?? 0) + 1,
              continueLatest: leaf.resumeId ? leaf.continueLatest : true,
            })),
          };
        });
        setTabs(restored);
        setActiveId(restored[0].id);
        setPicker({ open: false });
      }
      tabsLoaded.current = true;
    })();
  }, []);

  const pushRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENTS);
      saveRecents(next);
      return next;
    });
  }, []);

  const openPickerForNewTab = useCallback(() => setPicker({ open: true }), []);
  const openPickerForTab = useCallback((tabId: string) => setPicker({ open: true, forTabId: tabId }), []);
  const closePicker = useCallback(() => {
    setPicker((p) => ({ ...p, open: false }));
  }, []);

  const applyPick = useCallback((path: string, agentId: string, resumeId?: string) => {
    pushRecent(path);
    setPicker((p) => {
      if (p.forTabId) {
        const id = p.forTabId;
        setTabs((prev) => prev.map((t) => {
          if (t.id !== id) return t;
          return { ...t, root: mapLeaf(t.root, t.activePaneId, (leaf) => ({
            ...leaf, cwd: path, agentId, resumeId, continueLatest: false, epoch: leaf.epoch + 1,
          })) };
        }));
      } else {
        const paneId = crypto.randomUUID();
        const t: Tab = {
          id: crypto.randomUUID(),
          root: { kind: "leaf", id: paneId, agentId, cwd: path, resumeId, epoch: 0 },
          activePaneId: paneId,
        };
        setTabs((prev) => [...prev, t]);
        setActiveId(t.id);
      }
      return { open: false };
    });
  }, [pushRecent]);

  const closeTab = useCallback((id: string) => {
    let closedLeafIds: string[] = [];
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const closedTab = prev.find((t) => t.id === id);
      if (closedTab) closedLeafIds = allLeafIds(closedTab.root);
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) {
        setPicker({ open: true });
      } else if (id === activeIdRef.current) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveId(neighbor.id);
      }
      return next;
    });
    setBellTabs((b) => { const n = new Set(b); n.delete(id); return n; });
    // Drop pane titles for every leaf in the closed tab.
    if (closedLeafIds.length) {
      setPaneTitles((m) => {
        let changed = false;
        const next = { ...m };
        for (const pid of closedLeafIds) if (pid in next) { delete next[pid]; changed = true; }
        return changed ? next : m;
      });
    }
  }, []);

  // Close a single pane. If the tab has no panes left, close the tab.
  const closePane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return prev;
      const newRoot = removeLeaf(tab.root, paneId);
      if (!newRoot) {
        // last pane closed → close the whole tab (and let closeTab-equivalent logic run)
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (!next.length) setPicker({ open: true });
        else if (tabId === activeIdRef.current) {
          const neighbor = next[Math.min(idx, next.length - 1)];
          setActiveId(neighbor.id);
        }
        return next;
      }
      const newActive = tab.activePaneId === paneId ? firstLeafId(newRoot) : tab.activePaneId;
      return prev.map((t) => t.id === tabId ? { ...t, root: newRoot, activePaneId: newActive } : t);
    });
    setPaneTitles((m) => {
      if (!(paneId in m)) return m;
      const next = { ...m };
      delete next[paneId];
      return next;
    });
  }, []);

  const splitActivePane = useCallback((direction: "row" | "column") => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === activeIdRef.current);
      if (!tab) return prev;
      const activeLeaf = findLeaf(tab.root, tab.activePaneId);
      const agentId = activeLeaf?.agentId ?? defaultAgent;
      const { root: newRoot, newLeafId } = splitLeaf(tab.root, tab.activePaneId, direction, agentId);
      return prev.map((t) => t.id === tab.id ? { ...t, root: newRoot, activePaneId: newLeafId } : t);
    });
  }, [defaultAgent]);

  const setActivePane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, activePaneId: paneId } : t));
  }, []);

  /** Set the Claude profile override on the active pane of `tabId`, then restart it
   *  (epoch bump) so the new CLAUDE_CONFIG_DIR takes effect. */
  const setPaneProfileOverride = useCallback((tabId: string, override: string | null | undefined) => {
    setTabs((prev) => prev.map((t) => t.id === tabId
      ? { ...t, root: mapLeaf(t.root, t.activePaneId, (leaf) => ({ ...leaf, profileOverride: override, epoch: leaf.epoch + 1 })) }
      : t));
  }, []);

  const setSplitRatio = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, root: updateRatio(t.root, splitId, ratio) } : t));
  }, []);

  const reloadActive = useCallback(() => {
    setTabs((prev) => prev.map((t) => t.id === activeId
      ? { ...t, root: mapLeaf(t.root, t.activePaneId, (leaf) => ({ ...leaf, epoch: leaf.epoch + 1 })) }
      : t));
  }, [activeId]);

  const changeActiveAgent = useCallback((agentId: string) => {
    setTabs((prev) => prev.map((t) => t.id === activeId
      ? { ...t, root: mapLeaf(t.root, t.activePaneId, (leaf) => ({ ...leaf, agentId, resumeId: undefined, continueLatest: false, epoch: leaf.epoch + 1 })) }
      : t));
  }, [activeId]);

  const onTitle = useCallback((_tabId: string, paneId: string, title: string) => {
    setPaneTitles((m) => (m[paneId] === title ? m : { ...m, [paneId]: title }));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setBellTabs((b) => { if (!b.has(activeId)) return b; const n = new Set(b); n.delete(activeId); return n; });
  }, [activeId]);

  useEffect(() => {
    const clearActive = () => {
      const id = activeIdRef.current;
      if (!id) return;
      setBellTabs((b) => { if (!b.has(id)) return b; const n = new Set(b); n.delete(id); return n; });
    };
    window.addEventListener("focus", clearActive);
    const onVis = () => { if (document.visibilityState === "visible") clearActive(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", clearActive);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    invoke("set_badge_count", { count: bellTabs.size }).catch(() => {});
  }, [bellTabs]);

  const onBell = useCallback((tabId: string, paneId: string) => {
    const windowFocused = document.hasFocus();
    const isActive = tabId === activeId;
    if (!windowFocused || !isActive) {
      setBellTabs((b) => { const n = new Set(b); n.add(tabId); return n; });
      const tab = tabs.find((t) => t.id === tabId);
      const leaf = tab ? findLeaf(tab.root, paneId) : null;
      const agent = agents.find((a) => a.id === leaf?.agentId);
      const label = agent?.label ?? leaf?.agentId ?? "Agent";
      if (notifReady.current) {
        try { sendNotification({ title: "Vector", body: `${label} needs input` }); } catch {}
      }
    }
  }, [activeId, tabs, agents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs
      if (e.ctrlKey && e.key === "Tab" && tabs.length > 1) {
        e.preventDefault();
        const currentIdx = tabs.findIndex((t) => t.id === activeId);
        const base = currentIdx === -1 ? 0 : currentIdx;
        const delta = e.shiftKey ? -1 : 1;
        const nextIdx = (base + delta + tabs.length) % tabs.length;
        setActiveId(tabs[nextIdx].id);
        return;
      }
      if (!e.metaKey) return;
      if (e.key === "," && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        setSettingsOpen((o) => !o);
        return;
      }
      if (e.key === "k" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setFontSize((s) => clamp(s + 1, 8, 40));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setFontSize((s) => clamp(s - 1, 8, 40));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setFontSize(13);
        return;
      }
      if (e.key === "t" && !e.shiftKey) { e.preventDefault(); openPickerForNewTab(); }
      else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const tab = tabs.find((t) => t.id === activeId);
        if (tab) closePane(tab.id, tab.activePaneId);
      }
      else if ((e.key === "d" || e.key === "D")) {
        e.preventDefault();
        splitActivePane(e.shiftKey ? "column" : "row");
      }
      else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const tab = tabs.find((t) => t.id === activeId);
        if (!tab) return;
        const next = findAdjacentPane(tab.root, tab.activePaneId, e.key);
        if (next) setActivePane(tab.id, next);
      }
      else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (e.shiftKey) reloadActive();
      }
      else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (tabs[idx]) { e.preventDefault(); setActiveId(tabs[idx].id); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [openPickerForNewTab, closePane, splitActivePane, reloadActive, tabs, activeId]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const activeLeaf = activeTab ? findLeaf(activeTab.root, activeTab.activePaneId) : null;
  const xtermTheme: ITheme = useMemo(() => {
    const base = themeName === "custom" && customTheme
      ? customTheme
      : (themeName === "light" ? lightTheme : darkTheme);
    if (transparency <= 0) return base;
    return { ...base, background: "rgba(0,0,0,0)" };
  }, [themeName, customTheme, transparency]);

  const ctxAgentId = activeLeaf?.agentId ?? "";
  // Resolve which Claude profile the active pane is using. Mirrors ProfilePill.
  const ctxProfileKey: string | null = useMemo(() => {
    if (ctxAgentId !== "claude") return null;
    const override = activeLeaf?.profileOverride;
    if (override === null) return "__default__";
    if (typeof override === "string") {
      return claudeProfiles.some((p) => p.id === override) ? override : "__default__";
    }
    const resolved = resolveProfileForCwd(claudeProfiles, activeLeaf?.cwd ?? "");
    return resolved?.id ?? "__default__";
  }, [ctxAgentId, activeLeaf?.profileOverride, activeLeaf?.cwd, claudeProfiles]);
  useEffect(() => {
    if (!ctxProfileKey) return;
    let cancelled = false;
    let intervalId: number | null = null;
    let retryId: number | null = null;
    let retryDelay = 15_000;   // first cold-start retry after 15s
    const MAX_RETRY = 120_000; // cap at 2min between retries
    let haveData = false;

    const tick = () => {
      invoke<ClaudeUsage | null>("get_claude_usage", { profileId: ctxProfileKey })
        .then((u) => {
          if (cancelled) return;
          if (u) {
            setUsageByProfile((prev) => ({ ...prev, [ctxProfileKey]: u }));
            haveData = true;
            retryDelay = 15_000;
            // First success → switch from backoff to steady 5-min cadence.
            if (intervalId == null) {
              intervalId = window.setInterval(tick, 300_000);
            }
          } else if (!haveData) {
            // Still no data — keep retrying with backoff until we get some.
            retryId = window.setTimeout(tick, retryDelay);
            retryDelay = Math.min(MAX_RETRY, retryDelay * 2);
          }
          // If we have data and this tick failed, keep cached value silently.
        })
        .catch(() => {
          if (cancelled || haveData) return;
          retryId = window.setTimeout(tick, retryDelay);
          retryDelay = Math.min(MAX_RETRY, retryDelay * 2);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (intervalId != null) window.clearInterval(intervalId);
      if (retryId != null) window.clearTimeout(retryId);
    };
  }, [ctxProfileKey]);
  const claudeUsage = ctxProfileKey ? (usageByProfile[ctxProfileKey] ?? null) : null;
  const fiveHour = claudeUsage?.fiveHour ?? null;
  const ctxPct = fiveHour ? Math.round(Math.min(100, Math.max(0, fiveHour.utilization))) : 0;
  const ctxLevel = ctxPct >= 85 ? "crit" : ctxPct >= 60 ? "warn" : "ok";
  const formatResetTime = (iso?: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (sameDay) return hm;
    const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${md} ${hm}`;
  };
  const ctxResetText = formatResetTime(fiveHour?.resetsAt);

  const computeTabDropIndex = (container: HTMLElement, clientX: number): number => {
    const tabEls = Array.from(container.querySelectorAll<HTMLElement>(".tabs > .tab"));
    for (let k = 0; k < tabEls.length; k++) {
      const r = tabEls[k].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return k;
    }
    return tabEls.length;
  };
  const tabBar = (
    <div
      className="tabs-container"
      onDragOver={(e) => {
        const d = dndRef.current;
        if (!d) return;
        // Always allow drops in the strip; keeps the cursor as "move" and
        // prevents the webview's default green-"+" / forbidden indicator.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (d.kind === "tab") {
          const idx = computeTabDropIndex(e.currentTarget as HTMLElement, e.clientX);
          if (idx !== tabDropIndex) setTabDropIndex(idx);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the strip (not when it
        // crosses a child boundary).
        const target = e.currentTarget as HTMLElement;
        const related = e.relatedTarget as Node | null;
        if (!related || !target.contains(related)) setTabDropIndex(null);
      }}
      onDrop={(e) => {
        const d = dndRef.current;
        if (!d) return;
        e.preventDefault();
        if (d.kind === "pane") {
          dndRef.current = null;
          setTabDropIndex(null);
          movePaneToNewTab(d.fromTabId, d.paneId);
          return;
        }
        // tab kind
        const from = dragFromRef.current;
        const to = computeTabDropIndex(e.currentTarget as HTMLElement, e.clientX);
        dragFromRef.current = null;
        dndRef.current = null;
        setTabDropIndex(null);
        if (from != null) moveTab(from, to);
      }}
    >
      <div className="tabs">
        {tabs.map((t, i) => {
          const activeLeaf = findLeaf(t.root, t.activePaneId);
          const tabAgentId = activeLeaf?.agentId ?? "__shell__";
          const tabCwd = activeLeaf?.cwd ?? "";
          const agent = agents.find((a) => a.id === tabAgentId);
          const agentLabel = agent?.label ?? (tabAgentId === "__shell__" ? "shell" : tabAgentId);
          const rawTitle = paneTitles[t.activePaneId] || "";
          const stripped = rawTitle
            .replace(new RegExp(`^\\s*${agentLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[–—\\-:·|·]?\\s*`, "i"), "")
            .trim();
          // tab-level rename wins; else active pane's user name; else stripped PTY title; else basename(cwd)
          const title = t.userTitle || activeLeaf?.userTitle || stripped || basename(tabCwd);
          const isRenaming = renamingTabId === t.id;
          const classes = ["tab"];
          if (t.id === activeId) classes.push("active");
          if (bellTabs.has(t.id)) classes.push("bell");
          if (tabDropIndex !== null && dndRef.current?.kind === "tab") {
            if (tabDropIndex === i) classes.push("drop-before");
            if (tabDropIndex === tabs.length && i === tabs.length - 1) classes.push("drop-after");
          }
          return (
            <div
              key={t.id}
              className={classes.join(" ")}
              onClick={() => setActiveId(t.id)}
              title={`⌘${i + 1} · ${agentLabel} · ${tabCwd}`}
              draggable={!isRenaming}
              onDragStart={(e) => {
                dragFromRef.current = i;
                dndRef.current = { kind: "tab", tabId: t.id };
                // Some webviews require dataTransfer data for drop events to fire.
                e.dataTransfer.effectAllowed = "move";
                try { e.dataTransfer.setData("text/plain", String(i)); } catch {}
              }}
              onDragEnd={() => {
                dragFromRef.current = null;
                dndRef.current = null;
                setTabDropIndex(null);
              }}
            >
              <span className="agent-chip"><AgentIcon id={tabAgentId} size={14} /></span>
              {isRenaming ? (
                <input
                  className="tab-rename"
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                  }}
                  onBlur={commitRename}
                  placeholder={stripped || basename(tabCwd) || "Tab name"}
                />
              ) : (
                <span
                  className="tab-label"
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(t); }}
                  title="Double-click to rename"
                >{title}</span>
              )}
              {(() => { const n = allLeafIds(t.root).length; return n > 1 ? <span className="tab-pane-count">{n}</span> : null; })()}
              {tabAgentId === "claude" && (
                <ProfilePill
                  profiles={claudeProfiles}
                  cwd={tabCwd}
                  override={activeLeaf?.profileOverride}
                  onPick={(id) => setPaneProfileOverride(t.id, id)}
                  onManage={() => { setSettingsSection("profiles"); setSettingsOpen(true); }}
                />
              )}
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
            </div>
          );
        })}
        <button
          className="tab-new"
          onClick={openPickerForNewTab}
          title="New tab (⌘T)"
          onDragOver={(e) => {
            if (dndRef.current?.kind !== "pane") return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            const d = dndRef.current;
            if (d?.kind !== "pane") return;
            e.preventDefault();
            dndRef.current = null;
            movePaneToNewTab(d.fromTabId, d.paneId);
          }}
        >+</button>
      </div>
    </div>
  );

  const installUpdate = async () => {
    if (!update) return;
    setUpdateStatus("downloading");
    try {
      await update.downloadAndInstall();
      setUpdateStatus("ready");
      await relaunch();
    } catch {
      setUpdateStatus("error");
    }
  };

  const runUpdateCheck = useCallback(async () => {
    setUpdateCheck("checking");
    try {
      const u = await checkUpdate();
      if (u) {
        setUpdate(u);
        setUpdateCheck(null);
      } else {
        setUpdateCheck("uptodate");
        setTimeout(() => setUpdateCheck((s) => s === "uptodate" ? null : s), 3000);
      }
    } catch {
      setUpdateCheck("error");
      setTimeout(() => setUpdateCheck((s) => s === "error" ? null : s), 3000);
    }
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("menu://check-updates", () => { runUpdateCheck(); })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, [runUpdateCheck]);

  // Fetch GitHub release notes for every version between the currently-installed
  // one and the offered update. Falls back to just the latest release's body if
  // the fetch fails (offline, rate-limited, etc).
  const fetchAggregateNotes = useCallback(async () => {
    if (!update) return;
    const current = await getVersion();
    // Cache by (current → latest) pair so reopening the modal doesn't re-hit
    // the GitHub API every time — 60 req/hr/IP is the unauth limit.
    const cacheKey = `vector.whatsnew.${current}->${update.version}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { setAggregateNotes(JSON.parse(cached)); return; }
    } catch {}
    setNotesLoading(true);
    // Hard timeout so a captive portal / stalled DNS doesn't leave the modal
    // spinning indefinitely.
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch("https://api.github.com/repos/avram19/vector/releases?per_page=50", {
        headers: { Accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const releases: Array<{ tag_name: string; name: string | null; body: string | null }> = await res.json();
      const entries = releases
        .map((r) => ({ version: (r.tag_name || "").replace(/^v/, ""), body: r.body || "" }))
        .filter((r) => r.version && cmpSemver(r.version, current) > 0 && cmpSemver(r.version, update.version) <= 0)
        .sort((a, b) => cmpSemver(b.version, a.version));
      const payload = entries.length === 0
        ? { markdown: update.body || "", versions: 1 }
        : { markdown: entries.map((e) => `## v${e.version}\n\n${e.body.trim()}`).join("\n\n"), versions: entries.length };
      setAggregateNotes(payload);
      try { localStorage.setItem(cacheKey, JSON.stringify(payload)); } catch {}
    } catch {
      setAggregateNotes({ markdown: update?.body || "", versions: 1 });
    } finally {
      window.clearTimeout(timer);
      setNotesLoading(false);
    }
  }, [update]);

  // Load once when the user first opens the modal. Reset whenever `update` changes.
  useEffect(() => { setAggregateNotes(null); }, [update?.version]);
  useEffect(() => {
    if (showNotes && !aggregateNotes && !notesLoading) fetchAggregateNotes();
  }, [showNotes, aggregateNotes, notesLoading, fetchAggregateNotes]);

  return (
    <>
      {update && (
        <div className="update-banner">
          <div className="update-row">
            <span>Vector {update.version} is available.</span>
            {update.body && (
              <button className="update-notes-btn" onClick={() => setShowNotes(true)}>What’s new</button>
            )}
            <div className="spacer" />
            {updateStatus === "idle" && <button className="update-btn" onClick={installUpdate}>Update & restart</button>}
            {updateStatus === "downloading" && <span className="update-status">Downloading…</span>}
            {updateStatus === "ready" && <span className="update-status">Restarting…</span>}
            {updateStatus === "error" && <button className="update-btn" onClick={installUpdate}>Retry</button>}
            <button className="icon-btn" onClick={() => setUpdate(null)} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}
      {showNotes && update && (
        <div className="picker-overlay" onClick={() => setShowNotes(false)}>
          <div className="picker-card whatsnew-card" onClick={(e) => e.stopPropagation()}>
            <div className="picker-head">
              <div className="picker-brand">
                <VectorMark size={14} />
                {aggregateNotes && aggregateNotes.versions > 1
                  ? <>What’s new · {aggregateNotes.versions} releases</>
                  : <>What’s new in {update.version}</>}
              </div>
              <button className="icon-btn" onClick={() => setShowNotes(false)} aria-label="Close">×</button>
            </div>
            <div className="whatsnew-body">
              {notesLoading && !aggregateNotes
                ? <div style={{ color: "var(--muted)", fontSize: 12 }}>Loading release notes…</div>
                : renderMarkdown(aggregateNotes?.markdown || update.body || "")}
            </div>
          </div>
        </div>
      )}
      {usageOpen && (
        <div className="picker-overlay" onClick={() => setUsageOpen(false)}>
          <div className="picker-card usage-card" onClick={(e) => e.stopPropagation()}>
            <div className="picker-head">
              <div className="picker-brand">
                <VectorMark size={14} /> Claude usage
                {(() => {
                  if (!ctxProfileKey) return null;
                  const p = ctxProfileKey === "__default__" ? null : claudeProfiles.find((q) => q.id === ctxProfileKey);
                  const name = p?.name ?? "default";
                  return <span className="usage-profile-tag" style={p ? { background: p.color } : undefined}>{name}</span>;
                })()}
              </div>
              <div className="usage-head-actions">
                <button
                  className="icon-btn"
                  onClick={() => {
                    if (!ctxProfileKey) return;
                    const key = ctxProfileKey;
                    invoke<ClaudeUsage | null>("get_claude_usage", { profileId: key })
                      .then((u) => { if (u) setUsageByProfile((prev) => ({ ...prev, [key]: u })); })
                      .catch(() => {});
                  }}
                  aria-label="Refresh"
                  title="Refresh"
                >↻</button>
                <button className="icon-btn" onClick={() => setUsageOpen(false)} aria-label="Close">×</button>
              </div>
            </div>
            <div className="usage-body">
              {[
                { label: "Current session", bucket: claudeUsage?.fiveHour },
                { label: "Current week (all models)", bucket: claudeUsage?.sevenDay },
                { label: "Current week (Sonnet only)", bucket: claudeUsage?.sevenDaySonnet },
                { label: "Current week (Opus only)", bucket: claudeUsage?.sevenDayOpus },
              ].map(({ label, bucket }) =>
                bucket ? (
                  <div key={label} className="usage-row">
                    <div className="usage-row-head">
                      <span className="usage-row-label">{label}</span>
                      <span className="usage-row-num">{Math.round(bucket.utilization)}% used</span>
                    </div>
                    <div className={`usage-bar ctx-${bucket.utilization >= 85 ? "crit" : bucket.utilization >= 60 ? "warn" : "ok"}`}>
                      <div className="usage-fill" style={{ width: `${Math.min(100, Math.max(0, bucket.utilization))}%` }} />
                    </div>
                    <div className="usage-row-reset">
                      {bucket.resetsAt ? `Resets ${formatResetTime(bucket.resetsAt)}` : "No reset scheduled"}
                    </div>
                  </div>
                ) : null
              )}
              {!claudeUsage && <div className="session-muted">Loading usage…</div>}
            </div>
          </div>
        </div>
      )}
      {updateCheck && !update && (
        <div className="update-toast" role="status">
          {updateCheck === "checking" && "Checking for updates…"}
          {updateCheck === "uptodate" && "You're on the latest version."}
          {updateCheck === "error" && "Update check failed. Try again later."}
        </div>
      )}
      <div className="topbar">
        {activeTab && activeLeaf ? (
          <button className="project-btn" onClick={() => openPickerForTab(activeTab.id)} title={activeLeaf.cwd}>
            <VectorMark size={14} /> {basename(activeLeaf.cwd)}
          </button>
        ) : <div style={{ flex: "0 0 auto" }} />}
        <select
          value={activeLeaf?.agentId ?? ""}
          onChange={(e) => changeActiveAgent(e.target.value)}
          disabled={!activeLeaf}
        >
          {agents.filter((a) => a.available).map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
          <option value="__shell__">shell</option>
        </select>
        <button className="icon-btn" onClick={reloadActive} title="Reload agent (⌘⇧R)" disabled={!activeTab}>↻</button>
        <div className="spacer" />
        {fiveHour && (
          <button
            className={`ctx-meter ctx-${ctxLevel}`}
            onClick={() => setUsageOpen(true)}
            aria-label="Claude usage"
          >
            <span className="ctx-label">Session</span>
            <div className="ctx-bar"><div className="ctx-fill" style={{ width: `${ctxPct}%` }} /></div>
            <span className="ctx-num">{ctxPct}%</span>
            {ctxResetText && <span className="ctx-reset">· resets {ctxResetText}</span>}
          </button>
        )}
        <div className="settings">
          <button className="icon-btn" onClick={() => { setSettingsSection("appearance"); setSettingsOpen(true); }} title="Settings (⌘,)" aria-label="Settings">
            <GearIcon />
          </button>
        </div>
      </div>
      {fiveHour && ctxPct >= 60 && (
        <div className={`ctx-banner${ctxLevel === "crit" ? " crit" : ""}`}>
          <span>
            {ctxLevel === "crit"
              ? `5h session limit nearly full (${ctxPct}% used)${ctxResetText ? ` — resets ${ctxResetText}` : ""}.`
              : `Approaching 5h session limit (${ctxPct}% used)${ctxResetText ? ` — resets ${ctxResetText}` : ""}.`}
          </span>
        </div>
      )}
      <div className={`shell ${orientation}`}>
        {tabs.length > 0 && tabBar}
        <div className="terms">
          {tabs.map((t) => (
            <div key={t.id} className="tab-panes" style={{ display: t.id === activeId ? "flex" : "none" }}>
              <PaneView
                tabId={t.id}
                root={t.root}
                activePaneId={t.activePaneId}
                tabVisible={t.id === activeId}
                theme={xtermTheme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onFocusPane={(pid) => setActivePane(t.id, pid)}
                onBell={onBell}
                onTitle={onTitle}
                onExitPane={(pid) => closePane(t.id, pid)}
                onResize={(sid, ratio) => setSplitRatio(t.id, sid, ratio)}
                onPaneDragStart={(pid) => { dndRef.current = { kind: "pane", fromTabId: t.id, paneId: pid }; }}
                onPaneDragEnd={() => { dndRef.current = null; }}
                onPaneDrop={(targetPid, edge) => onPaneDrop(t.id, targetPid, edge)}
                getDndKind={() => dndRef.current?.kind ?? null}
                getDndPaneId={() => dndRef.current?.kind === "pane" ? dndRef.current.paneId : null}
                onSessionStart={markLeafStarted}
                paneTitles={paneTitles}
                renamingPaneId={renamingPaneId}
                paneRenameDraft={paneRenameDraft}
                onStartPaneRename={(pid, initial) => { setRenamingPaneId(pid); setPaneRenameDraft(initial); }}
                onPaneRenameDraft={setPaneRenameDraft}
                onCommitPaneRename={commitPaneRename}
                onCancelPaneRename={() => { setRenamingPaneId(null); setPaneRenameDraft(""); }}
                onClosePane={(pid) => closePane(t.id, pid)}
              />
            </div>
          ))}
          {!tabs.length && !picker.open && <div className="empty">No tabs. ⌘T to open one.</div>}
        </div>
      </div>
      {picker.open && (
        <PickerModal
          recents={recents}
          agents={agents}
          defaultAgent={defaultAgent}
          onPick={applyPick}
          onRemoveRecent={(p) => { const next = recents.filter((r) => r !== p); setRecents(next); saveRecents(next); }}
          onClose={tabs.length > 0 ? closePicker : undefined}
          headerTitle={picker.forTabId ? "Change project for this tab" : "Open a project"}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          section={settingsSection}
          onSection={setSettingsSection}
          themeName={themeName}
          onThemeName={setThemeName}
          fontFamily={fontFamily}
          onFontFamily={setFontFamily}
          fontSize={fontSize}
          onFontSize={setFontSize}
          customTheme={customTheme}
          onCustomTheme={setCustomTheme}
          transparency={transparency}
          onTransparency={setTransparency}
          orientation={orientation}
          onOrientation={setOrientation}
          profiles={claudeProfiles}
          onProfilesChanged={reloadClaudeProfiles}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {switcherOpen && (
        <AgentSwitcher
          agents={agents}
          onPick={(id) => changeActiveAgent(id)}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </>
  );
}

function KeyboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2a2 2 0 0 0-1 3.7 2 2 0 0 1-1.6 3.3H12z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor"/>
      <circle cx="12" cy="7" r="1" fill="currentColor"/>
      <circle cx="16.5" cy="10.5" r="1" fill="currentColor"/>
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** Individual key cap. `k` is either a modifier name ("cmd"/"shift"/"opt"/"ctrl"),
 *  an arrow name ("up"/"down"/"left"/"right"), or literal text. */
function Keycap({ k }: { k: string }) {
  const icon = modIcon(k);
  return <span className="kbd" aria-label={k}>{icon ?? k}</span>;
}

function modIcon(k: string): React.ReactNode | null {
  const sz = 11;
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (k) {
    case "cmd": return (
      <svg width={sz} height={sz} viewBox="0 0 16 16" aria-hidden {...stroke}>
        <path d="M6 4h4v8H6z" />
        <circle cx="4" cy="4" r="2" />
        <circle cx="12" cy="4" r="2" />
        <circle cx="4" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    );
    case "shift": return (
      <svg width={sz} height={sz} viewBox="0 0 16 16" aria-hidden {...stroke}>
        <path d="M8 2 L14 8 H11 V14 H5 V8 H2 Z" />
      </svg>
    );
    case "opt": return (
      <svg width={sz} height={sz} viewBox="0 0 16 16" aria-hidden {...stroke}>
        <path d="M2 4h4l5 8h3" />
        <path d="M10 4h4" />
      </svg>
    );
    case "ctrl": return (
      <svg width={sz} height={sz} viewBox="0 0 16 16" aria-hidden {...stroke}>
        <path d="M3 10l5-5 5 5" />
      </svg>
    );
    case "up": return arrowSvg("M8 3 V13 M4 7 L8 3 L12 7");
    case "down": return arrowSvg("M8 3 V13 M4 9 L8 13 L12 9");
    case "left": return arrowSvg("M3 8 H13 M7 4 L3 8 L7 12");
    case "right": return arrowSvg("M3 8 H13 M9 4 L13 8 L9 12");
    case "enter": return (
      <svg width={sz} height={sz} viewBox="0 0 16 16" aria-hidden {...stroke}>
        <path d="M13 4 V9 H4 M7 6 L4 9 L7 12" />
      </svg>
    );
    default: return null;
  }
}
function arrowSvg(d: string) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="shortcut-row">
      <span className="shortcut-keys">
        {keys.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="kbd-plus">+</span>}
            <Keycap k={k} />
          </React.Fragment>
        ))}
      </span>
      <span className="shortcut-label">{label}</span>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.2l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function VectorMark({ size = 24 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="Vector" style={{ display: "block" }} />;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function PickerModal({
  recents,
  agents,
  defaultAgent,
  onPick,
  onRemoveRecent,
  onClose,
  headerTitle,
}: {
  recents: string[];
  agents: AgentMeta[];
  defaultAgent: string;
  onPick: (path: string, agentId: string, resumeId?: string) => void;
  onRemoveRecent: (p: string) => void;
  onClose?: () => void;
  headerTitle: string;
}) {
  const [step, setStep] = useState<"project" | "session">("project");
  const [project, setProject] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>(defaultAgent);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview || !previewBodyRef.current) return;
    // Scroll to the latest message after the DOM paints
    const el = previewBodyRef.current;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [preview]);

  useEffect(() => { setAgentId(defaultAgent); }, [defaultAgent]);

  const installedAgents = agents.filter((a) => a.available);

  const goToSessionStep = (path: string) => {
    setProject(path);
    setStep("session");
    setSelectedId(null);
    setPreview(null);
    setQuery("");
  };

  const browse = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") goToSessionStep(selected);
    } catch {}
  };

  useEffect(() => {
    if (step !== "session" || !project) return;
    const q = query.trim();
    setSessionsLoading(true);
    const cmd = q ? "search_sessions" : "list_sessions";
    const args: Record<string, unknown> = q
      ? { agentId, cwd: project, query: q }
      : { agentId, cwd: project };
    let cancelled = false;
    const t = window.setTimeout(() => {
      invoke<SessionSummary[]>(cmd, args)
        .then((s) => { if (cancelled) return; setSessions(s); setSessionsLoading(false); setSelectedId(s[0]?.id ?? null); })
        .catch(() => { if (cancelled) return; setSessions([]); setSessionsLoading(false); });
    }, q ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [step, project, agentId, query]);

  useEffect(() => {
    if (!selectedId || !project) { setPreview(null); return; }
    setPreviewLoading(true);
    invoke<SessionDetail | null>("get_session", { agentId, cwd: project, sessionId: selectedId })
      .then((d) => { setPreview(d); setPreviewLoading(false); })
      .catch(() => { setPreview(null); setPreviewLoading(false); });
  }, [selectedId, project, agentId]);

  if (step === "project") {
    return (
      <div className="picker-overlay" onClick={onClose}>
        <div className="picker-card" onClick={(e) => e.stopPropagation()}>
          <div className="picker-head">
            <div className="picker-brand"><VectorMark /> <span>Vector</span></div>
            {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>}
          </div>
          <h2>{headerTitle}</h2>
          <p className="picker-sub">Choose the directory the agent should work in.</p>
          <button className="picker-primary" onClick={browse}>Choose folder…</button>
          {recents.length > 0 && (
            <>
              <div className="picker-section">Recent</div>
              <ul className="picker-list">
                {recents.map((p) => (
                  <li key={p}>
                    <button className="recent-row" onClick={() => goToSessionStep(p)} title={p}>
                      <span className="recent-name">{basename(p)}</span>
                      <span className="recent-path">{p}</span>
                    </button>
                    <button className="recent-x" onClick={() => onRemoveRecent(p)} title="Remove from recents">×</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-card picker-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <button className="icon-btn" onClick={() => { setStep("project"); setQuery(""); setSelectedId(null); setPreview(null); setSessions([]); }} title="Back" aria-label="Back">←</button>
          <div className="picker-brand" style={{ marginLeft: 6 }}>
            <VectorMark /> <span>{basename(project ?? "")}</span>
          </div>
          <div className="picker-head-right">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {installedAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
              <option value="__shell__">shell</option>
            </select>
            <button className="picker-primary" onClick={() => project && onPick(project, agentId)}>+ New session</button>
            {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>}
          </div>
        </div>
        <div className="session-body">
          <div className="session-list">
            {(sessions.length > 0 || query.trim().length > 0 || sessionsLoading) && (
              <input
                className="session-search"
                placeholder="Search this project's sessions…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            )}
            <div className="session-rows">
              {sessionsLoading ? (
                <div className="session-muted">Loading…</div>
              ) : sessions.length === 0 ? (
                <div className="session-muted">
                  {agentId === "claude" ? "No previous sessions in this project." : "Resume isn't supported for this agent yet."}
                </div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    className={`session-row${selectedId === s.id ? " selected" : ""}`}
                    onClick={() => setSelectedId(s.id)}
                    onDoubleClick={() => project && onPick(project, agentId, s.id)}
                    title={s.title}
                  >
                    <div className="session-title">
                      {s.title || "(untitled)"}
                      {s.hasRecap && <span className="session-badge" title="Contains a compaction recap">recap</span>}
                    </div>
                    <div className="session-meta">
                      <span title={new Date(s.modifiedMs).toLocaleString()}>{relativeTime(s.modifiedMs)}</span>
                      {s.messageCount > 0 && <span>· {s.messageCount} messages</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="session-preview">
            {previewLoading ? (
              <div className="session-muted">Loading preview…</div>
            ) : !preview ? (
              <div className="session-muted">{sessions.length > 0 ? "Select a session to preview" : "No sessions to preview."}</div>
            ) : (
              <>
                <div className="session-preview-head">
                  <div className="session-preview-title">{preview.title || "(untitled)"}</div>
                  <div className="session-preview-meta">{relativeTime(preview.modifiedMs)} · {preview.messages.length} messages</div>
                </div>
                <div className="session-preview-body" ref={previewBodyRef}>
                  {preview.messages.filter((m) => m.kind === "recap").map((m, i, arr) => (
                    <details key={`recap-${i}`} className="msg msg--recap" open={i === arr.length - 1}>
                      <summary>Recap from previous context {arr.length > 1 ? `(${i + 1}/${arr.length})` : ""}</summary>
                      <div className="msg-text">{m.text}</div>
                    </details>
                  ))}
                  {preview.messages.filter((m) => m.kind !== "recap").slice(-30).map((m, i) =>
                    m.kind === "system" ? (
                      <div key={i} className="msg msg--sys"><span>system: {m.label}</span></div>
                    ) : (
                      <div key={i} className={`msg msg--${m.role}`}>
                        <span className="msg-role">{m.role}</span>
                        <div className="msg-text">{m.text}</div>
                      </div>
                    )
                  )}
                </div>
                <div className="session-preview-actions">
                  <button className="picker-primary" onClick={() => project && onPick(project, agentId, preview.id)}>
                    Resume this session
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  section,
  onSection,
  themeName,
  onThemeName,
  fontFamily,
  onFontFamily,
  fontSize,
  onFontSize,
  customTheme,
  onCustomTheme,
  transparency,
  onTransparency,
  orientation,
  onOrientation,
  profiles,
  onProfilesChanged,
  onClose,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  themeName: "dark" | "light" | "custom";
  onThemeName: (t: "dark" | "light" | "custom") => void;
  fontFamily: string;
  onFontFamily: (v: string) => void;
  fontSize: number;
  onFontSize: (v: number) => void;
  customTheme: ITheme | null;
  onCustomTheme: (v: ITheme | null) => void;
  transparency: number;
  onTransparency: (v: number) => void;
  orientation: Orientation;
  onOrientation: (o: Orientation) => void;
  profiles: ClaudeProfileDto[];
  onProfilesChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [customThemeDraft, setCustomThemeDraft] = useState<string>(() =>
    customTheme ? JSON.stringify(customTheme, null, 2) : ""
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const navItems: { id: SettingsSection; label: string; icon: ReactNode }[] = [
    { id: "appearance", label: "Appearance", icon: <PaletteIcon /> },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <KeyboardIcon /> },
    { id: "profiles", label: "Claude Profiles", icon: <UsersIcon /> },
  ];

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-card settings-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <div className="picker-brand"><VectorMark /> <span>Settings</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-modal-body">
          <aside className="settings-sidebar">
            <div className="settings-nav-heading">General</div>
            {navItems.slice(0, 2).map((n) => (
              <button key={n.id} className={`settings-nav-item${section === n.id ? " active" : ""}`} onClick={() => onSection(n.id)}>
                {n.icon}<span>{n.label}</span>
              </button>
            ))}
            <div className="settings-nav-heading">Agents</div>
            {navItems.slice(2).map((n) => (
              <button key={n.id} className={`settings-nav-item${section === n.id ? " active" : ""}`} onClick={() => onSection(n.id)}>
                {n.icon}<span>{n.label}</span>
              </button>
            ))}
          </aside>
          <section className="settings-content">
            {section === "appearance" && (
              <>
                <h2 className="settings-section-title">Appearance</h2>
                <div className="settings-row">
                  <span>Theme</span>
                  <div className="seg">
                    <button className={themeName === "dark" ? "on" : ""} onClick={() => onThemeName("dark")}>Dark</button>
                    <button className={themeName === "light" ? "on" : ""} onClick={() => onThemeName("light")}>Light</button>
                    <button className={themeName === "custom" ? "on" : ""} onClick={() => onThemeName("custom")}>Custom</button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>Tabs</span>
                  <div className="seg">
                    <button className={orientation === "horizontal" ? "on" : ""} onClick={() => onOrientation("horizontal")}>Top</button>
                    <button className={orientation === "vertical" ? "on" : ""} onClick={() => onOrientation("vertical")}>Side</button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>Font family</span>
                  <input
                    className="settings-input"
                    value={fontFamily}
                    onChange={(e) => onFontFamily(e.target.value)}
                    placeholder={DEFAULT_FONT_FAMILY}
                  />
                </div>
                <div className="settings-row">
                  <span>Font size</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="number" min={8} max={40} step={1}
                      className="settings-input settings-input-sm"
                      value={fontSize}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        onFontSize(Number.isFinite(n) ? clamp(n, 8, 40) : 13);
                      }}
                    />
                    <span className="settings-hint">⌘+ / ⌘− / ⌘0</span>
                  </div>
                </div>
                {themeName === "custom" && (
                  <div className="settings-row settings-row-col">
                    <span>Custom theme (xterm ITheme JSON)</span>
                    <textarea
                      className="settings-textarea"
                      rows={10}
                      value={customThemeDraft}
                      onChange={(e) => setCustomThemeDraft(e.target.value)}
                      onBlur={() => {
                        const trimmed = customThemeDraft.trim();
                        if (trimmed === "") { onCustomTheme(null); return; }
                        try {
                          const parsed = JSON.parse(trimmed) as ITheme;
                          onCustomTheme(parsed);
                        } catch { /* keep draft, don't clobber */ }
                      }}
                      placeholder='{"background":"#0b0b0f","foreground":"#e6e6e6"}'
                    />
                    <div className="settings-hint">Applied on blur. Invalid JSON is ignored (draft preserved).</div>
                  </div>
                )}
                <div className="settings-row">
                  <span>Transparency</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={transparency}
                      onChange={(e) => onTransparency(Number(e.target.value))}
                    />
                    <span className="settings-hint">{Math.round(transparency * 100)}%</span>
                  </div>
                </div>
              </>
            )}
            {section === "shortcuts" && (
              <>
                <h2 className="settings-section-title">Keyboard shortcuts</h2>
                <div className="shortcuts-list">
                  <Shortcut keys={["cmd", "T"]} label="New tab" />
                  <Shortcut keys={["cmd", "W"]} label="Close active pane" />
                  <Shortcut keys={["cmd", "D"]} label="Split pane right" />
                  <Shortcut keys={["cmd", "shift", "D"]} label="Split pane down" />
                  <Shortcut keys={["cmd", "opt", "left"]} label="Focus pane left" />
                  <Shortcut keys={["cmd", "opt", "right"]} label="Focus pane right" />
                  <Shortcut keys={["cmd", "opt", "up"]} label="Focus pane up" />
                  <Shortcut keys={["cmd", "opt", "down"]} label="Focus pane down" />
                  <Shortcut keys={["cmd", "shift", "R"]} label="Reload active pane" />
                  <Shortcut keys={["cmd", "1–9"]} label="Switch tab" />
                  <Shortcut keys={["ctrl", "Tab"]} label="Next tab" />
                  <Shortcut keys={["ctrl", "shift", "Tab"]} label="Previous tab" />
                  <Shortcut keys={["shift", "enter"]} label="Multi-line input (Claude Code)" />
                  <Shortcut keys={["cmd", ","]} label="Open settings" />
                  <Shortcut keys={["cmd", "+"]} label="Zoom in" />
                  <Shortcut keys={["cmd", "−"]} label="Zoom out" />
                  <Shortcut keys={["cmd", "0"]} label="Reset zoom" />
                  <Shortcut keys={["cmd", "k"]} label="Switch agent" />
                </div>
              </>
            )}
            {section === "profiles" && <ProfilesSection profiles={profiles} onChanged={onProfilesChanged} />}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProfilesSection({ profiles, onChanged }: { profiles: ClaudeProfileDto[]; onChanged: () => void | Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; profile: ClaudeProfileDto } | null>(null);

  const onDelete = useCallback(async (p: ClaudeProfileDto) => {
    if (!window.confirm(`Delete profile "${p.name}"?\n\nFolder mappings will be cleared. Your login for this profile stays on disk at:\n${p.configDir}`)) return;
    try {
      await invoke("delete_claude_profile", { id: p.id });
      await onChanged();
    } catch (e) {
      setError(String(e));
    }
  }, [onChanged]);

  return (
    <>
      <h2 className="settings-section-title">Claude Profiles</h2>
      <p className="settings-section-sub">
        Keep separate Claude accounts for different folders. Vector switches automatically based on the project path a tab opens in — no more logout/login dance.
      </p>
      {error && <div style={{ color: "#ff5a5a", fontSize: 12 }}>{error}</div>}
      {profiles.length === 0 ? (
        <button className="profile-add" onClick={() => setDialog({ mode: "create" })}>
          <span>＋</span><span>Add your first profile</span>
        </button>
      ) : (
        <>
          <div className="profiles-list">
            {profiles.map((p) => <ProfileRow key={p.id} profile={p} onEdit={() => setDialog({ mode: "edit", profile: p })} onDelete={() => onDelete(p)} />)}
          </div>
          <button className="profile-add" onClick={() => setDialog({ mode: "create" })}>
            <span>＋</span><span>Add profile</span>
          </button>
        </>
      )}
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        Folders not mapped above use your default Claude login (<span className="mono">~/.claude</span>). First time you open a new profile, Claude Code will prompt you to <span className="mono">/login</span> — that stays for future sessions.
      </div>
      {dialog && (
        <ProfileDialog
          mode={dialog.mode}
          initial={dialog.mode === "edit" ? dialog.profile : undefined}
          onClose={() => setDialog(null)}
          onSaved={async () => { setDialog(null); await onChanged(); }}
        />
      )}
    </>
  );
}

function ProfileRow({ profile, onEdit, onDelete }: { profile: ClaudeProfileDto; onEdit: () => void; onDelete: () => void }) {
  const initial = (profile.name[0] ?? "?").toUpperCase();
  const n = profile.folders.length;
  return (
    <div className="profile-row">
      <div className="profile-avatar" style={{ background: profile.color }}>{initial}</div>
      <div className="profile-name-wrap">
        <div className="profile-name-line">
          <span className="profile-name">{profile.name}</span>
        </div>
        {n > 0 ? (
          <span className="folders-trigger" tabIndex={0}>
            {n} folder{n === 1 ? "" : "s"}
            <div className="folders-popover" role="tooltip">
              {profile.folders.map((f) => <span key={f} className="folders-popover-item">{f}</span>)}
            </div>
          </span>
        ) : (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>no folders yet</span>
        )}
      </div>
      <div className="profile-email">
        {profile.signedInEmail ? (
          <>
            <span className="em" title={profile.signedInEmail}>{profile.signedInEmail}</span>
            <span>signed in</span>
          </>
        ) : (
          <span>not signed in</span>
        )}
      </div>
      <div className="profile-actions">
        <button className="icon-btn" onClick={onEdit} aria-label="Edit" title="Edit">✎</button>
        <button className="icon-btn" onClick={onDelete} aria-label="Delete" title="Delete">×</button>
      </div>
    </div>
  );
}

type ClaudeHomeValidation = {
  valid: boolean;
  expandedPath: string;
  hasCredentials: boolean;
  hasConfig: boolean;
  hasProjects: boolean;
  siblingConfigPath: string | null;
  detectedEmail: string | null;
  credentialsInKeychain: boolean;
};

function ProfileDialog({ mode, initial, onClose, onSaved }: {
  mode: "create" | "edit";
  initial?: ClaudeProfileDto;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? DEFAULT_PROFILE_COLOR);
  const [folders, setFolders] = useState<string[]>(initial?.folders ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed-from is create-mode only. Defaults to ~/.claude; user can override.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [seedPath, setSeedPath] = useState<string>(mode === "create" ? "~/.claude" : "");
  const [seedValidation, setSeedValidation] = useState<ClaudeHomeValidation | null>(null);
  const [validating, setValidating] = useState(false);

  // Debounced validation whenever the seed path changes (create mode only).
  useEffect(() => {
    if (mode !== "create") return;
    if (!seedPath.trim()) { setSeedValidation(null); return; }
    const handle = window.setTimeout(async () => {
      setValidating(true);
      try {
        const v = await invoke<ClaudeHomeValidation>("validate_claude_home", { path: seedPath });
        setSeedValidation(v);
      } catch {
        setSeedValidation(null);
      } finally {
        setValidating(false);
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [seedPath, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const addFolder = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string" && !folders.includes(selected)) {
        setFolders([...folders, selected]);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const pickSeedFolder = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") setSeedPath(selected);
    } catch (e) {
      setError(String(e));
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required"); return; }
    // If the user picked a seed path but it's invalid, block save.
    if (mode === "create" && seedPath.trim() && seedValidation && !seedValidation.valid) {
      setError("Seed folder isn't a Claude home. Clear it to start fresh, or pick a valid folder.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await invoke("create_claude_profile", {
          name: trimmed,
          color,
          folders,
          seedFrom: seedPath.trim() || null,
        });
      } else if (initial) {
        await invoke("update_claude_profile", { id: initial.id, name: trimmed, color, folders });
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canShowAdvanced = mode === "create";

  return (
    <div className="picker-overlay" onClick={onClose} style={{ zIndex: 60 }}>
      <div className="picker-card profile-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "create" ? "New profile" : "Edit profile"}</h3>
        <div className="profile-field">
          <label>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work" autoFocus />
        </div>
        <div className="profile-field">
          <label>Folders</label>
          <button type="button" className="folder-picker-btn" onClick={addFolder}>＋ Add folder…</button>
          {folders.length > 0 && (
            <div className="profile-folders" style={{ marginTop: 6 }}>
              {folders.map((f) => (
                <span key={f} className="folder-chip">
                  {f}
                  <span className="x" onClick={() => setFolders(folders.filter((x) => x !== f))}>×</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="profile-field">
          <label>Color</label>
          <div className="color-swatches">
            {PROFILE_COLORS.map((c) => (
              <span
                key={c}
                className={`color-swatch${c === color ? " on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {canShowAdvanced && (
          <details className="profile-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Advanced</summary>
            <div className="profile-field" style={{ marginTop: 10 }}>
              <label>Seed from</label>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6, lineHeight: 1.4 }}>
                Copy credentials, settings, and session history from an existing Claude home. Leave empty to start fresh.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={seedPath}
                  onChange={(e) => setSeedPath(e.target.value)}
                  placeholder="~/.claude"
                  style={{ flex: 1 }}
                />
                <button type="button" className="folder-picker-btn" onClick={pickSeedFolder} style={{ padding: "7px 10px" }}>Browse…</button>
                {seedPath && (
                  <button type="button" onClick={() => setSeedPath("")} title="Clear (start fresh)">×</button>
                )}
              </div>
              <SeedValidationStatus seedPath={seedPath} validating={validating} validation={seedValidation} />
            </div>
          </details>
        )}
        {error && <div style={{ color: "#ff5a5a", fontSize: 12 }}>{error}</div>}
        <div className="profile-dialog-foot">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !name.trim()}>
            {mode === "create" ? "Create profile" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SeedValidationStatus({ seedPath, validating, validation }: {
  seedPath: string;
  validating: boolean;
  validation: ClaudeHomeValidation | null;
}) {
  if (!seedPath.trim()) {
    return <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Will create an empty profile (Claude will prompt to <span className="mono">/login</span> on first use).</div>;
  }
  if (validating || !validation) {
    return <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Checking…</div>;
  }
  if (validation.valid) {
    return (
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 11.5, color: "#7fd6b5", display: "flex", alignItems: "center", gap: 6 }}>
          <span>✓</span>
          <span>
            Looks like a Claude home
            {validation.detectedEmail && <> · <span style={{ color: "var(--fg)" }}>{validation.detectedEmail}</span></>}
            {validation.hasProjects && <> · session history included</>}
          </span>
        </div>
        {validation.credentialsInKeychain && (
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4, paddingLeft: 18 }}>
            Credentials appear to be in macOS Keychain — you'll still need to <span className="mono">/login</span> once in the new profile. Settings &amp; history carry over.
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11.5, color: "#ff5a5a", marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
      <span>✗</span>
      <span>Not a Claude home — nothing recognisable at this path.</span>
    </div>
  );
}

function ProfilePill({ profiles, cwd, override, onPick, onManage }: {
  profiles: ClaudeProfileDto[];
  cwd: string;
  override: string | null | undefined;
  onPick: (id: string | null | undefined) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  const resolved = resolveProfileForCwd(profiles, cwd);
  // Which profile is *actually* active for this pane:
  //   override === null        → explicit Default
  //   override is a string     → that profile (if it still exists)
  //   override === undefined   → the path-resolved profile (or Default if none)
  const active: ClaudeProfileDto | null =
    override === null
      ? null
      : typeof override === "string"
        ? (profiles.find((p) => p.id === override) ?? null)
        : resolved;

  // Hide the pill entirely when there are no profiles yet — avoids noise for
  // users who haven't opted into the feature.
  if (profiles.length === 0) return null;

  const color = active?.color ?? "var(--muted)";
  const name = active?.name ?? "default";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span
        className="profile-pill"
        onClick={() => setOpen((o) => !o)}
        title={active ? `Claude profile: ${active.name}` : "Claude profile: default (~/.claude)"}
      >
        <span className="pdot" style={{ background: color }} />
        <span className="pname">{name}</span>
        <span className="pcaret">▾</span>
      </span>
      {open && (
        <div className="profile-dropdown">
          <div className="profile-dd-head">Profile for this tab</div>
          {profiles.map((p) => (
            <div key={p.id} className="profile-dd-item" onClick={() => { setOpen(false); onPick(p.id); }}>
              <span className="dd-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
              {active?.id === p.id && <span className="dd-check">✓</span>}
            </div>
          ))}
          <div className="profile-dd-item" onClick={() => { setOpen(false); onPick(null); }}>
            <span className="dd-dot default" />
            <span>Default</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)", fontFamily: '"JetBrains Mono", monospace' }}>~/.claude</span>
            {active === null && <span className="dd-check">✓</span>}
          </div>
          <div className="profile-dd-sep" />
          <div className="profile-dd-item accent" onClick={() => { setOpen(false); onManage(); }}>Manage profiles…</div>
        </div>
      )}
    </div>
  );
}

function AgentSwitcher({
  agents,
  onPick,
  onClose,
}: {
  agents: AgentMeta[];
  onPick: (agentId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);

  const entries = useMemo<{ id: string; label: string }[]>(() => [
    { id: "__shell__", label: "shell" },
    ...agents.map((a) => ({ id: a.id, label: a.label })),
  ], [agents]);

  const q = query.trim().toLowerCase();
  const filtered = q === ""
    ? entries
    : entries.filter((e) => e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q));

  useEffect(() => { setIdx(0); }, [q]);

  const commit = (i: number) => {
    const pick = filtered[i];
    if (!pick) return;
    onPick(pick.id);
    onClose();
  };

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-card agent-switcher" onClick={(e) => e.stopPropagation()}>
        <input
          className="switcher-input"
          autoFocus
          placeholder="Switch agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); commit(idx); }
          }}
        />
        <div className="switcher-list">
          {filtered.length === 0 && <div className="switcher-empty">No agents match.</div>}
          {filtered.map((e, i) => (
            <div
              key={e.id}
              className={`switcher-row${i === idx ? " active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => commit(i)}
            >
              <AgentIcon id={e.id} size={16} />
              <span className="switcher-label">{e.label}</span>
              <span className="switcher-id">{e.id}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type PaneViewProps = {
  tabId: string;
  root: PaneNode;
  activePaneId: string;
  tabVisible: boolean;
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  onFocusPane: (paneId: string) => void;
  onBell: (tabId: string, paneId: string) => void;
  onTitle: (tabId: string, paneId: string, title: string) => void;
  onExitPane: (paneId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
  onPaneDragStart: (paneId: string) => void;
  onPaneDragEnd: () => void;
  onPaneDrop: (targetPaneId: string, edge: "left" | "right" | "top" | "bottom") => void;
  getDndKind: () => "pane" | "tab" | null;
  getDndPaneId: () => string | null;
  onSessionStart?: (leafId: string, epoch: number) => void;
  paneTitles: Record<string, string>;
  renamingPaneId: string | null;
  paneRenameDraft: string;
  onStartPaneRename: (paneId: string, initial: string) => void;
  onPaneRenameDraft: (v: string) => void;
  onCommitPaneRename: () => void;
  onCancelPaneRename: () => void;
  onClosePane: (paneId: string) => void;
};

function PaneTitleBar({
  leaf,
  title,
  renaming,
  draft,
  showClose,
  onStartRename,
  onDraftChange,
  onCommitRename,
  onCancelRename,
  onClose,
  onDragStart,
  onDragEnd,
}: {
  leaf: PaneLeaf;
  title: string;
  renaming: boolean;
  draft: string;
  showClose: boolean;
  onStartRename: () => void;
  onDraftChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="pane-titlebar"
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={(e) => e.stopPropagation()}
      title="Drag to move pane"
    >
      <span className="pane-grip-dots">⋮⋮</span>
      <span className="pane-agent-chip"><AgentIcon id={leaf.agentId} size={12} /></span>
      {renaming ? (
        <input
          className="pane-rename"
          value={draft}
          autoFocus
          onChange={(e) => onDraftChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); onCommitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
          }}
          onBlur={onCommitRename}
          placeholder={title || "Pane name"}
        />
      ) : (
        <span
          className="pane-title-label"
          onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
          title="Double-click to rename"
        >{title}</span>
      )}
      {showClose && (
        <span className="pane-close" onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close pane">×</span>
      )}
    </div>
  );
}

function flattenLeaves(node: PaneNode): PaneLeaf[] {
  return node.kind === "leaf" ? [node] : [...flattenLeaves(node.children[0]), ...flattenLeaves(node.children[1])];
}

type DividerInfo = { id: string; direction: "row" | "column"; pos: number; container: [number, number, number, number]; ratio: number };
function computeDividers(node: PaneNode, rect: [number, number, number, number]): DividerInfo[] {
  if (node.kind === "leaf") return [];
  const [x, y, w, h] = rect;
  const { direction, children, ratio, id } = node;
  if (direction === "row") {
    const sx = x + w * ratio;
    return [
      { id, direction, pos: sx, container: rect, ratio },
      ...computeDividers(children[0], [x, y, w * ratio, h]),
      ...computeDividers(children[1], [sx, y, w * (1 - ratio), h]),
    ];
  } else {
    const sy = y + h * ratio;
    return [
      { id, direction, pos: sy, container: rect, ratio },
      ...computeDividers(children[0], [x, y, w, h * ratio]),
      ...computeDividers(children[1], [x, sy, w, h * (1 - ratio)]),
    ];
  }
}

function PaneView(props: PaneViewProps) {
  const { tabId, root, activePaneId, tabVisible, theme, fontFamily, fontSize, onFocusPane, onBell, onTitle, onExitPane, onResize, onPaneDragStart, onPaneDragEnd, onPaneDrop, getDndKind, getDndPaneId, onSessionStart, paneTitles, renamingPaneId, paneRenameDraft, onStartPaneRename, onPaneRenameDraft, onCommitPaneRename, onCancelPaneRename, onClosePane } = props;
  const leaves = flattenLeaves(root);
  const rects = leafRects(root, [0, 0, 1, 1]);
  const dividers = computeDividers(root, [0, 0, 1, 1]);
  const rectFor = (id: string) => rects.find((r) => r.id === id)!.rect;
  const single = leaves.length === 1;

  return (
    <div className="tab-panes-layout">
      {leaves.map((leaf) => {
        const [x, y, w, h] = rectFor(leaf.id);
        const isActive = leaf.id === activePaneId;
        const EPS = 1e-6;
        const R = "var(--pane-radius, 6px)";
        const tl = x < EPS && y < EPS ? R : "0";
        const tr = x + w > 1 - EPS && y < EPS ? R : "0";
        const br = x + w > 1 - EPS && y + h > 1 - EPS ? R : "0";
        const bl = x < EPS && y + h > 1 - EPS ? R : "0";
        return (
          <div
            key={leaf.id}
            className={`pane${isActive ? " pane-active" : ""}${single ? " pane-solo" : ""}`}
            style={{
              position: "absolute",
              left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`,
              borderRadius: `${tl} ${tr} ${br} ${bl}`,
              overflow: "hidden",
            }}
            onMouseDown={() => onFocusPane(leaf.id)}
            onDragOver={(e) => {
              const kind = getDndKind();
              if (!kind) return;
              if (kind === "pane" && getDndPaneId() === leaf.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              const kind = getDndKind();
              if (!kind) return;
              if (kind === "pane" && getDndPaneId() === leaf.id) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const dx = (e.clientX - r.left) / r.width;
              const dy = (e.clientY - r.top) / r.height;
              const edge: "left" | "right" | "top" | "bottom" =
                Math.min(dx, 1 - dx) < Math.min(dy, 1 - dy)
                  ? (dx < 0.5 ? "left" : "right")
                  : (dy < 0.5 ? "top" : "bottom");
              onPaneDrop(leaf.id, edge);
            }}
          >
            {!single && (
              <PaneTitleBar
                leaf={leaf}
                title={leaf.userTitle || paneTitles[leaf.id] || leaf.agentId}
                renaming={renamingPaneId === leaf.id}
                draft={paneRenameDraft}
                showClose={leaves.length > 1}
                onStartRename={() => onStartPaneRename(leaf.id, leaf.userTitle ?? "")}
                onDraftChange={onPaneRenameDraft}
                onCommitRename={onCommitPaneRename}
                onCancelRename={onCancelPaneRename}
                onClose={() => onClosePane(leaf.id)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  try { e.dataTransfer.setData("text/plain", "pane"); } catch {}
                  onPaneDragStart(leaf.id);
                }}
                onDragEnd={() => onPaneDragEnd()}
              />
            )}
            <div className="pane-body" style={{ position: "absolute", inset: single ? 0 : "22px 0 0 0" }}>
              <TerminalView
                key={`${leaf.id}-${leaf.epoch}`}
                tabId={tabId}
                paneId={leaf.id}
                agentId={leaf.agentId}
                cwd={leaf.cwd}
                resumeId={leaf.resumeId}
                continueLatest={leaf.continueLatest}
                profileOverride={leaf.profileOverride}
                epoch={leaf.epoch}
                visible={tabVisible}
                focused={isActive}
                theme={theme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onBell={onBell}
                onTitle={onTitle}
                onExit={() => onExitPane(leaf.id)}
                onSessionStart={onSessionStart}
              />
            </div>
          </div>
        );
      })}
      {dividers.map((d) => (
        <Divider key={d.id} info={d} onResize={onResize} />
      ))}
    </div>
  );
}

function Divider({ info, onResize }: { info: DividerInfo; onResize: (splitId: string, ratio: number) => void }) {
  const { direction, pos, container, ratio } = info;
  const [cx, cy, cw, ch] = container;
  const style: any = direction === "row"
    ? { position: "absolute", left: `calc(${pos * 100}% - 2px)`, top: `${cy * 100}%`, width: "4px", height: `${ch * 100}%` }
    : { position: "absolute", top: `calc(${pos * 100}% - 2px)`, left: `${cx * 100}%`, height: "4px", width: `${cw * 100}%` };

  const onDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const parent = (e.currentTarget as HTMLElement).parentElement!;
    const prect = parent.getBoundingClientRect();
    const axisPx = direction === "row" ? prect.width : prect.height;
    const startPixel = direction === "row" ? e.clientX : e.clientY;
    const containerSize = direction === "row" ? cw : ch;
    const startRatio = ratio;
    const onMove = (ev: MouseEvent) => {
      const p = direction === "row" ? ev.clientX : ev.clientY;
      const deltaU = (p - startPixel) / axisPx; // fraction of full parent
      const local = startRatio + deltaU / containerSize;
      onResize(info.id, Math.max(0.05, Math.min(0.95, local)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return <div className={`divider divider-${direction}`} style={style} onMouseDown={onDown} />;
}

function TerminalView({
  tabId,
  paneId,
  agentId,
  cwd,
  resumeId,
  continueLatest,
  profileOverride,
  epoch,
  visible,
  focused,
  theme,
  fontFamily,
  fontSize,
  onBell,
  onTitle,
  onExit,
  onSessionStart,
}: {
  tabId: string;
  paneId: string;
  agentId: string;
  cwd: string;
  resumeId?: string;
  continueLatest?: boolean;
  profileOverride?: string | null;
  epoch: number;
  visible: boolean;
  focused: boolean;
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  onBell: (tabId: string, paneId: string) => void;
  onTitle: (tabId: string, paneId: string, title: string) => void;
  onExit: () => void;
  onSessionStart?: (leafId: string, epoch: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hoveredLinkRef = useRef<{ uri: string; kind: "url" | "path" } | null>(null);
  type TermMenu =
    | { kind: "link"; x: number; y: number; uri: string; linkKind: "url" | "path" }
    | { kind: "selection"; x: number; y: number; text: string };
  const [termMenu, setTermMenu] = useState<TermMenu | null>(null);
  const focusedRef = useRef(focused);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = theme; }, [theme]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily = fontFamily;
    t.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch {}
  }, [fontFamily, fontSize]);

  useEffect(() => {
    if (!wrapRef.current) return;

    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      theme,
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // http(s) links — route through the OS default handler so they land in
    // the user's browser instead of the WKWebView's blocked window.open.
    term.loadAddon(new WebLinksAddon(
      (e, uri) => {
        // Only left-click activates — right-click is reserved for the context menu.
        if (e && (e as MouseEvent).button !== 0) return;
        invoke("open_path", { path: uri }).catch(() => {});
      },
      {
        hover: (_e: MouseEvent, uri: string) => { hoveredLinkRef.current = { uri, kind: "url" }; },
        leave: () => { hoveredLinkRef.current = null; },
      } as any,
    ));
    // File / folder paths — absolute (`/...`) or home (`~/...`). Clicking
    // opens the path with the OS default app: Finder for directories,
    // associated app for files.
    const PATH_RE = /(?:^|[\s"'`()[\]{}<>])((?:~\/|\/)[^\s"'`()[\]{}<>]+)/g;
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links: any[] = [];
        PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PATH_RE.exec(text))) {
          // Trim trailing punctuation that's typically not part of the path.
          let p = m[1].replace(/[.,;:!?)\]}>]+$/, "");
          if (p.length < 2) continue;
          const start = m.index + m[0].length - m[1].length;
          links.push({
            range: {
              start: { x: start + 1, y },
              end:   { x: start + p.length, y },
            },
            text: p,
            activate(e: MouseEvent, path: string) {
              if (e && e.button !== 0) return;
              invoke("open_path", { path }).catch(() => {});
            },
            hover(_e: MouseEvent, path: string) { hoveredLinkRef.current = { uri: path, kind: "path" }; },
            leave() { hoveredLinkRef.current = null; },
          });
        }
        callback(links);
      },
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Swallow OSC 777 (Claude Code remote-control "warp://cli-agent;{...}"
    // notifications). xterm.js's OSC parser trips over the nested JSON and
    // bleeds the payload into the on-screen buffer. We have no use for them,
    // so consume and drop.
    term.parser.registerOscHandler(777, () => true);
    term.open(wrapRef.current);
    termRef.current = term;
    fitRef.current = fit;
    term.onBell(() => onBell(tabId, paneId));
    term.onTitleChange((t) => { if (t) onTitle(tabId, paneId, t); });

    // Right-click on a URL/path link → Open/Copy menu.
    // Right-click on a selection (no link) → Copy / Copy as plain text menu.
    // Right-click on empty area → default browser menu.
    const onContextMenu = (e: MouseEvent) => {
      const link = hoveredLinkRef.current;
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        setTermMenu({ kind: "link", x: e.clientX, y: e.clientY, uri: link.uri, linkKind: link.kind });
        return;
      }
      const sel = term.getSelection();
      if (sel && sel.trim().length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setTermMenu({ kind: "selection", x: e.clientX, y: e.clientY, text: sel });
      }
    };
    wrapRef.current.addEventListener("contextmenu", onContextMenu);

    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Enter" && e.shiftKey) return false;
      // Let our document-capture handler own Cmd/Opt+Backspace.
      if (e.key === "Backspace" && (e.metaKey || e.altKey)) return false;
      // Cmd+Arrow and Opt+Arrow are translated to readline sequences below.
      // (Cmd+Opt+Arrow stays with the global handler for pane focus.)
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")
          && !e.shiftKey && !e.ctrlKey
          && ((e.metaKey && !e.altKey) || (e.altKey && !e.metaKey))) {
        return false;
      }
      return true;
    });

    // Document-capture: intercept shortcuts before the webview/xterm handle them
    // and forward the right readline sequence over the PTY.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.type !== "keydown") return;
      if (!wrapRef.current || wrapRef.current.style.display === "none") return;
      if (!wrapRef.current.contains(document.activeElement)) return;
      const send = (data: string) => {
        e.preventDefault();
        e.stopPropagation();
        invoke("write_stdin", { sessionId, data }).catch(() => {});
      };
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Shift+Enter → ESC+CR (Claude Code's /terminal-setup multi-line).
        return send("\x1b\r");
      }
      if (e.key === "Backspace" && e.metaKey && !e.ctrlKey) {
        // Cmd+Backspace → kill line backwards (Ctrl+U).
        return send("\x15");
      }
      if (e.key === "Backspace" && e.altKey && !e.metaKey && !e.ctrlKey) {
        // Opt+Backspace → kill word backwards (Ctrl+W).
        return send("\x17");
      }
      // macOS line-editing shortcuts — translate to readline control chars
      // so Claude Code's input (and any bash-like prompt) obeys them.
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowLeft")  return send("\x01"); // Cmd+← → Ctrl+A (line start)
        if (e.key === "ArrowRight") return send("\x05"); // Cmd+→ → Ctrl+E (line end)
        if (e.key === "ArrowUp")    return send("\x01"); // Cmd+↑ → line start (doc-start analog)
        if (e.key === "ArrowDown")  return send("\x05"); // Cmd+↓ → line end  (doc-end   analog)
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowLeft")  return send("\x1bb"); // Opt+← → word back (Esc+b)
        if (e.key === "ArrowRight") return send("\x1bf"); // Opt+→ → word forward (Esc+f)
      }
    };
    document.addEventListener("keydown", onDocKey, true);

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenNotify: UnlistenFn | null = null;
    let disposed = false;
    let started = false;
    let fontsReady = false;
    let lastCols = -1, lastRows = -1, stableCount = 0;

    const doStart = async () => {
      started = true;
      try { onSessionStart?.(paneId, epoch); } catch {}
      try { fit.fit(); } catch {}
      const cols = term.cols || 100;
      const rows = term.rows || 30;
      try {
        // Shrink both xterm AND the PTY by a 2-col safety margin. fit.fit()
        // sometimes over-reports cols by a fraction, so a "full-width" agent
        // line wraps by one column and shifts every subsequent row, breaking
        // the diff-based repaint. Keeping them equal means there are no
        // rightmost cells that the agent never paints (and therefore no stale
        // glyph residue there either).
        const ptyCols = Math.max(20, cols - 3);
        try { term.resize(ptyCols, rows); } catch {}
        // profileOverride: undefined → backend resolves from cwd; null → force default ~/.claude; string → use that profile id
        const overrideArg = profileOverride === undefined ? null : (profileOverride === null ? "__default__" : profileOverride);
        await invoke("start_session", { sessionId, agentId, cols: ptyCols, rows, cwd, resumeId: resumeId ?? null, continueLatest: continueLatest ?? false, profileOverride: overrideArg });
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[failed to start agent: ${err}]\x1b[0m`);
      }
      if (visible && focused) term.focus();
    };

    const poll = () => {
      if (started || disposed || !fontsReady) return;
      const el = wrapRef.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
      try { fit.fit(); } catch {}
      const c = term.cols, r = term.rows;
      if (c < 20 || r < 5) return;
      if (c === lastCols && r === lastRows) stableCount++;
      else { lastCols = c; lastRows = r; stableCount = 0; }
      if (stableCount >= 2) doStart();
    };

    (async () => {
      unlistenData = await listen<string>(`pty-data-${sessionId}`, (e) => term.write(e.payload));
      unlistenExit = await listen<number>(`pty-exit-${sessionId}`, () => {
        onExit();
      });
      // Claude Code emits OSC 777 warp://cli-agent notifies for permission
      // prompts and idle-wait states. pty.rs strips them and forwards a count
      // here; route to the same bell path so the tab lights up + Dock badges.
      unlistenNotify = await listen<number>(`pty-notify-${sessionId}`, () => {
        onBell(tabId, paneId);
      });

      term.onData((data) => { invoke("write_stdin", { sessionId, data }).catch(() => {}); });
      term.onResize(({ cols, rows }) => {
        if (started) invoke("resize_pty", { sessionId, cols, rows }).catch(() => {});
      });

      // wait for fonts to avoid measuring char width before they load
      try { await (document as any).fonts?.ready; } catch {}
      fontsReady = true;
      poll();
      // safety net: start after 500ms even if we never observe two identical measurements
      window.setTimeout(() => { if (!started && !disposed && fontsReady) doStart(); }, 500);
    })();

    let pollTimer: number | null = null;
    const schedulePoll = () => {
      if (pollTimer != null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(poll, 60);
    };
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const safeCols = Math.max(20, term.cols - 3);
        if (term.cols !== safeCols) term.resize(safeCols, term.rows);
      } catch {}
      if (!started) schedulePoll();
    });
    if (wrapRef.current) ro.observe(wrapRef.current);

    const onWinFocus = () => {
      if (!wrapRef.current || wrapRef.current.offsetParent === null) return;
      if (focusedRef.current) term.focus();
    };
    window.addEventListener("focus", onWinFocus);

    return () => {
      disposed = true;
      ro.disconnect();
      if (pollTimer != null) window.clearTimeout(pollTimer);
      window.removeEventListener("focus", onWinFocus);
      document.removeEventListener("keydown", onDocKey, true);
      wrapRef.current?.removeEventListener("contextmenu", onContextMenu);
      unlistenData?.();
      unlistenExit?.();
      unlistenNotify?.();
      if (sessionRef.current) invoke("kill_session", { sessionId: sessionRef.current }).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, agentId, cwd, resumeId, continueLatest]);

  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      if (focused) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, focused]);

  return (
    <>
      <div
        className="term-wrap"
        ref={wrapRef}
        style={{ display: visible ? "block" : "none" }}
        onClick={() => termRef.current?.focus()}
      />
      {termMenu && (
        <TerminalContextMenu menu={termMenu} onClose={() => setTermMenu(null)} />
      )}
    </>
  );
}

/** Normalise terminal-copied text for external pasting (Slack, email, docs, etc).
 *  - Replaces NBSP with regular space
 *  - Strips zero-width / BOM chars
 *  - Trims trailing whitespace per line
 *  - Detects the minimum leading indent across non-empty lines and removes it
 *    (kills the 2-3 space gutter Claude prints for code blocks and lists)
 *  - Collapses runs of 3+ blank lines to a single paragraph break
 */
function cleanTerminalText(s: string): string {
  s = s.replace(/ /g, " ");
  s = s.replace(/[​-‍﻿]/g, "");
  const lines = s.split("\n").map((l) => l.replace(/\s+$/, ""));
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    const minIndent = nonEmpty.reduce((m, l) => {
      const leading = l.match(/^(\s*)/)?.[1].length ?? 0;
      return Math.min(m, leading);
    }, Number.POSITIVE_INFINITY);
    if (Number.isFinite(minIndent) && minIndent > 0) {
      const pad = " ".repeat(minIndent);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(pad)) lines[i] = lines[i].slice(minIndent);
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

type TermMenuData =
  | { kind: "link"; x: number; y: number; uri: string; linkKind: "url" | "path" }
  | { kind: "selection"; x: number; y: number; text: string };

function TerminalContextMenu({ menu, onClose }: { menu: TermMenuData; onClose: () => void }) {
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(".link-ctx-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const writeClipboard = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    onClose();
  };

  const items: { label: string; onClick: () => void }[] = [];
  let preview = "";

  if (menu.kind === "link") {
    preview = menu.uri;
    items.push({
      label: `Open ${menu.linkKind === "url" ? "URL" : "path"}`,
      onClick: () => { invoke("open_path", { path: menu.uri }).catch(() => {}); onClose(); },
    });
    items.push({
      label: `Copy ${menu.linkKind === "url" ? "URL" : "path"}`,
      onClick: () => writeClipboard(menu.uri),
    });
  } else {
    // Selection menu — show a short preview of the selected text.
    const flat = menu.text.replace(/\s+/g, " ").trim();
    preview = flat.length > 60 ? flat.slice(0, 57) + "…" : flat;
    items.push({
      label: "Copy",
      onClick: () => writeClipboard(menu.text),
    });
    items.push({
      label: "Copy as plain text",
      onClick: () => writeClipboard(cleanTerminalText(menu.text)),
    });
  }

  // Clamp to viewport so the menu never falls off the edge.
  const W = 220;
  const H = 40 + items.length * 30 + (preview ? 28 : 0);
  const px = Math.min(menu.x, window.innerWidth - W - 8);
  const py = Math.min(menu.y, window.innerHeight - H - 8);

  return (
    <div className="link-ctx-menu" style={{ left: px, top: py, width: W }}>
      {preview && <div className="link-ctx-preview" title={menu.kind === "link" ? menu.uri : menu.text}>{preview}</div>}
      {items.map((it, i) => (
        <button key={i} className="link-ctx-item" onClick={it.onClick}>{it.label}</button>
      ))}
    </div>
  );
}
