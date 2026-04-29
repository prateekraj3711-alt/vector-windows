import React, { useRef } from "react";
import { useSidebarState, SidebarTab } from "./sidebarState";

const RAIL_WIDTH = 42;

export function Sidebar() {
  const { state, update, hydrated } = useSidebarState();
  const { sidebar_collapsed, sidebar_active_tab, sidebar_width } = state;

  // Expose sidebar offset as a CSS variable on the document root so topbar/shell
  // can shift right without needing prop drilling.
  const offset = RAIL_WIDTH + (sidebar_collapsed ? 0 : sidebar_width);
  React.useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-offset", `${offset}px`);
  }, [offset]);

  if (!hydrated) return null; // avoid flicker on first render

  const onIconClick = (tab: SidebarTab) => {
    if (tab === sidebar_active_tab && !sidebar_collapsed) {
      update({ sidebar_collapsed: true });
    } else {
      update({ sidebar_active_tab: tab, sidebar_collapsed: false });
    }
  };

  return (
    <>
      <div className="sidebar-rail">
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "files" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("files")}
          title="Files"
        >📁</button>
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "worktrees" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("worktrees")}
          title="Worktrees"
        >🌿</button>
      </div>

      {!sidebar_collapsed && (
        <div className="sidebar-panel" style={{ width: sidebar_width }}>
          <div className="sidebar-panel-content">
            {sidebar_active_tab === "files" && (
              <div style={{ padding: 12, opacity: 0.5 }}>Files (coming soon)</div>
            )}
            {sidebar_active_tab === "worktrees" && (
              <div style={{ padding: 12, opacity: 0.5 }}>Worktrees (coming soon)</div>
            )}
          </div>
          <SidebarDivider
            sidebarWidth={sidebar_width}
            onChange={(w) => update({ sidebar_width: w })}
          />
        </div>
      )}
    </>
  );
}

function SidebarDivider({
  sidebarWidth,
  onChange,
}: {
  sidebarWidth: number;
  onChange: (w: number) => void;
}) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(sidebarWidth);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      const delta = ev.clientX - startXRef.current;
      const next = Math.min(600, Math.max(160, startWidthRef.current + delta));
      onChange(next);
    };

    const onMouseUp = () => {
      startXRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return <div className="sidebar-divider" onMouseDown={onMouseDown} />;
}
