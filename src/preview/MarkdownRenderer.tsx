import { useEffect, useMemo, useRef, useState } from "react";
import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import { MermaidRenderer } from "./MermaidRenderer";

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
  const [mermaidBlocks, setMermaidBlocks] = useState<Array<{ host: HTMLElement; source: string }>>([]);

  const html = useMemo(() => {
    const renderer = new Renderer();
    const origCode = renderer.code.bind(renderer);
    renderer.code = ({ text: codeText, lang }: any) => {
      if (lang === "mermaid") {
        const encoded = encodeURIComponent(codeText);
        return `<div class="mermaid-block" data-source="${encoded}"></div>`;
      }
      return origCode({ text: codeText, lang } as any);
    };
    const raw = marked.parse(text, { async: false, renderer }) as string;
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ["div"],
      ADD_ATTR: ["data-source"],
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    });
  }, [text]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      setMermaidBlocks([]);
      return;
    }
    const hosts = Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block"));
    setMermaidBlocks(
      hosts.map((host) => ({
        host,
        source: decodeURIComponent(host.dataset.source ?? ""),
      })),
    );
  }, [html]);

  useEffect(() => {
    if (!jumpLine || !containerRef.current) return;
    const blocks = containerRef.current.children;
    if (blocks.length === 0) return;
    const idx = Math.min(blocks.length - 1, Math.max(0, jumpLine - 1));
    (blocks[idx] as HTMLElement)?.scrollIntoView({ block: "center" });
  }, [html, jumpLine]);

  return (
    <>
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
      {mermaidBlocks.map((b, i) => createPortal(<MermaidRenderer source={b.source} />, b.host, `mb-${i}`))}
    </>
  );
}
