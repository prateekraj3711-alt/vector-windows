import { useEffect, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidPromise;
}

export function MermaidRenderer({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await getMermaid();
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, source);
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
        setErr(null);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (err) {
    return (
      <div style={{ padding: 12, border: "1px solid #844", borderRadius: 4, marginBottom: 12 }}>
        <div style={{ color: "#e88", marginBottom: 8, overflowWrap: "break-word" }}>Mermaid parse error: {err}</div>
        <pre style={{ background: "#1a1a1a", padding: 8, overflowX: "auto", fontSize: 12, margin: 0 }}>{source}</pre>
      </div>
    );
  }
  return <div ref={ref} style={{ margin: "12px 0", textAlign: "center" }} />;
}
