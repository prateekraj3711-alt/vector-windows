import { useEffect, useState } from "react";

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
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { createHighlighterCore } = await import("shiki/core");
        const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
        const wasm = await import("shiki/wasm");
        // Try the requested grammar; fall back to plain text on import failure.
        // Shiki has no "text" grammar file — "text" is a builtin no-op lang.
        let grammarMod: any = null;
        if (grammar && grammar !== "text") {
          try {
            grammarMod = await import(/* @vite-ignore */ `shiki/langs/${grammar}.mjs`);
          } catch {
            grammarMod = null;
          }
        }
        const themeMod = await import(
          theme === "dark" ? "shiki/themes/github-dark.mjs" : "shiki/themes/github-light.mjs"
        );
        const hl = await createHighlighterCore({
          themes: [themeMod.default],
          langs: grammarMod ? [grammarMod.default] : [],
          engine: createOnigurumaEngine(wasm.default),
        });
        if (cancelled) return;
        const lang = grammarMod
          ? ((Array.isArray(grammarMod.default) ? grammarMod.default[0]?.name : grammarMod.default?.name) ?? grammar)
          : "text";
        const out = hl.codeToHtml(text, {
          lang,
          theme: themeMod.default.name,
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
  }, [text, grammar, theme]);

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
  if (!html)
    return <pre style={{ padding: 16, color: "#888", margin: 0 }}>Highlighting…</pre>;

  return (
    <div
      data-shiki-root={grammar}
      style={{
        padding: 12,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        overflowX: "auto",
        height: "100%",
        boxSizing: "border-box",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
