export type RendererKind = "markdown" | "mermaid" | "code" | "image" | "pdf" | "binary" | "unknown-text";

export const CAPS = {
  TEXT: 5 * 1024 * 1024,    // 5 MB
  IMAGE: 10 * 1024 * 1024,  // 10 MB
  PDF: 50 * 1024 * 1024,    // 50 MB
} as const;

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
  html: "html", xml: "xml",
  sql: "sql",
  lua: "lua", php: "php",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell",
  scala: "scala", dart: "dart",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function extOf(path: string): string {
  const ix = path.lastIndexOf(".");
  if (ix < 0) return "";
  return path.slice(ix + 1).toLowerCase();
}

export function capForExtension(ext: string): number {
  if (IMAGE_EXTS.has(ext)) return CAPS.IMAGE;
  if (ext === "pdf") return CAPS.PDF;
  return CAPS.TEXT;
}

export function pickRenderer(path: string): { kind: RendererKind; grammar?: string } {
  const ext = extOf(path);
  if (ext === "md" || ext === "markdown") return { kind: "markdown" };
  if (ext === "mmd" || ext === "mermaid") return { kind: "mermaid" };
  if (ext === "pdf") return { kind: "pdf" };
  if (IMAGE_EXTS.has(ext)) return { kind: "image" };
  if (ext in CODE_GRAMMARS) return { kind: "code", grammar: CODE_GRAMMARS[ext] };
  return { kind: "unknown-text" };
}
