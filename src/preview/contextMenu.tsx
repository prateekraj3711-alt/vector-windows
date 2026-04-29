import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export type MenuTarget = { absPath: string };

export function PathContextMenu({
  target,
  x,
  y,
  onClose,
}: {
  target: MenuTarget;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const item = (label: string, action: () => void) => (
    <div
      key={label}
      style={{ padding: "6px 12px", cursor: "pointer", fontSize: 13 }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#2a2a2a")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
    </div>
  );

  // Clamp to viewport.
  const W = 200;
  const H = 3 * 28 + 8;
  const px = Math.min(x, window.innerWidth - W - 8);
  const py = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: px,
        top: py,
        background: "#1a1a1a",
        border: "1px solid #333",
        borderRadius: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        zIndex: 9999,
        minWidth: W,
        color: "#ddd",
        padding: "4px 0",
      }}
    >
      {item("Reveal in Finder", () => {
        invoke("reveal_in_finder", { path: target.absPath }).catch(() => {});
      })}
      {item("Open in default app", () => {
        invoke("open_default_app", { path: target.absPath }).catch(() => {});
      })}
      {item("Copy path", () => {
        navigator.clipboard.writeText(target.absPath).catch(() => {});
      })}
    </div>
  );
}
