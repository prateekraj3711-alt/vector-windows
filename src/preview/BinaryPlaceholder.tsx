import { invoke } from "@tauri-apps/api/core";
import { REVEAL_LABEL } from "../platform";

export function BinaryPlaceholder({ filePath }: { filePath: string }) {
  return (
    <div style={{ padding: 24, color: "#aaa" }}>
      <div style={{ marginBottom: 12 }}>Binary file — preview not available.</div>
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
