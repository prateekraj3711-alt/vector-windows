import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ChangeEntry = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

type Changes = {
  uncommitted: ChangeEntry[];
  committed: ChangeEntry[];
  base_ref: string;
};

export type ChangesViewMode = "flat" | "tree";

type Props = {
  worktreePath: string;
  viewMode: ChangesViewMode;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
  activePath?: string | null;
};

export function WorktreeChanges({ worktreePath, viewMode, onOpenPreview, activePath }: Props) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChanges(null);
    setError(null);
    invoke<Changes>("worktree_changes", { worktree: worktreePath, baseRef: null })
      .then((c) => { if (!cancelled) setChanges(c); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { message?: string };
        setError(String(err?.message ?? e));
      });
    return () => { cancelled = true; };
  }, [worktreePath]);

  if (error) {
    return <div className="wt-changes-error">{error}</div>;
  }
  if (changes === null) {
    return <div className="wt-changes-loading">Loading…</div>;
  }
  if (changes.uncommitted.length === 0 && changes.committed.length === 0) {
    return <div className="wt-changes-empty">No changes</div>;
  }

  const openDiff = (relPath: string, mode: "head" | "base") => {
    if (!onOpenPreview) return;
    const absPath = `${worktreePath}/${relPath}`;
    if (mode === "head") {
      onOpenPreview(absPath, undefined, undefined, { pin: false, mode: "diff" });
    } else {
      onOpenPreview(absPath, undefined, undefined, { pin: false, mode: "diff", baseRef: changes.base_ref });
    }
  };

  // Compute the relative path of the active preview (if it lives inside this
  // worktree) so each row can compare its rel path and apply the active class.
  const activeRel = activePath && activePath.startsWith(worktreePath + "/")
    ? activePath.slice(worktreePath.length + 1)
    : null;

  return (
    <div className="wt-changes" onMouseDown={(e) => e.preventDefault()}>
      {changes.uncommitted.length > 0 && (
        <Section
          title="Uncommitted"
          count={changes.uncommitted.length}
          entries={changes.uncommitted}
          viewMode={viewMode}
          onClick={(rel) => openDiff(rel, "head")}
          activeRel={activeRel}
        />
      )}
      {changes.committed.length > 0 && (
        <Section
          title={`Committed (vs ${shortRef(changes.base_ref)})`}
          count={changes.committed.length}
          entries={changes.committed}
          viewMode={viewMode}
          onClick={(rel) => openDiff(rel, "base")}
          activeRel={activeRel}
        />
      )}
    </div>
  );
}

function Section({
  title,
  count,
  entries,
  viewMode,
  onClick,
  activeRel,
}: {
  title: string;
  count: number;
  entries: ChangeEntry[];
  viewMode: ChangesViewMode;
  onClick: (path: string) => void;
  activeRel: string | null;
}) {
  return (
    <div className="wt-changes-section">
      <div className="wt-changes-section-header">
        <span>{title}</span>
        <span className="wt-changes-count">{count}</span>
      </div>
      {viewMode === "flat" ? (
        entries.map((e) => (
          <ChangeRow
            key={e.path}
            entry={e}
            onClick={() => onClick(e.path)}
            isActive={activeRel === e.path}
          />
        ))
      ) : (
        <TreeView entries={entries} onClick={onClick} activeRel={activeRel} />
      )}
    </div>
  );
}

// ─── Flat row ─────────────────────────────────────────────────────────────────

function ChangeRow({ entry, onClick, isActive }: { entry: ChangeEntry; onClick: () => void; isActive: boolean }) {
  const fileName = entry.path.split("/").pop() ?? entry.path;
  const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  return (
    <div
      className={`wt-change-row${isActive ? " wt-change-row-active" : ""}`}
      onMouseDown={(e) => { if (e.button !== 0) e.preventDefault(); }}
      onClick={onClick}
      title={entry.path}
    >
      <span className={`wt-change-status wt-change-status-${entry.status.trim() || "?"}`}>{statusLabel(entry.status)}</span>
      <span className="wt-change-name">{fileName}</span>
      {dir && <span className="wt-change-dir">{dir}</span>}
      {(entry.additions !== null || entry.deletions !== null) && (
        <span className="wt-change-counts">
          {entry.additions !== null && <span className="wt-change-add">+{entry.additions}</span>}
          {entry.deletions !== null && <span className="wt-change-del">-{entry.deletions}</span>}
        </span>
      )}
    </div>
  );
}

// ─── Tree view ────────────────────────────────────────────────────────────────

type TreeNode = {
  name: string;
  // For files: full relative path + entry. For folders: undefined.
  fullPath?: string;
  entry?: ChangeEntry;
  children: Map<string, TreeNode>;
};

function buildTree(entries: ChangeEntry[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (isLeaf) {
        child.fullPath = entry.path;
        child.entry = entry;
      }
      node = child;
    }
  }
  // Collapse single-child folder chains: e.g. src > preview > foo.tsx becomes
  // "src/preview" > foo.tsx when "src" only contains "preview" which only
  // contains files. Match a common GitHub PR-tree heuristic.
  collapseSingleChildren(root);
  return root;
}

function collapseSingleChildren(node: TreeNode): void {
  for (const [key, child] of node.children) {
    collapseSingleChildren(child);
    // Only collapse if child is a folder with a single child that is also a folder.
    if (!child.entry && child.children.size === 1) {
      const [[grandKey, grand]] = [...child.children.entries()];
      if (!grand.entry) {
        node.children.delete(key);
        const merged: TreeNode = {
          name: `${child.name}/${grand.name}`,
          children: grand.children,
        };
        node.children.set(`${key}/${grandKey}`, merged);
      }
    }
  }
}

function TreeView({
  entries, onClick, activeRel,
}: { entries: ChangeEntry[]; onClick: (path: string) => void; activeRel: string | null }) {
  const root = buildTree(entries);
  const sorted = sortChildren(root);
  return (
    <>
      {sorted.map((child) => (
        <TreeBranch key={child.name} node={child} depth={0} onClick={onClick} activeRel={activeRel} />
      ))}
    </>
  );
}

function sortChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aIsFolder = !a.entry;
    const bIsFolder = !b.entry;
    if (aIsFolder && !bIsFolder) return -1;
    if (!aIsFolder && bIsFolder) return 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeBranch({
  node, depth, onClick, activeRel,
}: { node: TreeNode; depth: number; onClick: (path: string) => void; activeRel: string | null }) {
  const indent = 8 + depth * 12;
  if (node.entry) {
    const e = node.entry;
    const isActive = activeRel === e.path;
    return (
      <div
        className={`wt-change-row${isActive ? " wt-change-row-active" : ""}`}
        style={{ paddingLeft: indent }}
        onMouseDown={(ev) => { if (ev.button !== 0) ev.preventDefault(); }}
        onClick={() => onClick(e.path)}
        title={e.path}
      >
        <span className={`wt-change-status wt-change-status-${e.status.trim() || "?"}`}>{statusLabel(e.status)}</span>
        <span className="wt-change-name">{node.name}</span>
        {(e.additions !== null || e.deletions !== null) && (
          <span className="wt-change-counts">
            {e.additions !== null && <span className="wt-change-add">+{e.additions}</span>}
            {e.deletions !== null && <span className="wt-change-del">-{e.deletions}</span>}
          </span>
        )}
      </div>
    );
  }
  // Folder row + children
  const children = sortChildren(node);
  return (
    <>
      <div className="wt-change-folder" style={{ paddingLeft: indent }} title={node.name}>
        <span className="wt-change-folder-icon">▾</span>
        <span className="wt-change-folder-name">{node.name}</span>
      </div>
      {children.map((c) => (
        <TreeBranch key={c.name} node={c} depth={depth + 1} onClick={onClick} activeRel={activeRel} />
      ))}
    </>
  );
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusLabel(s: string): string {
  const code = s.trim();
  if (code === "??") return "U";
  if (!code) return "?";
  return code.charAt(0).toUpperCase();
}

function shortRef(ref: string): string {
  return ref.length > 24 ? ref.slice(0, 24) + "…" : ref;
}
