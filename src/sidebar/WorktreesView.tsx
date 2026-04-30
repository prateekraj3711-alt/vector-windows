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
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [showAllByRepo, setShowAllByRepo] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const projectRootRef = useRef(projectRoot);
  const sessionIdRef = useRef(sessionId);
  projectRootRef.current = projectRoot;
  sessionIdRef.current = sessionId;

  const refresh = async () => {
    const root = projectRootRef.current;
    const sid = sessionIdRef.current;
    if (!root) {
      setGroups([]);
      setLinked(new Set());
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

      if (sid) {
        try {
          const linkedList = await invoke<string[]>("list_linked_worktrees", {
            sessionId: sid,
            projectRoot: root,
          });
          setLinked(new Set(linkedList));
        } catch {
          // Linked detection failure is non-fatal — render everything as unlinked.
          setLinked(new Set());
        }
      } else {
        setLinked(new Set());
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(String(err?.message ?? e));
    }
  };

  useEffect(() => {
    setGroups(null);
    setLinked(new Set());
    setExpanded(new Set());
    setShowAllByRepo(new Set());
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

  return (
    <div className="wt-view">
      {groups.map((g) => {
        const linkedWts = g.worktrees.filter((w) => linked.has(w.path));
        const unlinkedWts = g.worktrees.filter((w) => !linked.has(w.path));
        const showAll = showAllByRepo.has(g.repo);

        return (
          <div key={g.repo} className="wt-group">
            <div className="wt-group-header" title={g.repo}>
              <span className="wt-group-name">{basename(g.repo)}</span>
              <span className="wt-group-count">{g.worktrees.length}</span>
            </div>
            {g.error && (
              <div className="wt-group-error" title={g.error}>{g.error}</div>
            )}
            {linkedWts.length === 0 && unlinkedWts.length > 0 && !showAll && (
              <div className="wt-empty-linked">No linked worktrees</div>
            )}
            {linkedWts.map((w) => (
              <WorktreeRow
                key={w.path}
                worktree={w}
                projectRoot={projectRoot}
                isLinked
                isExpanded={expanded.has(w.path)}
                onToggle={() => toggle(expanded, setExpanded, w.path)}
              />
            ))}
            {unlinkedWts.length > 0 && (
              <button
                className="wt-show-all"
                onClick={() => toggle(showAllByRepo, setShowAllByRepo, g.repo)}
              >
                {showAll ? "Hide" : `Show all (${unlinkedWts.length})`}
              </button>
            )}
            {showAll &&
              unlinkedWts.map((w) => (
                <WorktreeRow
                  key={w.path}
                  worktree={w}
                  projectRoot={projectRoot}
                  isLinked={false}
                  isExpanded={expanded.has(w.path)}
                  onToggle={() => toggle(expanded, setExpanded, w.path)}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function WorktreeRow({
  worktree,
  isLinked,
  isExpanded,
  onToggle,
}: {
  worktree: WorktreeInfo;
  projectRoot: string;
  isLinked: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const branchLabel = worktree.branch ?? `(detached ${worktree.head.slice(0, 7)})`;
  const dirName = basename(worktree.path);
  const showSuffix = worktree.branch && dirName !== worktree.branch;

  return (
    <>
      <div
        className={`wt-row${isLinked ? " wt-row-linked" : " wt-row-unlinked"}${isExpanded ? " wt-row-expanded" : ""}`}
        onClick={onToggle}
        title={worktree.path}
      >
        <span className="wt-row-chevron">{isExpanded ? "▾" : "▸"}</span>
        {isLinked && <span className="wt-row-dot" aria-hidden="true" />}
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
