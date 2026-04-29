import { useMemo } from "react";
import DOMPurify from "dompurify";

export function HtmlRenderer({ data }: { data: Uint8Array }) {
  const html = useMemo(() => {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    return DOMPurify.sanitize(text, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ["script"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });
  }, [data]);

  return (
    <iframe
      sandbox=""
      srcDoc={html}
      style={{ width: "100%", height: "100%", border: "none", background: "white", display: "block" }}
      title="HTML preview"
    />
  );
}
