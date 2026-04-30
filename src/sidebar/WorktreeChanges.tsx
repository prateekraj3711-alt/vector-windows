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

type Props = {
  worktreePath: string;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
};

export function WorktreeChanges({ worktreePath, onOpenPreview }: Props) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChanges(null);
    setError(null);
    // Tauri converts snake_case param names to camelCase for JS invoke:
    // `base_ref: Option<String>` → invoke key `baseRef`
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
      {changes.uncommitted.length > 0 && (
        <Section
          title="Uncommitted"
          count={changes.uncommitted.length}
          entries={changes.uncommitted}
          onClick={(rel) => openDiff(rel, "head")}
        />
      )}
      {changes.committed.length > 0 && (
        <Section
          title={`Committed (vs ${shortRef(changes.base_ref)})`}
          count={changes.committed.length}
          entries={changes.committed}
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
  onClick,
}: {
  title: string;
  count: number;
  entries: ChangeEntry[];
  onClick: (path: string) => void;
}) {
  return (
    <div className="wt-changes-section">
      <div className="wt-changes-section-header">
        <span>{title}</span>
        <span className="wt-changes-count">{count}</span>
      </div>
      {entries.map((e) => (
        <ChangeRow key={e.path} entry={e} onClick={() => onClick(e.path)} />
      ))}
    </div>
  );
}

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

function statusLabel(s: string): string {
  const code = s.trim();
  if (code === "??") return "U";
  if (!code) return "?";
  return code.charAt(0).toUpperCase();
}

function shortRef(ref: string): string {
  return ref.length > 24 ? ref.slice(0, 24) + "…" : ref;
}
