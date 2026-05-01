import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { WorktreeChanges, type ChangesViewMode } from "./WorktreeChanges";
import { FileContextMenu, makeWorktreeMenuItems, EditorInfo } from "./contextMenu";

type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string;
  is_main: boolean;
};

type RepoGroup = {
  repo: string;
  worktrees: WorktreeInfo[];
  error: string | null;
};

type Props = {
  projectRoot: string | null;
  sessionId: string | null;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
  changesView: ChangesViewMode;
  onChangesView: (m: ChangesViewMode) => void;
  activePath: string | null;
};

export function WorktreesView({ projectRoot, sessionId, onOpenPreview, changesView, onChangesView, activePath }: Props) {
  const [groups, setGroups] = useState<RepoGroup[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; worktreePath: string } | null>(null);

  useEffect(() => {
    invoke<EditorInfo[]>("installed_editors")
      .then(setEditors)
      .catch(() => setEditors([]));
  }, []);

  const projectRootRef = useRef(projectRoot);
  const sessionIdRef = useRef(sessionId);
  projectRootRef.current = projectRoot;
  sessionIdRef.current = sessionId;

  const refresh = async () => {
    const root = projectRootRef.current;
    if (!root) {
      setGroups([]);
      return;
    }
    setError(null);
    try {
      const repos = await invoke<string[]>("list_repos_in_project", { root });
      // Per-repo isolation: a broken repo (corrupted worktree metadata, missing
      // refs, etc.) should not poison the whole view. Catch each invoke
      // individually and surface the error on its group.
      const groupResults = await Promise.all(
        repos.map(async (repo): Promise<RepoGroup> => {
          try {
            const worktrees = await invoke<WorktreeInfo[]>("list_worktrees_for_repo", { repo });
            return { repo, worktrees, error: null };
          } catch (e: unknown) {
            const err = e as { message?: string };
            return { repo, worktrees: [], error: String(err?.message ?? e) };
          }
        }),
      );
      groupResults.sort((a, b) => basename(a.repo).localeCompare(basename(b.repo)));
      setGroups(groupResults);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(String(err?.message ?? e));
    }
  };

  useEffect(() => {
    setGroups(null);
    setExpanded(new Set());
    void refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sessionId]);

  // Refresh on fs-changed events that touch a .git path
  useEffect(() => {
    if (!sessionId) return;
    let un: UnlistenFn | undefined;
    listen<{ paths: string[] }>(`fs-changed-${sessionId}`, (ev) => {
      const triggers = ev.payload.paths.some(
        (p) => p.includes("/.git/") || p.endsWith("/.git"),
      );
      if (triggers) {
        void refresh();
      }
    }).then((u) => {
      un = u;
    });
    return () => {
      if (un) un();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectRoot]);

  if (!projectRoot) {
    return <div className="wt-empty">Open a project to see worktrees.</div>;
  }
  if (error) {
    return <div className="wt-error">{error}</div>;
  }
  if (groups === null) {
    return <div className="wt-loading">Loading…</div>;
  }
  if (groups.length === 0) {
    return <div className="wt-empty">No git repos found in this project.</div>;
  }

  const q = query.trim().toLowerCase();
  const matches = (w: WorktreeInfo) => {
    if (!q) return true;
    const branch = (w.branch ?? "").toLowerCase();
    const dir = basename(w.path).toLowerCase();
    return branch.includes(q) || dir.includes(q);
  };

  const filteredGroups = groups
    .map((g) => {
      const sortedWts = [...g.worktrees].sort((a, b) => {
        if (a.is_main && !b.is_main) return -1;
        if (!a.is_main && b.is_main) return 1;
        const an = a.branch ?? basename(a.path);
        const bn = b.branch ?? basename(b.path);
        return an.localeCompare(bn);
      });
      const visibleWts = q ? sortedWts.filter(matches) : sortedWts;
      return { ...g, sortedWts, visibleWts };
    })
    // Hide repo groups with no visible worktrees AND no error to surface.
    .filter((g) => g.visibleWts.length > 0 || g.error);

  const onRowContextMenu = (e: React.MouseEvent, worktreePath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, worktreePath });
  };

  return (
    <div className="wt-view">
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          items={makeWorktreeMenuItems(menu.worktreePath, editors)}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="wt-search">
        <input
          className="wt-search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search worktrees…"
          spellCheck={false}
          autoComplete="off"
        />
        {query && (
          <button
            className="wt-search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            title="Clear"
          >×</button>
        )}
        <div className="wt-search-views">
          <button
            className={`wt-changes-view-btn${changesView === "flat" ? " active" : ""}`}
            onClick={() => onChangesView("flat")}
            title="Flat list"
            aria-label="Flat list"
          ><FlatIcon /></button>
          <button
            className={`wt-changes-view-btn${changesView === "tree" ? " active" : ""}`}
            onClick={() => onChangesView("tree")}
            title="Tree view"
            aria-label="Tree view"
          ><TreeIcon /></button>
        </div>
      </div>
      {filteredGroups.length === 0 && q && (
        <div className="wt-empty">No worktrees match "{query}"</div>
      )}
      {filteredGroups.map((g) => {
        // Active query forces all groups expanded so matches are visible.
        const isOpen = q ? true : expandedRepos.has(g.repo);
        return (
          <div key={g.repo} className="wt-group">
            <div
              className="wt-group-header"
              title={g.repo}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(expandedRepos, setExpandedRepos, g.repo)}
            >
              <span className="wt-group-name">{basename(g.repo)}</span>
              <span className="wt-group-count">
                {q ? `${g.visibleWts.length}/${g.worktrees.length}` : g.worktrees.length}
              </span>
            </div>
            {isOpen && g.error && (
              <div className="wt-group-error" title={g.error}>{g.error}</div>
            )}
            {isOpen && g.visibleWts.map((w) => (
              <WorktreeRow
                key={w.path}
                worktree={w}
                isExpanded={expanded.has(w.path)}
                onToggle={() => toggle(expanded, setExpanded, w.path)}
                onOpenPreview={onOpenPreview}
                onContextMenu={(e) => onRowContextMenu(e, w.path)}
                changesView={changesView}
                activePath={activePath}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function FlatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="14" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function WorktreeRow({
  worktree,
  isExpanded,
  onToggle,
  onOpenPreview,
  onContextMenu,
  changesView,
  activePath,
}: {
  worktree: WorktreeInfo;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  changesView: ChangesViewMode;
  activePath: string | null;
}) {
  const branchLabel = worktree.branch ?? `(detached ${worktree.head.slice(0, 7)})`;
  const dirName = basename(worktree.path);
  const showSuffix = worktree.branch && dirName !== worktree.branch;

  return (
    <>
      <div
        className={`wt-row${isExpanded ? " wt-row-expanded" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        onContextMenu={onContextMenu}
        title={worktree.path}
      >
        <span className="wt-row-chevron">{isExpanded ? "▾" : "▸"}</span>
        <span className="wt-row-branch">{branchLabel}</span>
        {showSuffix && <span className="wt-row-suffix">{dirName}</span>}
        {worktree.is_main && <span className="wt-row-main-badge">main</span>}
      </div>
      {isExpanded && (
        <WorktreeChanges
          worktreePath={worktree.path}
          viewMode={changesView}
          onOpenPreview={onOpenPreview}
          activePath={activePath}
        />
      )}
    </>
  );
}

function toggle<T>(set: Set<T>, setter: (s: Set<T>) => void, key: T) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setter(next);
}

function basename(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
