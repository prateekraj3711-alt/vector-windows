// Platform detection + shortcut labels, shared across the app.
//
// WebView2 (Windows) user-agent contains "Windows"; WKWebView (macOS) contains
// "Macintosh". On Windows bare Ctrl is reserved for the terminal (Ctrl+C/D/R/W…),
// so app actions live on Ctrl+Shift, tab switching on Alt+digit, pane focus on
// Ctrl+Alt+Arrow, and the "primary modifier" for click-gestures is Ctrl.
export const IS_WINDOWS =
  typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/// True when the platform's primary modifier (⌘ on macOS, Ctrl on Windows/Linux)
/// is held — used for modifier-click gestures (e.g. open file preview).
export function hasPrimaryModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_WINDOWS ? e.ctrlKey : e.metaKey;
}

/// OS file-manager name for "reveal" actions ("Finder" on macOS, "File
/// Explorer" on Windows, "file manager" elsewhere).
export const REVEAL_LABEL = IS_WINDOWS
  ? "Reveal in File Explorer"
  : typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent)
    ? "Reveal in Finder"
    : "Show in file manager";

/// Human-readable shortcut labels for tooltips / empty states.
export const SC = IS_WINDOWS
  ? {
      newTab: "Ctrl+Shift+T",
      reload: "Ctrl+Shift+R",
      settings: "Ctrl+,",
      tab: (n: number) => `Alt+${n}`,
    }
  : {
      newTab: "⌘T",
      reload: "⌘⇧R",
      settings: "⌘,",
      tab: (n: number) => `⌘${n}`,
    };
