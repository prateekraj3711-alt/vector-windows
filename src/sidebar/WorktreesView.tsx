import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

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
};

export function WorktreesView({ projectRoot, sessionId }: Props) {
  const [groups, setGroups] = useState<RepoGroup[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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

  return (
    <div className="wt-view">
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
      </div>
      {filteredGroups.length === 0 && q && (
        <div className="wt-empty">No worktrees match "{query}"</div>
      )}
      {filteredGroups.map((g) => (
        <div key={g.repo} className="wt-group">
          <div className="wt-group-header" title={g.repo}>
            <span className="wt-group-name">{basename(g.repo)}</span>
            <span className="wt-group-count">
              {q ? `${g.visibleWts.length}/${g.worktrees.length}` : g.worktrees.length}
            </span>
          </div>
          {g.error && (
            <div className="wt-group-error" title={g.error}>{g.error}</div>
          )}
          {g.visibleWts.map((w) => (
            <WorktreeRow
              key={w.path}
              worktree={w}
              isExpanded={expanded.has(w.path)}
              onToggle={() => toggle(expanded, setExpanded, w.path)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function WorktreeRow({
  worktree,
  isExpanded,
  onToggle,
}: {
  worktree: WorktreeInfo;
  isExpanded: boolean;
  onToggle: () => void;
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
        title={worktree.path}
      >
        <span className="wt-row-chevron">{isExpanded ? "▾" : "▸"}</span>
        <span className="wt-row-branch">{branchLabel}</span>
        {showSuffix && <span className="wt-row-suffix">{dirName}</span>}
        {worktree.is_main && <span className="wt-row-main-badge">main</span>}
      </div>
      {isExpanded && (
        <div
          className="wt-row-changes-placeholder"
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: "6px 0", color: "var(--muted)", fontSize: 11 }}>
            Changes coming in E3…
          </div>
        </div>
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
