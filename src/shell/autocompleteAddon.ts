import type { ITerminalAddon, Terminal, IDisposable, IDecoration } from "@xterm/xterm";
import { historyStore } from "./historyStore";

export type AutocompleteOptions = {
  onAcceptText: (text: string) => void;
};

export function makeAutocompleteAddon(opts: AutocompleteOptions): ITerminalAddon {
  let term: Terminal | null = null;
  let inputBuf = "";
  let suggestion: string | null = null;
  let decoration: IDecoration | null = null;
  const disposables: IDisposable[] = [];

  function clearGhost() {
    decoration?.dispose();
    decoration = null;
    suggestion = null;
  }

  let pendingRefresh = 0;
  function scheduleRefresh() {
    if (pendingRefresh) return;
    pendingRefresh = requestAnimationFrame(() => {
      pendingRefresh = 0;
      refresh();
    });
  }

  function refresh() {
    if (!term) return;
    clearGhost();
    if (!inputBuf) return;
    const match = historyStore.bestMatch(inputBuf);
    if (!match) return;
    const tail = match.slice(inputBuf.length);
    if (!tail) return;
    suggestion = match;
    const marker = term.registerMarker(0);
    if (!marker) return;
    const availableWidth = term.cols - term.buffer.active.cursorX;
    if (availableWidth <= 0) return;
    decoration = term.registerDecoration({
      marker,
      x: term.buffer.active.cursorX,
      width: Math.min(tail.length, availableWidth),
      height: 1,
    }) ?? null;
    if (decoration) {
      const fontFamily = (term.options.fontFamily as string | undefined) ?? "monospace";
      const fontSize = term.options.fontSize ?? 12;
      decoration.onRender((el) => {
        el.style.color = "rgba(180,180,180,0.45)";
        el.style.pointerEvents = "none";
        el.style.fontFamily = fontFamily;
        el.style.fontSize = `${fontSize}px`;
        el.style.lineHeight = `${term?.options.lineHeight ?? 1}`;
        el.style.letterSpacing = `${term?.options.letterSpacing ?? 0}px`;
        el.style.whiteSpace = "pre";
        el.style.padding = "0";
        el.style.margin = "0";
        el.style.boxSizing = "content-box";
        el.style.zIndex = "1";
        el.style.overflow = "hidden";
        el.textContent = tail;
      });
    }
  }

  return {
    activate(t: Terminal) {
      term = t;

      // attachCustomKeyEventHandler returns void; we reset it on dispose.
      t.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (ev.key === "ArrowRight" && !ev.altKey && suggestion) {
          const tail = suggestion.slice(inputBuf.length);
          if (tail) {
            opts.onAcceptText(tail);
            inputBuf += tail;
            clearGhost();
            return false;
          }
        }
        if (ev.altKey && ev.key === "ArrowRight" && suggestion) {
          const tail = suggestion.slice(inputBuf.length);
          const m = tail.match(/^\S*\s?/);
          if (m && m[0]) {
            opts.onAcceptText(m[0]);
            inputBuf += m[0];
            refresh();
            return false;
          }
        }
        if (ev.key === "Escape") {
          clearGhost();
          return true;
        }
        return true;
      });

      disposables.push(
        t.onData((data) => {
          for (const ch of data) {
            if (ch === "\r" || ch === "\n") {
              if (inputBuf.trim()) historyStore.record(inputBuf);
              inputBuf = "";
              clearGhost();
            } else if (ch === "\x7f" || ch === "\b") {
              inputBuf = inputBuf.slice(0, -1);
            } else if (ch >= " " && ch !== "\x1b") {
              inputBuf += ch;
            } else {
              clearGhost();
              inputBuf = "";
              return;
            }
          }
          scheduleRefresh();
        }),
      );
    },
    dispose() {
      if (pendingRefresh) { cancelAnimationFrame(pendingRefresh); pendingRefresh = 0; }
      clearGhost();
      // Reset the key event handler to a pass-through so it no longer intercepts.
      if (term) {
        term.attachCustomKeyEventHandler(() => true);
      }
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      term = null;
    },
  };
}
