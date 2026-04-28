import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { capForExtension, extOf, pickRenderer } from "./extensions";
import { isLikelyBinary } from "./sniff";
import { BinaryPlaceholder } from "./BinaryPlaceholder";
import { TooLargePlaceholder } from "./TooLargePlaceholder";
import { ErrorPlaceholder } from "./ErrorPlaceholder";
import { ImageRenderer } from "./ImageRenderer";
import { CodeRenderer } from "./CodeRenderer";
import { MarkdownRenderer } from "./MarkdownRenderer";

type ReadFileResult = {
  bytes: number[];
  truncated: boolean;
  size_bytes: number;
  mime: string | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: Uint8Array; sizeBytes: number; mime: string | null }
  | { status: "too-large"; sizeBytes: number; capBytes: number }
  | { status: "binary" }
  | { status: "error"; message: string };

export type PreviewLeafProps = {
  filePath: string;
  jumpLine?: number;
  jumpCol?: number;
  theme: "dark" | "light";
};

export function PreviewPane(props: PreviewLeafProps) {
  const { filePath, jumpLine, jumpCol, theme } = props;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const cap = capForExtension(extOf(filePath));

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const r = await invoke<ReadFileResult>("read_file_bytes", { path: filePath, capBytes: cap });
      if (r.truncated) {
        setState({ status: "too-large", sizeBytes: r.size_bytes, capBytes: cap });
        return;
      }
      const bytes = new Uint8Array(r.bytes);
      const renderer = pickRenderer(filePath);
      if (renderer.kind === "unknown-text" && isLikelyBinary(bytes)) {
        setState({ status: "binary" });
        return;
      }
      setState({ status: "loaded", data: bytes, sizeBytes: r.size_bytes, mime: r.mime });
    } catch (e: any) {
      setState({ status: "error", message: String(e?.message ?? e) });
    }
  }, [filePath, cap]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: theme === "dark" ? "#1e1e1e" : "#fff" }}>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0, minWidth: 0 }}>
        {state.status === "loading" && (
          <div style={{ padding: 16, color: "#888" }}>Loading…</div>
        )}
        {state.status === "too-large" && (
          <TooLargePlaceholder filePath={filePath} sizeBytes={state.sizeBytes} capBytes={state.capBytes} />
        )}
        {state.status === "binary" && (
          <BinaryPlaceholder filePath={filePath} />
        )}
        {state.status === "error" && (
          <ErrorPlaceholder message={state.message} onRetry={() => setReloadKey((k) => k + 1)} />
        )}
        {state.status === "loaded" && (
          <RendererSwitch
            filePath={filePath}
            data={state.data}
            mime={state.mime}
            jumpLine={jumpLine}
            jumpCol={jumpCol}
            theme={theme}
          />
        )}
      </div>
    </div>
  );
}

function RendererSwitch(props: {
  filePath: string;
  data: Uint8Array;
  mime: string | null;
  jumpLine?: number;
  jumpCol?: number;
  theme: "dark" | "light";
}) {
  const renderer = pickRenderer(props.filePath);
  switch (renderer.kind) {
    case "image":
      return <ImageRenderer filePath={props.filePath} />;
    case "code":
      return (
        <CodeRenderer
          data={props.data}
          grammar={renderer.grammar ?? "text"}
          theme={props.theme}
          jumpLine={props.jumpLine}
        />
      );
    case "unknown-text":
      return (
        <CodeRenderer
          data={props.data}
          grammar="text"
          theme={props.theme}
          jumpLine={props.jumpLine}
        />
      );
    case "markdown":
      return <MarkdownRenderer data={props.data} theme={props.theme} jumpLine={props.jumpLine} />;
    case "mermaid":
      return <PendingRenderer label="mermaid" />;
    case "pdf":
      return <PendingRenderer label="pdf" />;
    case "binary":
      return <BinaryPlaceholder filePath={props.filePath} />;
  }
}

function PendingRenderer({ label }: { label: string }) {
  return (
    <pre style={{ padding: 16, color: "#888", margin: 0, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>
      {label} renderer not yet implemented (filled in by later task)
    </pre>
  );
}
