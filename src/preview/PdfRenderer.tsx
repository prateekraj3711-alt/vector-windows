import { useEffect, useRef, useState } from "react";

export function PdfRenderer({ data, jumpLine }: { data: Uint8Array; jumpLine?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<any>(null);
  const [page, setPage] = useState(jumpLine ?? 1);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // @ts-ignore - no types shipped for subpath
        const pdfjs: any = await import("pdfjs-dist/build/pdf.mjs");
        // @ts-ignore - vite ?url import
        const workerUrl: any = await import("pdfjs-dist/build/pdf.worker.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
        const loadingTask = pdfjs.getDocument({ data: data.slice() });
        const d = await loadingTask.promise;
        if (cancelled) return;
        setDoc(d);
        setErr(null);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const p = Math.min(Math.max(1, page), doc.numPages);
      const pageObj = await doc.getPage(p);
      const viewport = pageObj.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      if (cancelled) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await pageObj.render({ canvasContext: ctx, viewport, canvas }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  if (err) {
    return (
      <div style={{ padding: 16, color: "#e88", overflowWrap: "break-word" }}>
        Failed to render PDF: {err}
      </div>
    );
  }
  if (!doc) return <div style={{ padding: 16, color: "#888" }}>Loading PDF…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 12, height: "100%", boxSizing: "border-box", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", color: "#aaa", fontSize: 12 }}>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>‹</button>
        <span>{page} / {doc.numPages}</span>
        <button onClick={() => setPage((p) => Math.min(doc.numPages, p + 1))} disabled={page >= doc.numPages}>›</button>
      </div>
      <canvas ref={canvasRef} style={{ background: "white", maxWidth: "100%" }} />
    </div>
  );
}
