import { invoke } from "@tauri-apps/api/core";
import type { Terminal, IDisposable, ILink } from "@xterm/xterm";

type Validation = { exists: boolean; absPath: string; isDir: boolean };
const TTL_MS = 5_000;
const MAX_ENTRIES = 512;

const cache = new Map<string, { at: number; v: Validation }>();

function getCache(key: string): Validation | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.v;
}
function putCache(key: string, v: Validation) {
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { at: Date.now(), v });
}

async function validate(candidate: string): Promise<Validation> {
  const cached = getCache(candidate);
  if (cached) return cached;
  try {
    const res = await invoke<{ abs_path: string; is_dir: boolean } | null>("path_exists", {
      absPath: candidate,
    });
    const v: Validation =
      res && !res.is_dir
        ? { exists: true, absPath: res.abs_path, isDir: false }
        : { exists: false, absPath: candidate, isDir: !!res?.is_dir };
    putCache(candidate, v);
    return v;
  } catch {
    const v: Validation = { exists: false, absPath: candidate, isDir: false };
    putCache(candidate, v);
    return v;
  }
}

// Unquoted paths. Permits backslash-escaped whitespace (`/Users/My\ Files/x.md`).
const PATH_RE =
  /(\/(?:\\\s|[^\s:()[\]{}'"`,;])+|~\/(?:\\\s|[^\s:()[\]{}'"`,;])+|[A-Za-z0-9._@\-/]+\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?/g;

// Quoted paths: "...", '...', `...` — captures inner content.
const QUOTED_RE = /(["'`])([^"'`\n]+)\1/g;

function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:)\]}>'"`]+$/, "");
}

function unescapeBackslashSpaces(s: string): string {
  return s.replace(/\\(\s)/g, "$1");
}

function looksLikePath(s: string): boolean {
  if (s.startsWith("/") || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../")) return true;
  if (s.includes("/")) return true;
  return /\.[A-Za-z0-9]+(?::\d+){0,2}$/.test(s);
}

function splitLineCol(s: string): { pathPart: string; lineNo?: number; colNo?: number } {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(s);
  if (!m) return { pathPart: s };
  return {
    pathPart: m[1] ?? s,
    lineNo: m[2] ? parseInt(m[2], 10) : undefined,
    colNo: m[3] ? parseInt(m[3], 10) : undefined,
  };
}

function resolveAgainstCwd(candidate: string, cwd: string): string {
  if (candidate.startsWith("/")) return candidate;
  if (candidate.startsWith("~/")) return candidate; // Rust expands ~
  if (cwd.endsWith("/")) return cwd + candidate;
  return cwd + "/" + candidate;
}

export type ScanHit = {
  raw: string;
  absPath: string;
  start: number;
  end: number;
  lineNo?: number;
  colNo?: number;
};

export function scanLine(line: string, cwd: string): ScanHit[] {
  const out: ScanHit[] = [];
  const consumed: Array<[number, number]> = [];

  // Pass 1: quoted strings that look like paths.
  QUOTED_RE.lastIndex = 0;
  let qm: RegExpExecArray | null;
  while ((qm = QUOTED_RE.exec(line)) !== null) {
    const inner = qm[2];
    if (!looksLikePath(inner)) continue;
    const { pathPart, lineNo, colNo } = splitLineCol(inner);
    if (!pathPart) continue;
    const start = qm.index + 1; // skip opening quote
    const end = start + inner.length;
    out.push({
      raw: inner,
      absPath: resolveAgainstCwd(unescapeBackslashSpaces(pathPart), cwd),
      start,
      end,
      lineNo,
      colNo,
    });
    consumed.push([qm.index, qm.index + qm[0].length]);
  }

  // Pass 2: unquoted paths.
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(line)) !== null) {
    const idx = m.index;
    if (consumed.some(([s, e]) => idx >= s && idx < e)) continue;
    const fullRaw = trimTrailingPunct(m[0]);
    if (fullRaw.length < 2) continue;
    const { pathPart, lineNo, colNo } = splitLineCol(fullRaw);
    if (!pathPart) continue;
    const absPath = resolveAgainstCwd(unescapeBackslashSpaces(pathPart), cwd);
    out.push({
      raw: fullRaw,
      absPath,
      start: idx,
      end: idx + fullRaw.length,
      lineNo,
      colNo,
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

export type OpenPreviewFn = (
  absPath: string,
  line: number | undefined,
  col: number | undefined,
  opts: { pin: boolean },
) => void;

// Greedy-extend an absolute/tilde path hit by appending trailing space-separated
// words from the same line and re-validating. Picks the longest extension that
// resolves to an existing file. Used to recover paths printed unquoted, e.g.
// `/tmp/My Project/Notes Final.md`.
async function tryExtendCandidate(line: string, hit: ScanHit): Promise<ScanHit> {
  if (!(hit.absPath.startsWith("/") || hit.absPath.startsWith("~/"))) return hit;
  if (hit.lineNo !== undefined) return hit; // already terminated by :line:col
  if (line[hit.end] !== " ") return hit;
  const after = line.slice(hit.end);
  const tokens: string[] = [];
  const tokRe = /^ ([^\s|,;()[\]{}]+)/;
  let consumed = 0;
  while (tokens.length < 6) {
    const m = tokRe.exec(after.slice(consumed));
    if (!m) break;
    tokens.push(m[1]);
    consumed += m[0].length;
  }
  if (tokens.length === 0) return hit;
  const exts: string[] = [];
  let cur = hit.absPath;
  for (const t of tokens) {
    cur = cur + " " + t;
    exts.push(cur);
  }
  const results = await Promise.all(exts.map((p) => validate(p)));
  let best = -1;
  for (let i = 0; i < results.length; i++) {
    if (results[i].exists) best = i;
  }
  if (best < 0) return hit;
  let extra = 0;
  for (let i = 0; i <= best; i++) extra += 1 + tokens[i].length;
  return {
    ...hit,
    absPath: results[best].absPath,
    raw: hit.raw + line.slice(hit.end, hit.end + extra),
    end: hit.end + extra,
  };
}

export function registerPreviewLinkProvider(
  term: Terminal,
  getCwd: () => string,
  openPreview: OpenPreviewFn,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks: async (y, callback) => {
      const buf = term.buffer.active;
      const lineObj = buf.getLine(y - 1);
      if (!lineObj) {
        callback(undefined);
        return;
      }
      const text = lineObj.translateToString(true);
      const cwd = getCwd();
      const initial = scanLine(text, cwd);
      const extended = await Promise.all(initial.map((c) => tryExtendCandidate(text, c)));
      extended.sort((a, b) => a.start - b.start);
      const cands: ScanHit[] = [];
      for (const c of extended) {
        const last = cands[cands.length - 1];
        if (last && c.start < last.end) continue;
        cands.push(c);
      }
      const validated = await Promise.all(cands.map((c) => validate(c.absPath)));
      const links: ILink[] = [];
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const v = validated[i];
        if (!v.exists) continue;
        const range = {
          start: { x: c.start + 1, y },
          end: { x: c.end, y },
        };
        links.push({
          range,
          text: c.raw,
          activate: (event) => {
            const me = event as MouseEvent;
            if (!me.metaKey) return;
            openPreview(v.absPath, c.lineNo, c.colNo, { pin: !!me.shiftKey });
          },
          hover: () => {},
          leave: () => {},
        });
      }
      callback(links);
    },
  });
}
