import { useEffect, useMemo, useState } from "react";

// Above this size shiki tokenization stalls the main thread for seconds.
// Render as plain <pre> instead — readable, no highlighting.
const HIGHLIGHT_BYTE_CAP = 512 * 1024;

export function CodeRenderer({
  data,
  grammar,
  theme,
  jumpLine,
}: {
  data: Uint8Array;
  grammar: string;
  theme: "dark" | "light";
  jumpLine?: number;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const text = useMemo(() => new TextDecoder("utf-8", { fatal: false }).decode(data), [data]);
  const tooBigToHighlight = data.byteLength > HIGHLIGHT_BYTE_CAP;

  useEffect(() => {
    if (tooBigToHighlight) {
      setHtml(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const shiki = await import("shiki");
        const { createHighlighter, bundledLanguages, bundledThemes } = shiki as any;
        const themeName = theme === "dark" ? "github-dark" : "github-light";
        const wantLang = grammar && grammar !== "text" && grammar in bundledLanguages ? grammar : null;
        const langs = wantLang ? [wantLang] : [];
        const hl = await createHighlighter({
          themes: [themeName in bundledThemes ? themeName : "github-dark"],
          langs,
        });
        if (cancelled) return;
        const out = hl.codeToHtml(text, {
          lang: wantLang ?? "text",
          theme: themeName,
        });
        setHtml(out);
        setErr(null);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, grammar, theme, tooBigToHighlight]);

  useEffect(() => {
    if (!html || !jumpLine) return;
    const root = document.querySelector(`[data-shiki-root="${grammar}"]`);
    if (!root) return;
    const lines = root.querySelectorAll(".line");
    const target = lines[jumpLine - 1] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.style.background = "rgba(255, 220, 0, 0.18)";
      setTimeout(() => {
        target.style.transition = "background 600ms";
        target.style.background = "transparent";
      }, 50);
    }
  }, [html, jumpLine, grammar]);

  if (err)
    return (
      <pre style={{ padding: 16, color: "#e88", whiteSpace: "pre-wrap", overflowWrap: "break-word", margin: 0 }}>
        Highlight error: {err}
      </pre>
    );
  if (tooBigToHighlight) {
    return (
      <pre
        style={{
          padding: 12,
          margin: 0,
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          color: theme === "dark" ? "#c9d1d9" : "#24292f",
          whiteSpace: "pre",
          width: "max-content",
          minWidth: "100%",
          boxSizing: "border-box",
        }}
      >
        {text}
      </pre>
    );
  }
  if (!html)
    return <pre style={{ padding: 16, color: "#888", margin: 0 }}>Highlighting…</pre>;

  return (
    <div
      data-shiki-root={grammar}
      style={{
        padding: 12,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        width: "max-content",
        minWidth: "100%",
        boxSizing: "border-box",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
