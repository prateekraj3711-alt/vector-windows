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
  onChangeViewMode: (m: ChangesViewMode) => void;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
};

export function WorktreeChanges({ worktreePath, viewMode, onChangeViewMode, onOpenPreview }: Props) {
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

  return (
    <div className="wt-changes" onMouseDown={(e) => e.preventDefault()}>
      <div className="wt-changes-toolbar">
        <button
          className={`wt-changes-view-btn${viewMode === "flat" ? " active" : ""}`}
          onClick={() => onChangeViewMode("flat")}
          title="Flat list"
          aria-label="Flat list"
        ><FlatIcon /></button>
        <button
          className={`wt-changes-view-btn${viewMode === "tree" ? " active" : ""}`}
          onClick={() => onChangeViewMode("tree")}
          title="Tree view"
          aria-label="Tree view"
        ><TreeIcon /></button>
      </div>
      {changes.uncommitted.length > 0 && (
        <Section
          title="Uncommitted"
          count={changes.uncommitted.length}
          entries={changes.uncommitted}
          viewMode={viewMode}
          onClick={(rel) => openDiff(rel, "head")}
        />
      )}
      {changes.committed.length > 0 && (
        <Section
          title={`Committed (vs ${shortRef(changes.base_ref)})`}
          count={changes.committed.length}
          entries={changes.committed}
          viewMode={viewMode}
          onClick={(rel) => openDiff(rel, "base")}
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
}: {
  title: string;
  count: number;
  entries: ChangeEntry[];
  viewMode: ChangesViewMode;
  onClick: (path: string) => void;
}) {
  return (
    <div className="wt-changes-section">
      <div className="wt-changes-section-header">
        <span>{title}</span>
        <span className="wt-changes-count">{count}</span>
      </div>
      {viewMode === "flat" ? (
        entries.map((e) => (
          <ChangeRow key={e.path} entry={e} onClick={() => onClick(e.path)} />
        ))
      ) : (
        <TreeView entries={entries} onClick={onClick} />
      )}
    </div>
  );
}

// ─── Flat row ─────────────────────────────────────────────────────────────────

function ChangeRow({ entry, onClick }: { entry: ChangeEntry; onClick: () => void }) {
  const fileName = entry.path.split("/").pop() ?? entry.path;
  const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  return (
    <div className="wt-change-row" onClick={onClick} title={entry.path}>
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

function TreeView({ entries, onClick }: { entries: ChangeEntry[]; onClick: (path: string) => void }) {
  const root = buildTree(entries);
  const sorted = sortChildren(root);
  return (
    <>
      {sorted.map((child) => (
        <TreeBranch key={child.name} node={child} depth={0} onClick={onClick} />
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
  node, depth, onClick,
}: { node: TreeNode; depth: number; onClick: (path: string) => void }) {
  const indent = 8 + depth * 12;
  if (node.entry) {
    const e = node.entry;
    return (
      <div
        className="wt-change-row"
        style={{ paddingLeft: indent }}
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
        <TreeBranch key={c.name} node={c} depth={depth + 1} onClick={onClick} />
      ))}
    </>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

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
