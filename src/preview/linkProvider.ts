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

const PATH_RE =
  /(\/[^\s:()[\]{}'"`,;]+|~\/[^\s:()[\]{}'"`,;]+|[A-Za-z0-9._@\-/]+\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?/g;

function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:)\]}>'"`]+$/, "");
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
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(line)) !== null) {
    const fullRaw = trimTrailingPunct(m[0]);
    if (fullRaw.length < 2) continue;
    const lineColMatch = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(fullRaw);
    let pathPart = fullRaw;
    let lineNo: number | undefined;
    let colNo: number | undefined;
    if (lineColMatch) {
      pathPart = lineColMatch[1];
      if (lineColMatch[2]) lineNo = parseInt(lineColMatch[2], 10);
      if (lineColMatch[3]) colNo = parseInt(lineColMatch[3], 10);
    }
    if (!pathPart) continue;
    const absPath = resolveAgainstCwd(pathPart, cwd);
    out.push({
      raw: fullRaw,
      absPath,
      start: m.index,
      end: m.index + fullRaw.length,
      lineNo,
      colNo,
    });
  }
  return out;
}

export type OpenPreviewFn = (
  absPath: string,
  line: number | undefined,
  col: number | undefined,
  opts: { pin: boolean },
) => void;

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
      const cands = scanLine(text, cwd);
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
