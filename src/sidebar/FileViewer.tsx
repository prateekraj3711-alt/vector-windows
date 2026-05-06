import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileIcon } from "./fileIcons";
import { FileContextMenu, makeFileMenuItems } from "./contextMenu";

type DirEntry = { name: string; path: string; is_dir: boolean };

type Props = {
  projectRoot: string | null;
  showHidden: boolean;
  sessionId: string | null;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
  activePath?: string | null;
};

type NodeState = {
  expanded: boolean;
  children: DirEntry[] | null; // null = not yet loaded
  loading: boolean;
  error: string | null;
};

function chevron(expanded: boolean) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="currentColor"
      aria-hidden="true"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.1s" }}
    >
      <path d="M2 1l4 3-4 3V1z" />
    </svg>
  );
}

export function FileViewer({ projectRoot, showHidden, sessionId, onOpenPreview, activePath }: Props) {
  // Map<path, NodeState> for every expanded or loading folder
  const nodeStateRef = useRef<Map<string, NodeState>>(new Map());
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  // Root-level entries
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  // Context menu state
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);

  const onRowContextMenu = useCallback((e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Track which paths are expanded (for fs-event refresh)
  const expandedRef = useRef<Set<string>>(new Set());

  // Clear all state when root or showHidden changes
  useEffect(() => {
    nodeStateRef.current = new Map();
    expandedRef.current = new Set();
    setRootEntries(null);
    setRootError(null);

    if (!projectRoot) return;

    setRootLoading(true);
    invoke<DirEntry[]>("list_dir", { path: projectRoot, showHidden })
      .then((entries) => {
        setRootEntries(entries);
        setRootLoading(false);
      })
      .catch((e) => {
        setRootError(String(e));
        setRootLoading(false);
      });
  }, [projectRoot, showHidden]);

  // Subscribe to fs-changed events; refresh any expanded folder that is an ancestor
  // of any changed path.
  useEffect(() => {
    if (!sessionId || !projectRoot) return;
    let unlisten: (() => void) | null = null;

    listen<{ paths: string[] }>(`fs-changed-${sessionId}`, (event) => {
      const changedPaths: string[] = event.payload?.paths ?? [];

      // Determine which expanded folders need refreshing
      const toRefresh = new Set<string>();

      for (const changed of changedPaths) {
        // Root itself
        if (changed.startsWith(projectRoot + "/") || changed === projectRoot) {
          toRefresh.add(projectRoot);
        }
        // Any currently expanded sub-folder that is an ancestor of the changed path
        for (const expanded of expandedRef.current) {
          if (changed.startsWith(expanded + "/") || changed === expanded) {
            toRefresh.add(expanded);
          }
        }
      }

      for (const folderPath of toRefresh) {
        if (folderPath === projectRoot) {
          invoke<DirEntry[]>("list_dir", { path: folderPath, showHidden })
            .then((entries) => {
              setRootEntries(entries);
            })
            .catch(() => {});
        } else {
          const ns = nodeStateRef.current.get(folderPath);
          if (ns) {
            nodeStateRef.current.set(folderPath, { ...ns, loading: true });
            rerender();
            invoke<DirEntry[]>("list_dir", { path: folderPath, showHidden })
              .then((entries) => {
                const cur = nodeStateRef.current.get(folderPath);
                if (cur) {
                  nodeStateRef.current.set(folderPath, { ...cur, children: entries, loading: false });
                  rerender();
                }
              })
              .catch(() => {
                const cur = nodeStateRef.current.get(folderPath);
                if (cur) {
                  nodeStateRef.current.set(folderPath, { ...cur, loading: false });
                  rerender();
                }
              });
          }
        }
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, [sessionId, projectRoot, showHidden, rerender]);

  const toggleFolder = useCallback(
    (entry: DirEntry) => {
      const path = entry.path;
      const existing = nodeStateRef.current.get(path);

      if (existing) {
        // Toggle expanded state
        const nextExpanded = !existing.expanded;
        nodeStateRef.current.set(path, { ...existing, expanded: nextExpanded });
        if (nextExpanded) {
          expandedRef.current.add(path);
        } else {
          expandedRef.current.delete(path);
        }
        rerender();
        return;
      }

      // First expand: start loading children
      nodeStateRef.current.set(path, { expanded: true, children: null, loading: true, error: null });
      expandedRef.current.add(path);
      rerender();

      invoke<DirEntry[]>("list_dir", { path, showHidden })
        .then((children) => {
          nodeStateRef.current.set(path, { expanded: true, children, loading: false, error: null });
          rerender();
        })
        .catch((e) => {
          nodeStateRef.current.set(path, { expanded: true, children: [], loading: false, error: String(e) });
          rerender();
        });
    },
    [showHidden, rerender]
  );

  if (!projectRoot) {
    return <div className="file-viewer-empty">Open a project to browse files.</div>;
  }

  if (rootLoading) {
    return <div className="file-viewer-loading">Loading…</div>;
  }

  if (rootError) {
    return <div className="file-viewer-error">Error: {rootError}</div>;
  }

  if (!rootEntries) {
    return null;
  }

  return (
    <>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          items={makeFileMenuItems(menu.entry.path, menu.entry.is_dir)}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="file-viewer">
        {rootEntries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            nodeStateRef={nodeStateRef}
            toggleFolder={toggleFolder}
            onOpenPreview={onOpenPreview}
            onContextMenu={onRowContextMenu}
            activePath={activePath ?? null}
          />
        ))}
      </div>
    </>
  );
}

function FileTreeNode({
  entry,
  depth,
  nodeStateRef,
  toggleFolder,
  onOpenPreview,
  onContextMenu,
  activePath,
}: {
  entry: DirEntry;
  depth: number;
  nodeStateRef: React.MutableRefObject<Map<string, NodeState>>;
  toggleFolder: (entry: DirEntry) => void;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
  onContextMenu?: (e: React.MouseEvent, entry: DirEntry) => void;
  activePath: string | null;
}) {
  const ns = nodeStateRef.current.get(entry.path);
  const isExpanded = entry.is_dir && ns?.expanded === true;
  const indent = depth * 14 + 8; // px left padding per depth level

  const handleClick = (e: React.MouseEvent) => {
    if (entry.is_dir) {
      toggleFolder(entry);
      return;
    }
    if (!onOpenPreview) return;
    if (e.metaKey && e.shiftKey) {
      onOpenPreview(entry.path, undefined, undefined, { pin: true });
    } else {
      onOpenPreview(entry.path, undefined, undefined, { pin: false });
    }
  };

  return (
    <>
      <div
        className={`file-row${!entry.is_dir && activePath === entry.path ? " file-row-active" : ""}`}
        style={{ paddingLeft: indent }}
        onMouseDownCapture={(e) => { if (e.button !== 0 || e.shiftKey) e.preventDefault(); }}
        onClick={(e) => handleClick(e)}
        onContextMenu={(e) => onContextMenu?.(e, entry)}
        title={entry.path}
      >
        <span className="file-row-chevron">
          {entry.is_dir ? chevron(isExpanded) : null}
        </span>
        <span className="file-row-icon">
          <FileIcon name={entry.name} isDir={entry.is_dir} isExpanded={isExpanded} />
        </span>
        <span className="file-row-name">{entry.name}</span>
      </div>

      {entry.is_dir && isExpanded && (
        <>
          {ns?.loading && (
            <div className="file-viewer-loading" style={{ paddingLeft: indent + 22 }}>
              Loading…
            </div>
          )}
          {ns?.error && (
            <div className="file-viewer-error" style={{ paddingLeft: indent + 22 }}>
              {ns.error}
            </div>
          )}
          {ns?.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              nodeStateRef={nodeStateRef}
              toggleFolder={toggleFolder}
              onOpenPreview={onOpenPreview}
              onContextMenu={onContextMenu}
              activePath={activePath}
            />
          ))}
        </>
      )}
    </>
  );
}
