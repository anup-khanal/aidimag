/**
 * Structure-aware chunking for large knowledge documents. We split on natural
 * boundaries (Markdown headings first, then blank-line paragraphs) and pack
 * sections up to ~chunkBytes, so a chunk is a coherent unit rather than a
 * byte-count cut mid-sentence. Each chunk is summarized independently and the
 * resulting claims are deduplicated across the whole document.
 */

/** Split text into coherent chunks no larger than ~chunkBytes (best effort). */
export function chunkText(content: string, chunkBytes: number): string[] {
  if (Buffer.byteLength(content, "utf8") <= chunkBytes) return [content];

  // First pass: break at Markdown headings (keep the heading with its body).
  const sections = splitOnHeadings(content);

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const section of sections) {
    // A single section bigger than the budget → split it further on paragraphs.
    if (Buffer.byteLength(section, "utf8") > chunkBytes) {
      flush();
      for (const part of splitOnParagraphs(section, chunkBytes)) chunks.push(part);
      continue;
    }
    if (buf && Buffer.byteLength(buf + "\n\n" + section, "utf8") > chunkBytes) flush();
    buf = buf ? buf + "\n\n" + section : section;
  }
  flush();
  return chunks.length ? chunks : [content];
}

/** Group lines into sections that each start at a Markdown heading. */
function splitOnHeadings(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.some((l) => l.trim())) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n"));
  return sections;
}

/** Pack blank-line-separated paragraphs up to the byte budget. */
function splitOnParagraphs(text: string, chunkBytes: number): string[] {
  const paras = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf && Buffer.byteLength(buf + "\n\n" + para, "utf8") > chunkBytes) {
      out.push(buf.trim());
      buf = "";
    }
    // A single paragraph over budget: hard-wrap by characters as a last resort.
    if (Buffer.byteLength(para, "utf8") > chunkBytes) {
      if (buf.trim()) {
        out.push(buf.trim());
        buf = "";
      }
      for (let i = 0; i < para.length; i += chunkBytes) out.push(para.slice(i, i + chunkBytes));
      continue;
    }
    buf = buf ? buf + "\n\n" + para : para;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

