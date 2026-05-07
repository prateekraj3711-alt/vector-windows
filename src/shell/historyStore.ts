const KEY = "vector.shellHistory.v1";
const MAX_ENTRIES = 2000;

type Entry = { cmd: string; count: number; lastUsed: number };

function load(): Entry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}
function save(entries: Entry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES))); } catch {}
}

export const historyStore = {
  record(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    const entries = load();
    const i = entries.findIndex((e) => e.cmd === trimmed);
    if (i >= 0) {
      entries[i].count += 1;
      entries[i].lastUsed = Date.now();
    } else {
      entries.unshift({ cmd: trimmed, count: 1, lastUsed: Date.now() });
    }
    entries.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
    save(entries);
  },
  bestMatch(prefix: string): string | null {
    if (!prefix) return null;
    const entries = load();
    const m = entries.find((e) => e.cmd.startsWith(prefix) && e.cmd.length > prefix.length);
    return m ? m.cmd : null;
  },
};
