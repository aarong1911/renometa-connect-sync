// src/lib/email-body-presentation.ts
//
// PRESENTATION-ONLY helpers for rendering an email body in a Conversations
// thread. Nothing here changes what is stored: gmail_messages.body_text keeps
// the full message (signature and quoted history included); these functions only
// decide how to LAY IT OUT — the newest authored text first, a signature set
// apart, quoted earlier messages folded behind a toggle.
//
// Rules of engagement:
//   - High confidence or nothing. If a boundary is not clearly one of the
//     conventions below, the whole text is returned as `main` and nothing is
//     hidden. Content is never dropped, only regrouped.
//   - No dependencies, no HTML. Input and output are plain text; the caller
//     renders it as text (React escapes it), so email markup can never execute.
//
// Recognised quote boundaries (earliest one that qualifies wins):
//   1. An attribution line `On <date/person> wrote:` (may wrap onto the next
//      line) followed ONLY by `>`-quoted lines to the end. If the text after it
//      has unquoted lines mixed in (inline replies), nothing is folded.
//   2. `-----Original Message-----` (Outlook plain text).
//   3. An Outlook underscore rule (`______`) immediately followed by `From:`.
//   4. A trailing block made only of `>`-quoted lines.
// A boundary that would leave no authored text before it is ignored (an email
// that is entirely quoted is shown in full).
//
// Recognised signature: the standard RFC 3676 delimiter line `-- ` (or `--`)
// with at most SIGNATURE_MAX_LINES lines after it. Phone numbers, addresses or
// company names are never guessed to be a signature.

export type EmailBodyParts = {
  /** The authored message. Always the whole text when nothing was confidently detected. */
  main: string;
  /** Signature text after a `-- ` delimiter (delimiter line omitted), or null. */
  signature: string | null;
  /** Folded prior-thread text (original `>` prefixes kept), or null. */
  quoted: string | null;
};

export const SIGNATURE_MAX_LINES = 12;

const ATTRIBUTION = /^on\s.{3,300}\swrote:?\s*$/i;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i;
const OUTLOOK_RULE = /^_{10,}\s*$/;
const OUTLOOK_FROM = /^\s*from:\s/i;
const SIG_DELIMITER = /^--\s?$/;

const isQuotedLine = (l: string) => l.trimStart().startsWith(">");
const isBlank = (l: string) => l.trim() === "";

function nextNonBlank(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (!isBlank(lines[i])) return i;
  return -1;
}

function tailIsAllQuoted(lines: string[], from: number): boolean {
  let any = false;
  for (let i = from; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (!isQuotedLine(lines[i])) return false;
    any = true;
  }
  return any;
}

function hasAuthoredTextBefore(lines: string[], end: number): boolean {
  for (let i = 0; i < end; i++) if (!isBlank(lines[i])) return true;
  return false;
}

function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let boundary = -1;

    // 1. "On ... wrote:" (single line, or wrapped onto the next line)
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}`.trim() : line;
    if (ATTRIBUTION.test(line)) {
      if (tailIsAllQuoted(lines, i + 1)) boundary = i;
    } else if (/^on\s/i.test(line) && ATTRIBUTION.test(joined) && !line.endsWith(":")) {
      if (tailIsAllQuoted(lines, i + 2)) boundary = i;
    }
    // 2. Outlook "Original Message"
    if (boundary < 0 && ORIGINAL_MESSAGE.test(lines[i]) && nextNonBlank(lines, i + 1) >= 0) boundary = i;
    // 3. Outlook underscore rule followed by a From: header
    if (boundary < 0 && OUTLOOK_RULE.test(line)) {
      const n = nextNonBlank(lines, i + 1);
      if (n >= 0 && n <= i + 2 && OUTLOOK_FROM.test(lines[n])) boundary = i;
    }
    // 4. Trailing block of ">" lines (pull the attribution-like line above it in)
    if (boundary < 0 && isQuotedLine(lines[i]) && tailIsAllQuoted(lines, i)) {
      boundary = i;
      const prev = i - 1;
      if (prev >= 0 && lines[prev].trim().endsWith(":") && !isBlank(lines[prev])) boundary = prev;
    }

    if (boundary >= 0) return hasAuthoredTextBefore(lines, boundary) ? boundary : -1;
  }
  return -1;
}

function trimBlankEdges(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && isBlank(lines[s])) s++;
  while (e > s && isBlank(lines[e - 1])) e--;
  return lines.slice(s, e);
}

export function splitEmailBody(body: string | null | undefined): EmailBodyParts {
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const qStart = findQuoteStart(lines);
  const mainLines = qStart >= 0 ? lines.slice(0, qStart) : lines;
  const quotedLines = qStart >= 0 ? trimBlankEdges(lines.slice(qStart)) : [];

  let signature: string | null = null;
  let authored = mainLines;
  const sigIdx = mainLines.findIndex((l) => SIG_DELIMITER.test(l));
  if (sigIdx > 0 && hasAuthoredTextBefore(mainLines, sigIdx)) {
    const sigLines = trimBlankEdges(mainLines.slice(sigIdx + 1));
    if (sigLines.length > 0 && sigLines.length <= SIGNATURE_MAX_LINES) {
      signature = sigLines.join("\n");
      authored = mainLines.slice(0, sigIdx);
    }
  }

  return {
    main: trimBlankEdges(authored).join("\n"),
    signature,
    quoted: quotedLines.length > 0 ? quotedLines.join("\n") : null,
  };
}

/** Removes one level of leading `> ` from each line, for readable display of folded quoted text. */
export function dequote(quoted: string): string {
  return quoted
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .join("\n");
}

/** Subject with any run of Re:/Fwd:/Fw: prefixes removed, whitespace collapsed, lowercased — for comparing. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^(re|fwd?)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The subject is its own field, shown once where it changes: on the first email
 * of a thread and whenever it differs (ignoring Re:/Fwd:) from the previous
 * email's subject. Never merged into the body.
 */
export function shouldShowSubject(subject: string | null | undefined, previousSubject: string | null | undefined, isFirst: boolean): boolean {
  const cur = normalizeSubject(subject);
  if (!cur) return false;
  if (isFirst) return true;
  return cur !== normalizeSubject(previousSubject);
}
