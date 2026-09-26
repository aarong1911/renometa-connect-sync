// netlify/functions/lib/gmail-mime.ts
//
// Turns a Gmail API `format=full` message payload into readable body text.
//
// Why this exists: gmail-sync.ts used to fetch `format=metadata`, which carries
// headers and a ~200-char `snippet` only — so the app could never show a real
// email body. This module extracts the actual message content from the MIME tree.
//
// Design rules:
//   - No dependencies, no AI, no OCR, pure functions (unit-tested with
//     representative Gmail payload fixtures in gmail-mime.test.ts).
//   - Handles: body data directly on the payload or on child parts, nested
//     multipart/{alternative,mixed,related,...}, text/plain, text/html, Gmail
//     base64url encoding, per-part charset, empty/missing bodies.
//   - Attachments (a part with a filename or `Content-Disposition: attachment`,
//     or any non-text part) are never folded into the body text.
//   - multipart/alternative: the text/plain alternative wins when it has content,
//     otherwise the HTML alternative is converted to text.
//   - The result is READABLE TEXT. HTML is intentionally reduced to text here
//     (React escapes text, so nothing from an email is ever injected as markup)
//     rather than stored/rendered as HTML — the repo has no HTML sanitizer, and a
//     homegrown one would be worse than none. Quoted replies and signatures are
//     KEPT, not stripped: blockquotes become "> " quoted lines and Gmail's own
//     signature container becomes a standard "-- " delimiter line, so the
//     presentation layer (src/lib/email-body-presentation.ts) can fold them
//     without any information being lost in storage.
//   - Remote images / tracking pixels are never fetched or referenced: <img> is
//     dropped during conversion.

export type GmailPayloadPart = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name: string; value: string }> | null;
  body?: { size?: number; data?: string | null; attachmentId?: string | null } | null;
  parts?: GmailPayloadPart[] | null;
};

export type ExtractedBody = {
  /** Readable body text ("" when the message has no text content). */
  text: string;
  /** Where the text came from. */
  source: "plain" | "html" | "none";
  /** True when the text was capped at maxChars. */
  truncated: boolean;
};

export const DEFAULT_MAX_BODY_CHARS = 100_000;

// ── Decoding ────────────────────────────────────────────────────────────────

/** Gmail returns body.data as base64url (RFC 4648 §5): `-`/`_` instead of `+`/`/`, padding optional. */
export function decodeBase64Url(data: string): Buffer {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  return Buffer.from(normalized, "base64");
}

function headerOf(part: GmailPayloadPart, name: string): string | null {
  const h = part.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function charsetOf(part: GmailPayloadPart): string {
  const m = headerOf(part, "Content-Type")?.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decodePartText(part: GmailPayloadPart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = decodeBase64Url(data);
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown charset label
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", euro: "€", deg: "°", times: "×", laquo: "«", raquo: "»",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ── HTML -> text ────────────────────────────────────────────────────────────
//
// Output is plain text that the UI renders as text (escaped by React). This is
// NOT a sanitizer and is not used as one.

const SKIP_TAGS = new Set(["script", "style", "head", "title", "noscript", "template"]);
const FLUSH_ON_CLOSE = new Set(["div", "tr", "table", "ul", "ol", "li", "section", "article", "header", "footer", "address", "pre", "dl", "dt", "dd"]);
const PARAGRAPH_ON_CLOSE = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

type Line = { depth: number; text: string };

export function htmlToText(html: string): string {
  const lines: Line[] = [];
  let cur = "";
  let curDepth = 0;
  let depth = 0; // blockquote nesting
  let preDepth = 0;
  const skipStack: string[] = [];

  const flush = () => {
    const text = preDepth > 0 ? cur.replace(/[ \t]+$/g, "") : cur.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, "");
    if (text) lines.push({ depth: curDepth, text });
    cur = "";
  };
  const blank = () => {
    flush();
    if (lines.length > 0 && lines[lines.length - 1].text !== "") lines.push({ depth, text: "" });
  };
  const addText = (t: string) => {
    if (!cur) curDepth = depth;
    cur += t;
  };

  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  for (const tok of tokens) {
    if (tok.startsWith("<!--")) continue;
    if (tok[0] !== "<") {
      if (skipStack.length) continue;
      if (preDepth > 0) {
        // Preserve line structure inside <pre>.
        const parts = decodeHtmlEntities(tok).split(/\r?\n/);
        parts.forEach((p, i) => {
          if (i > 0) flush();
          addText(p);
        });
      } else {
        const collapsed = tok.replace(/\s+/g, " ");
        if (!cur && collapsed === " ") continue;
        addText(decodeHtmlEntities(collapsed).replace(/ /g, " "));
      }
      continue;
    }
    const m = tok.match(/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)\s*>$/);
    if (!m) continue; // "<" that is not a tag (e.g. a stray "<3" or malformed) — dropped from text extraction
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    const selfClosing = m[4] === "/";

    if (SKIP_TAGS.has(name)) {
      if (closing) {
        const i = skipStack.lastIndexOf(name);
        if (i >= 0) skipStack.length = i;
      } else if (!selfClosing) {
        skipStack.push(name);
      }
      continue;
    }
    if (skipStack.length) continue;

    if (name === "br") {
      // <br> ends the line; a <br> on an empty line is a deliberate blank line.
      if (cur.trim() === "") blank();
      else flush();
    } else if (name === "blockquote") {
      flush();
      depth = closing ? Math.max(0, depth - 1) : depth + 1;
    } else if (name === "pre") {
      flush();
      preDepth = closing ? Math.max(0, preDepth - 1) : preDepth + 1;
    } else if (name === "li" && !closing) {
      flush();
      addText("- ");
    } else if (name === "hr") {
      blank();
    } else if ((name === "td" || name === "th") && closing) {
      addText(" ");
    } else if (closing && PARAGRAPH_ON_CLOSE.has(name)) {
      blank();
    } else if (closing && FLUSH_ON_CLOSE.has(name)) {
      flush();
    } else if (!closing && name === "p") {
      blank();
    } else if (!closing && (name === "div" || name === "tr" || name === "ul" || name === "ol" || name === "table")) {
      flush();
    }

    // Gmail's own signature container becomes the standard "-- " delimiter so
    // the presentation layer can recognise it with high confidence.
    if (!closing && /gmail_signature/i.test(attrs)) {
      flush();
      lines.push({ depth, text: "-- " });
    }
    // <img>, <a>, <span>, <b>, ... : inline / ignored (link text is kept; image
    // sources are never emitted, so nothing remote is ever referenced).
  }
  flush();

  const out: string[] = [];
  let lastBlank = true;
  for (const l of lines) {
    const prefix = l.depth > 0 ? "> ".repeat(l.depth) : "";
    if (l.text === "") {
      if (!lastBlank) out.push(l.depth > 0 ? ">".repeat(l.depth) : "");
      lastBlank = true;
    } else {
      out.push(prefix + l.text);
      lastBlank = false;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── MIME tree ───────────────────────────────────────────────────────────────

function isAttachment(part: GmailPayloadPart): boolean {
  if (part.filename && part.filename.trim()) return true;
  const disp = headerOf(part, "Content-Disposition");
  return !!disp && /^\s*attachment\b/i.test(disp);
}

type Walked = { text: string; source: "plain" | "html" };

function walk(part: GmailPayloadPart): Walked | null {
  if (isAttachment(part)) return null;
  const mime = (part.mimeType ?? "").toLowerCase();

  if (mime.startsWith("multipart/") || (!mime && part.parts?.length)) {
    const children = (part.parts ?? []).map(walk).filter((w): w is Walked => !!w && w.text.trim() !== "");
    if (children.length === 0) return null;
    if (mime === "multipart/alternative") {
      // Same content in several formats — take the plain one when it has text,
      // otherwise the (first non-empty) HTML one.
      return children.find((c) => c.source === "plain") ?? children[0];
    }
    return {
      text: children.map((c) => c.text).join("\n\n"),
      source: children.every((c) => c.source === "plain") ? "plain" : "html",
    };
  }

  if (mime === "text/html") {
    const text = htmlToText(decodePartText(part));
    return text ? { text, source: "html" } : null;
  }
  if (mime === "text/plain" || (!mime && part.body?.data)) {
    const text = decodePartText(part).replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
    return text.trim() ? { text, source: "plain" } : null;
  }
  return null; // images, pdfs, calendar invites, ... are not body text
}

export function extractGmailBody(
  payload: GmailPayloadPart | null | undefined,
  opts: { maxChars?: number } = {},
): ExtractedBody {
  const max = opts.maxChars ?? DEFAULT_MAX_BODY_CHARS;
  if (!payload) return { text: "", source: "none", truncated: false };
  const walked = walk(payload);
  if (!walked) return { text: "", source: "none", truncated: false };
  const truncated = walked.text.length > max;
  return { text: truncated ? walked.text.slice(0, max) : walked.text, source: walked.source, truncated };
}
