const OSC = "\x1b]";
const BEL = "\x07";
const ST = "\x1b\\";

export function makeCwdSniffer(onCwd: (cwd: string) => void) {
  let buf = "";
  return {
    feed(chunk: string) {
      buf += chunk;
      if (buf.length > 4096) buf = buf.slice(-2048);
      let i;
      while ((i = buf.indexOf(`${OSC}7;`)) !== -1) {
        const tail = buf.slice(i);
        const endBel = tail.indexOf(BEL);
        const endSt = tail.indexOf(ST);
        const end =
          endBel === -1
            ? endSt
            : endSt === -1
              ? endBel
              : Math.min(endBel, endSt);
        if (end === -1) return;
        const payload = tail.slice(3, end);
        const url = payload.startsWith("file://") ? payload : null;
        if (url) {
          try {
            const u = new URL(url);
            const path = decodeURIComponent(u.pathname);
            onCwd(path);
          } catch {}
        }
        buf = tail.slice(end + (end === endSt ? 2 : 1));
      }
    },
  };
}
