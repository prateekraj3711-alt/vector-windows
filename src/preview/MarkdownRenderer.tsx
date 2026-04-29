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
    let cursorLine = 1;

    const advance = (raw: string | undefined) => {
      if (!raw) return;
      // Number of newlines in raw == lines this token spans.
      let n = 0;
      for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
      cursorLine += n;
    };

    const wrap = (line: number, inner: string) => `<div data-md-line="${line}">${inner}</div>`;

    const origHeading = renderer.heading.bind(renderer);
    renderer.heading = (token: any) => {
      const line = cursorLine;
      const out = origHeading(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origParagraph = renderer.paragraph.bind(renderer);
    renderer.paragraph = (token: any) => {
      const line = cursorLine;
      const out = origParagraph(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origList = renderer.list.bind(renderer);
    renderer.list = (token: any) => {
      const line = cursorLine;
      const out = origList(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origBlockquote = renderer.blockquote.bind(renderer);
    renderer.blockquote = (token: any) => {
      const line = cursorLine;
      const out = origBlockquote(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origHr = renderer.hr.bind(renderer);
    renderer.hr = (token: any) => {
      const line = cursorLine;
      const out = origHr(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origTable = renderer.table.bind(renderer);
    renderer.table = (token: any) => {
      const line = cursorLine;
      const out = origTable(token);
      advance(token.raw);
      return wrap(line, out);
    };

    const origCode = renderer.code.bind(renderer);
    renderer.code = (token: any) => {
      const line = cursorLine;
      const { text: codeText, lang, raw } = token;
      if (lang === "mermaid") {
        const encoded = encodeURIComponent(codeText);
        advance(raw);
        return `<div class="mermaid-block" data-md-line="${line}" data-source="${encoded}"></div>`;
      }
      const out = origCode(token);
      advance(raw);
      return wrap(line, out);
    };

    // "space" tokens (blank lines) just advance the cursor.
    const origSpace = (renderer as any).space?.bind(renderer);
    if (origSpace) {
      (renderer as any).space = (token: any) => {
        const out = origSpace(token);
        advance(token.raw);
        return out;
      };
    }

    const raw = marked.parse(text, { async: false, renderer }) as string;
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ["div"],
      ADD_ATTR: ["data-source", "data-md-line"],
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
    const els = containerRef.current.querySelectorAll<HTMLElement>("[data-md-line]");
    let best: HTMLElement | null = null;
    let bestLine = -1;
    for (const el of els) {
      const n = parseInt(el.dataset.mdLine ?? "0", 10);
      if (n <= jumpLine && n > bestLine) {
        best = el;
        bestLine = n;
      }
    }
    if (best) {
      best.scrollIntoView({ block: "center" });
      const el = best;
      el.style.transition = "background 600ms";
      el.style.background = "rgba(255, 220, 0, 0.18)";
      setTimeout(() => {
        el.style.background = "transparent";
      }, 50);
    }
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
