import { convertFileSrc } from "@tauri-apps/api/core";

export function ImageRenderer({ filePath }: { filePath: string }) {
  const src = convertFileSrc(filePath);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: "#0a0a0a" }}>
      <img
        src={src}
        alt={filePath}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
