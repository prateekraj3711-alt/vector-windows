import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { REVEAL_LABEL } from "../platform";

export type FileMenuItem = { label: string; onClick: () => void };

export function FileContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: FileMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Clamp to viewport so menu never clips out of bounds
  const W = 190;
  const H = items.length * 28 + 8;
  const px = Math.min(x, window.innerWidth - W - 8);
  const py = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      className="file-context-menu"
      style={{ position: "fixed", left: px, top: py, zIndex: 200 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          className="file-context-menu-item"
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export type EditorInfo = { bundle_id: string; display_name: string };

export function makeWorktreeMenuItems(
  worktreePath: string,
  editors: EditorInfo[],
  pin?: { isPinned: boolean; canPin: boolean; onTogglePin: (path: string) => void },
): FileMenuItem[] {
  const items: FileMenuItem[] = [];
  if (pin && pin.canPin) {
    items.push({
      label: pin.isPinned ? "Unpin from this pane" : "Pin to this pane",
      onClick: () => pin.onTogglePin(worktreePath),
    });
  }
  for (const ed of editors) {
    items.push({
      label: `Open in ${ed.display_name}`,
      onClick: () => {
        invoke("open_in_editor", { bundleId: ed.bundle_id, path: worktreePath }).catch(() => {});
      },
    });
  }
  items.push({
    label: REVEAL_LABEL,
    onClick: () => {
      invoke("reveal_in_finder", { path: worktreePath }).catch(() => {});
    },
  });
  items.push({
    label: "Copy Path",
    onClick: () => {
      navigator.clipboard.writeText(worktreePath).catch(() => {});
    },
  });
  return items;
}

export function makeFileMenuItems(path: string, isDir: boolean): FileMenuItem[] {
  const items: FileMenuItem[] = [
    {
      label: REVEAL_LABEL,
      onClick: () => {
        invoke("reveal_in_finder", { path }).catch(() => {});
      },
    },
  ];
  if (!isDir) {
    items.push({
      label: "Open in Default App",
      onClick: () => {
        invoke("open_default_app", { path }).catch(() => {});
      },
    });
  }
  items.push({
    label: "Copy Path",
    onClick: () => {
      navigator.clipboard.writeText(path).catch(() => {});
    },
  });
  return items;
}
