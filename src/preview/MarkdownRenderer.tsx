import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function MarkdownRenderer({
  data,
  theme,
  jumpLine,
}: {
  data: Uint8Array;
  theme: "dark" | "light";
  jumpLine?: number;
}) {
  const text = useMemo(() => new TextDecoder("utf-8", { fatal: false }).decode(data), [data]);
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    });
  }, [text]);

  useEffect(() => {
    if (!jumpLine || !containerRef.current) return;
    // Heuristic: scroll to the Nth top-level block-level child.
    const blocks = containerRef.current.children;
    if (blocks.length === 0) return;
    const idx = Math.min(blocks.length - 1, Math.max(0, jumpLine - 1));
    const el = blocks[idx] as HTMLElement;
    el.scrollIntoView({ block: "center" });
  }, [html, jumpLine]);

  return (
    <div
      ref={containerRef}
      className={`md-preview md-${theme}`}
      style={{
        padding: 16,
        lineHeight: 1.55,
        fontSize: 14,
        color: theme === "dark" ? "#ddd" : "#222",
        wordBreak: "break-word",
        overflowWrap: "break-word",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
