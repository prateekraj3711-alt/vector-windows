import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import logoUrl from "./logo.png";

type AgentMeta = { id: string; label: string; available: boolean };

type PaneLeaf = {
  kind: "leaf";
  id: string;
  agentId: string;
  cwd: string;
  resumeId?: string;
  continueLatest?: boolean;
  epoch: number;
};
type PaneSplit = {
  kind: "split";
  id: string;
  direction: "row" | "column";
  children: [PaneNode, PaneNode];
  ratio: number;
};
type PaneNode = PaneLeaf | PaneSplit;
type Tab = { id: string; root: PaneNode; activePaneId: string };

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
  if (raw && raw.root) return raw as Tab;
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
  return { id: raw?.id ?? crypto.randomUUID(), root: leaf, activePaneId: paneId };
}
type SessionSummary = { id: string; agentId: string; title: string; modifiedMs: number; messageCount: number };
type PreviewMessage = { role: string; kind: "text" | "system"; label?: string; text: string };
type SessionDetail = { id: string; agentId: string; title: string; modifiedMs: number; messages: PreviewMessage[] };
type Theme = "dark" | "light";
type Orientation = "horizontal" | "vertical";
type PickerState = { open: boolean; forTabId?: string };

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
  const [theme, setTheme] = useState<Theme>(() => loadPref<Theme>("vector.theme", "dark"));
  const [orientation, setOrientation] = useState<Orientation>(() => loadPref<Orientation>("vector.orientation", "horizontal"));
  const [bellTabs, setBellTabs] = useState<Set<string>>(new Set());
  const [tabTitles, setTabTitles] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState>({ open: true });
  const tabsLoaded = useRef(false);
  const activeIdRef = useRef("");
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const dragFromRef = useRef<number | null>(null);
  type DndPayload = { kind: "pane"; fromTabId: string; paneId: string } | { kind: "tab"; tabId: string };
  const dndRef = useRef<DndPayload | null>(null);
  const getDnd = useCallback(() => dndRef.current, []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
  const notifReady = useRef(false);

  useEffect(() => { document.body.className = theme === "light" ? "theme-light" : "theme-dark"; try { localStorage.setItem("vector.theme", theme); } catch {} }, [theme]);
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
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
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
    setTabTitles((m) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n; });
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

  const onTitle = useCallback((tabId: string, title: string) => {
    setTabTitles((m) => (m[tabId] === title ? m : { ...m, [tabId]: title }));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setBellTabs((b) => { if (!b.has(activeId)) return b; const n = new Set(b); n.delete(activeId); return n; });
  }, [activeId]);

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
  const xtermTheme = theme === "light" ? lightTheme : darkTheme;

  const tabBar = (
    <div
      className="tabs-container"
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
    >
      <div className="tabs">
        {tabs.map((t, i) => {
          const activeLeaf = findLeaf(t.root, t.activePaneId);
          const tabAgentId = activeLeaf?.agentId ?? "__shell__";
          const tabCwd = activeLeaf?.cwd ?? "";
          const agent = agents.find((a) => a.id === tabAgentId);
          const agentLabel = agent?.label ?? (tabAgentId === "__shell__" ? "shell" : tabAgentId);
          const rawTitle = tabTitles[t.id] || "";
          const stripped = rawTitle
            .replace(new RegExp(`^\\s*${agentLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[–—\\-:·|·]?\\s*`, "i"), "")
            .trim();
          const title = stripped || basename(tabCwd);
          const classes = ["tab"];
          if (t.id === activeId) classes.push("active");
          if (bellTabs.has(t.id)) classes.push("bell");
          return (
            <div
              key={t.id}
              className={classes.join(" ")}
              onClick={() => setActiveId(t.id)}
              title={`⌘${i + 1} · ${agentLabel} · ${tabCwd}`}
              draggable
              onDragStart={(e) => {
                dragFromRef.current = i;
                dndRef.current = { kind: "tab", tabId: t.id };
                // Some webviews require dataTransfer data for drop events to fire.
                e.dataTransfer.effectAllowed = "move";
                try { e.dataTransfer.setData("text/plain", String(i)); } catch {}
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFromRef.current;
                dragFromRef.current = null;
                if (from != null) moveTab(from, i);
              }}
              onDragEnd={() => { dragFromRef.current = null; dndRef.current = null; }}
            >
              <span className="agent-chip"><AgentIcon id={tabAgentId} size={14} /></span>
              <span className="tab-label">{title}</span>
              {(() => { const n = allLeafIds(t.root).length; return n > 1 ? <span className="tab-pane-count">{n}</span> : null; })()}
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

  return (
    <>
      {update && (
        <div className="update-banner">
          <div className="update-row">
            <span>Vector {update.version} is available.</span>
            {update.body && (
              <details className="update-notes">
                <summary>What’s new</summary>
                <pre className="update-notes-body">{update.body}</pre>
              </details>
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
        <div className="settings">
          <button className="icon-btn" onClick={() => { setShortcutsOpen((o) => !o); setSettingsOpen(false); }} title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
            <KeyboardIcon />
          </button>
          {shortcutsOpen && (
            <div className="settings-panel shortcuts-panel" onMouseLeave={() => setShortcutsOpen(false)}>
              <div className="shortcuts-title">Keyboard shortcuts</div>
              <div className="shortcuts-list">
                <Shortcut keys="⌘ + T" label="New tab" />
                <Shortcut keys="⌘ + W" label="Close active pane" />
                <Shortcut keys="⌘ + D" label="Split pane right" />
                <Shortcut keys="⌘ + ⇧ + D" label="Split pane down" />
                <Shortcut keys="⌘ + ⌥ + arrow" label="Focus adjacent pane" />
                <Shortcut keys="⌘ + ⇧ + R" label="Reload active pane" />
                <Shortcut keys="⌘ + 1–9" label="Switch tab" />
                <Shortcut keys="Ctrl + Tab" label="Next tab" />
                <Shortcut keys="Ctrl + ⇧ + Tab" label="Previous tab" />
                <Shortcut keys="⇧ + Enter" label="Multi-line input (Claude Code)" />
              </div>
            </div>
          )}
          <button className="icon-btn" onClick={() => { setSettingsOpen((o) => !o); setShortcutsOpen(false); }} title="Settings" aria-label="Settings">
            <GearIcon />
          </button>
          {settingsOpen && (
            <div className="settings-panel" onMouseLeave={() => setSettingsOpen(false)}>
              <div className="settings-row">
                <span>Theme</span>
                <div className="seg">
                  <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>Dark</button>
                  <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>Light</button>
                </div>
              </div>
              <div className="settings-row">
                <span>Tabs</span>
                <div className="seg">
                  <button className={orientation === "horizontal" ? "on" : ""} onClick={() => setOrientation("horizontal")}>Top</button>
                  <button className={orientation === "vertical" ? "on" : ""} onClick={() => setOrientation("vertical")}>Side</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
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

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="shortcut-row">
      <span className="shortcut-keys">{keys}</span>
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
                  <div className="session-title">{s.title || "(untitled)"}</div>
                  <div className="session-meta">
                    <span title={new Date(s.modifiedMs).toLocaleString()}>{relativeTime(s.modifiedMs)}</span>
                    {s.messageCount > 0 && <span>· {s.messageCount} messages</span>}
                  </div>
                </button>
              )))}
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
                  {preview.messages.slice(-30).map((m, i) =>
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

type PaneViewProps = {
  tabId: string;
  root: PaneNode;
  activePaneId: string;
  tabVisible: boolean;
  theme: ITheme;
  onFocusPane: (paneId: string) => void;
  onBell: (tabId: string, paneId: string) => void;
  onTitle: (tabId: string, title: string) => void;
  onExitPane: (paneId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
  onPaneDragStart: (paneId: string) => void;
  onPaneDragEnd: () => void;
  onPaneDrop: (targetPaneId: string, edge: "left" | "right" | "top" | "bottom") => void;
  getDndKind: () => "pane" | "tab" | null;
  getDndPaneId: () => string | null;
};

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
  const { tabId, root, activePaneId, tabVisible, theme, onFocusPane, onBell, onTitle, onExitPane, onResize, onPaneDragStart, onPaneDragEnd, onPaneDrop, getDndKind, getDndPaneId } = props;
  const leaves = flattenLeaves(root);
  const rects = leafRects(root, [0, 0, 1, 1]);
  const dividers = computeDividers(root, [0, 0, 1, 1]);
  const rectFor = (id: string) => rects.find((r) => r.id === id)!.rect;
  const showClose = leaves.length > 1;
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
            <div
              className="pane-grip"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                try { e.dataTransfer.setData("text/plain", "pane"); } catch {}
                onPaneDragStart(leaf.id);
              }}
              onDragEnd={() => onPaneDragEnd()}
              onMouseDown={(e) => e.stopPropagation()}
              title="Drag to move pane"
              aria-label="Drag pane"
            >⋮⋮</div>
            <TerminalView
              key={`${leaf.id}-${leaf.epoch}`}
              tabId={tabId}
              paneId={leaf.id}
              agentId={leaf.agentId}
              cwd={leaf.cwd}
              resumeId={leaf.resumeId}
              continueLatest={leaf.continueLatest}
              visible={tabVisible}
              focused={isActive}
              theme={theme}
              onBell={onBell}
              onTitle={onTitle}
              onExit={() => onExitPane(leaf.id)}
            />
            {showClose && (
              <button
                className="pane-close"
                onClick={(e) => { e.stopPropagation(); onExitPane(leaf.id); }}
                title="Close pane (⌘W)"
                aria-label="Close pane"
              >×</button>
            )}
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
  visible,
  focused,
  theme,
  onBell,
  onTitle,
  onExit,
}: {
  tabId: string;
  paneId: string;
  agentId: string;
  cwd: string;
  resumeId?: string;
  continueLatest?: boolean;
  visible: boolean;
  focused: boolean;
  theme: ITheme;
  onBell: (tabId: string, paneId: string) => void;
  onTitle: (tabId: string, title: string) => void;
  onExit: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const focusedRef = useRef(focused);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = theme; }, [theme]);

  useEffect(() => {
    if (!wrapRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(wrapRef.current);
    termRef.current = term;
    fitRef.current = fit;
    term.onBell(() => onBell(tabId, paneId));
    term.onTitleChange((t) => { if (t) onTitle(tabId, t); });

    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) return false;
      return true;
    });

    // Document-capture: intercept Shift+Enter before the webview/xterm handle it
    // and send ESC+CR (the sequence Claude Code's /terminal-setup maps to multi-line).
    const onDocKey = (e: KeyboardEvent) => {
      if (e.type !== "keydown") return;
      if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!wrapRef.current || wrapRef.current.style.display === "none") return;
      if (!wrapRef.current.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      invoke("write_stdin", { sessionId, data: "\x1b\r" }).catch(() => {});
    };
    document.addEventListener("keydown", onDocKey, true);

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;
    let started = false;
    let fontsReady = false;
    let lastCols = -1, lastRows = -1, stableCount = 0;

    const doStart = async () => {
      started = true;
      try { fit.fit(); } catch {}
      const cols = term.cols || 100;
      const rows = term.rows || 30;
      try {
        await invoke("start_session", { sessionId, agentId, cols, rows, cwd, resumeId: resumeId ?? null, continueLatest: continueLatest ?? false });
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
      try { fit.fit(); } catch {}
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
      unlistenData?.();
      unlistenExit?.();
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
    <div
      className="term-wrap"
      ref={wrapRef}
      style={{ display: visible ? "block" : "none" }}
      onClick={() => termRef.current?.focus()}
    />
  );
}
