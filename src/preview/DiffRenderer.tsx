import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { extOf } from "./extensions";

const CODE_GRAMMARS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", rb: "ruby",
  go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "shellscript",
  json: "json", jsonc: "jsonc",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  css: "css", scss: "scss",
  xml: "xml",
  sql: "sql",
  lua: "lua", php: "php",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell",
  scala: "scala", dart: "dart",
};

function languageForExt(ext: string): string {
  return CODE_GRAMMARS[ext] ?? "text";
}

type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string };

type Props = {
  filePath: string;
  baseRef?: string;
  theme: "dark" | "light";
};

export function DiffRenderer({ filePath, baseRef, theme }: Props) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "loaded"; lines: DiffLine[]; lang: string }
    | { status: "empty" }
    | { status: "error"; message: string }
  >({ status: "loading" });

  const reloadTimer = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const load = async (initial: boolean) => {
      if (initial) setState({ status: "loading" });
      try {
        const worktree = await findWorktreeRoot(filePath);
        if (!worktree) throw new Error("Could not locate worktree root");
        const relFile = filePath.startsWith(worktree + "/")
          ? filePath.slice(worktree.length + 1)
          : filePath;
        const text = await invoke<string>("worktree_diff", {
          worktree,
          file: relFile,
          base: baseRef ? "base" : "head",
          base_ref: baseRef ?? null,
        });
        if (cancelled) return;
        if (!text.trim()) {
          setState({ status: "empty" });
          return;
        }
        const lines = parseDiff(text);
        const lang = languageForExt(extOf(filePath));
        setState({ status: "loaded", lines, lang });
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { message?: string };
        setState({ status: "error", message: String(err?.message ?? e) });
      }
    };

    void load(true);

    const scheduleReload = () => {
      if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        if (!cancelled) void load(false);
      }, 200);
    };

    listen<{ paths: string[] }>("fs-changed", (ev) => {
      if (ev.payload.paths.some((p) => p === filePath)) scheduleReload();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
      if (unlisten) unlisten();
    };
  }, [filePath, baseRef]);

  if (state.status === "loading") return <div className="diff-loading">Loading diff…</div>;
  if (state.status === "empty") return <div className="diff-empty">No changes</div>;
  if (state.status === "error") return <div className="diff-error">{state.message}</div>;

  return (
    <div className="diff-renderer">
      {state.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} lang={state.lang} theme={theme} />
      ))}
    </div>
  );
}

function DiffLineRow({ line, lang, theme }: { line: DiffLine; lang: string; theme: "dark" | "light" }) {
  if (line.kind === "hunk" || line.kind === "meta") {
    return <div className={`diff-line diff-${line.kind}`}>{line.text}</div>;
  }
  const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const content = line.text.startsWith(prefix) ? line.text.slice(1) : line.text;
  return (
    <div className={`diff-line diff-${line.kind}`}>
      <span className="diff-gutter">{prefix}</span>
      <span className="diff-content">
        <HighlightedCode code={content} lang={lang} theme={theme} />
      </span>
    </div>
  );
}

function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of text.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file ") ||
      raw.startsWith("deleted file ") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ")
    ) {
      out.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("@@")) {
      out.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ kind: "add", text: raw });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      out.push({ kind: "del", text: raw });
    } else {
      out.push({ kind: "context", text: raw });
    }
  }
  // Drop trailing empty context line (artifact of split)
  if (out.length && out[out.length - 1].kind === "context" && out[out.length - 1].text === "") {
    out.pop();
  }
  return out;
}

async function findWorktreeRoot(filePath: string): Promise<string | null> {
  let dir = filePath.replace(/\/[^/]+$/, "");
  while (dir && dir !== "/") {
    try {
      const info = await invoke<unknown>("path_exists", { absPath: `${dir}/.git` });
      if (info) return dir;
    } catch {
      // swallow
    }
    const next = dir.replace(/\/[^/]+$/, "");
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripPreCode(html: string): string {
  // shiki wraps output in <pre><code>…</code></pre>; extract inner content
  const m = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
  return m ? m[1] : html;
}

function HighlightedCode({
  code,
  lang,
  theme,
}: {
  code: string;
  lang: string;
  theme: "dark" | "light";
}) {
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    if (code.length > 500) {
      setHtml(escapeHtml(code));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const shiki = await import("shiki");
        const { createHighlighter, bundledLanguages, bundledThemes } = shiki as any;
        const themeName = theme === "dark" ? "github-dark" : "github-light";
        const wantLang = lang && lang !== "text" && lang in bundledLanguages ? lang : null;
        const hl = await createHighlighter({
          themes: [themeName in bundledThemes ? themeName : "github-dark"],
          langs: wantLang ? [wantLang] : [],
        });
        if (cancelled) return;
        const out = hl.codeToHtml(code, {
          lang: wantLang ?? "text",
          theme: themeName,
        });
        setHtml(out);
      } catch {
        if (!cancelled) setHtml(escapeHtml(code));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return <span dangerouslySetInnerHTML={{ __html: stripPreCode(html) }} />;
}
