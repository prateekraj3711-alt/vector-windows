import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// SidebarTab values match the backend's #[serde(rename_all = "lowercase")] enum.
export type SidebarTab = "files" | "worktrees";

// UiConfig has no rename_all — Rust serializes fields as snake_case.
// get_ui_config returns snake_case JSON keys.
export type SidebarState = {
  sidebar_collapsed: boolean;
  sidebar_active_tab: SidebarTab;
  sidebar_width: number;
  show_hidden_files: boolean;
};

// Tauri v2 converts camelCase JS args → snake_case Rust struct fields.
// SidebarConfigPatch (Rust) fields: sidebar_collapsed, sidebar_active_tab,
// sidebar_width, show_hidden_files — so send camelCase from JS.
type SidebarPatchArgs = {
  sidebarCollapsed?: boolean;
  sidebarActiveTab?: SidebarTab;
  sidebarWidth?: number;
  showHiddenFiles?: boolean;
};

function toBackendPatch(patch: Partial<SidebarState>): SidebarPatchArgs {
  const out: SidebarPatchArgs = {};
  if (patch.sidebar_collapsed !== undefined) out.sidebarCollapsed = patch.sidebar_collapsed;
  if (patch.sidebar_active_tab !== undefined) out.sidebarActiveTab = patch.sidebar_active_tab;
  if (patch.sidebar_width !== undefined) out.sidebarWidth = patch.sidebar_width;
  if (patch.show_hidden_files !== undefined) out.showHiddenFiles = patch.show_hidden_files;
  return out;
}

const DEFAULT: SidebarState = {
  sidebar_collapsed: false,
  sidebar_active_tab: "files",
  sidebar_width: 240,
  show_hidden_files: false,
};

export function useSidebarState() {
  const [state, setState] = useState<SidebarState>(DEFAULT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    invoke<SidebarState>("get_ui_config")
      .then((s) => { setState(s); setHydrated(true); })
      .catch(() => setHydrated(true)); // fall back to defaults
  }, []);

  const update = (patch: Partial<SidebarState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    if (hydrated) {
      invoke("update_sidebar_config", { patch: toBackendPatch(patch) }).catch(console.error);
    }
  };

  return { state, update, hydrated };
}
