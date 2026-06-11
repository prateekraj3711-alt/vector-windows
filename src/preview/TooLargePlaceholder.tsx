import { invoke } from "@tauri-apps/api/core";
import { REVEAL_LABEL } from "../platform";

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function TooLargePlaceholder({
  filePath,
  sizeBytes,
  capBytes,
}: {
  filePath: string;
  sizeBytes: number;
  capBytes: number;
}) {
  return (
    <div style={{ padding: 24, color: "#aaa" }}>
      <div style={{ marginBottom: 8 }}>
        File too large to preview ({fmtBytes(sizeBytes)} &gt; {fmtBytes(capBytes)} limit).
      </div>
      <button onClick={() => invoke("open_default_app", { path: filePath })}>
        Open in default app
      </button>
      <button
        style={{ marginLeft: 8 }}
        onClick={() => invoke("reveal_in_finder", { path: filePath })}
      >
        {REVEAL_LABEL}
      </button>
    </div>
  );
}
