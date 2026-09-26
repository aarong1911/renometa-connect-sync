// netlify/functions/lib/gmail-mime.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-mime.test.ts
// (Node 22/24 native TypeScript type stripping + built-in test runner; the module
//  under test has no imports and no network. Fixtures are shaped like real Gmail
//  API `format=full` payloads.)

import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase64Url, decodeHtmlEntities, extractGmailBody, htmlToText, type GmailPayloadPart } from "./gmail-mime.ts";

/** Gmail's body.data encoding: base64url, no padding. */
const b64u = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const plain = (text: string, extra: Partial<GmailPayloadPart> = {}): GmailPayloadPart => ({
  mimeType: "text/plain",
  filename: "",
  headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
  body: { size: text.length, data: b64u(text) },
  ...extra,
});
const html = (markup: string, extra: Partial<GmailPayloadPart> = {}): GmailPayloadPart => ({
  mimeType: "text/html",
  filename: "",
  headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
  body: { size: markup.length, data: b64u(markup) },
  ...extra,
});
const pdf: GmailPayloadPart = {
  mimeType: "application/pdf",
  filename: "estimate.pdf",
  headers: [{ name: "Content-Disposition", value: 'attachment; filename="estimate.pdf"' }],
  body: { size: 5000, attachmentId: "ANGjdJ8x" },
};

// ── the required scenarios ─────────────────────────────────────────────────

test("1. plain text payload (body data directly on the top-level payload)", () => {
  const r = extractGmailBody({ mimeType: "text/plain", headers: [], body: { data: b64u("Hi Aaron,\n\nSee you Tuesday.\n\nMike") } });
  assert.equal(r.text, "Hi Aaron,\n\nSee you Tuesday.\n\nMike");
  assert.equal(r.source, "plain");
});

test("2. HTML-only payload becomes readable text (paragraphs, breaks, entities, no markup)", () => {
  const r = extractGmailBody(html("<div>Hello <b>Aaron</b>,<br><br>The quote is $4,500 &amp; includes labour.</div><p>Thanks!</p>"));
  assert.equal(r.source, "html");
  assert.equal(r.text, "Hello Aaron,\n\nThe quote is $4,500 & includes labour.\n\nThanks!");
  assert.ok(!/[<>]/.test(r.text));
});

test("3. multipart/alternative prefers the text/plain part", () => {
  const r = extractGmailBody({
    mimeType: "multipart/alternative",
    parts: [plain("plain version"), html("<p>html version</p>")],
  });
  assert.equal(r.text, "plain version");
  assert.equal(r.source, "plain");
});

test("3b. multipart/alternative falls back to HTML when the plain part is empty", () => {
  const r = extractGmailBody({
    mimeType: "multipart/alternative",
    parts: [plain("   \n"), html("<p>only html has text</p>")],
  });
  assert.equal(r.text, "only html has text");
  assert.equal(r.source, "html");
});

test("4. multipart/mixed: body text kept, attachments (pdf, named .txt, inline disposition) never leak into it", () => {
  const namedTxt = plain("SECRET ATTACHMENT CONTENT", { filename: "notes.txt", headers: [{ name: "Content-Disposition", value: 'attachment; filename="notes.txt"' }] });
  const r = extractGmailBody({
    mimeType: "multipart/mixed",
    parts: [plain("Please review the attached estimate."), pdf, namedTxt],
  });
  assert.equal(r.text, "Please review the attached estimate.");
  assert.ok(!r.text.includes("SECRET"));
});

test("5. nested multipart (mixed > alternative, related > html) — the real Gmail shape", () => {
  const r = extractGmailBody({
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [plain("Nested plain body"), { mimeType: "multipart/related", parts: [html("<p>Nested html body</p>"), { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "x" } }] }],
      },
      pdf,
    ],
  });
  assert.equal(r.text, "Nested plain body");

  const htmlOnly = extractGmailBody({
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "multipart/related", parts: [html("<div>Deep <i>html</i></div>")] }] }],
  });
  assert.equal(htmlOnly.text, "Deep html");
});

test("5b. multiple inline text parts in multipart/mixed are joined in order", () => {
  const r = extractGmailBody({ mimeType: "multipart/mixed", parts: [plain("first part"), plain("second part")] });
  assert.equal(r.text, "first part\n\nsecond part");
});

test("6. base64url decoding: url-safe alphabet, missing padding, UTF-8 and non-UTF-8 charsets", () => {
  // bytes that encode to '-' and '_' in base64url (0xfb 0xff 0xbe -> "-_--")
  assert.deepEqual([...decodeBase64Url("-_--")], [0xfb, 0xff, 0xbe]);
  assert.equal(decodeBase64Url(b64u("é")).toString("utf8"), "é");
  const utf8 = extractGmailBody(plain("Café — 4.5 m² • naïve 👍"));
  assert.equal(utf8.text, "Café — 4.5 m² • naïve 👍");
  // ISO-8859-1 bytes for "Café"
  const latin1 = extractGmailBody({
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }],
    body: { data: b64u(Buffer.from([0x43, 0x61, 0x66, 0xe9])) },
  });
  assert.equal(latin1.text, "Café");
  // unknown charset label does not throw
  const weird = extractGmailBody({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=x-nonexistent" }], body: { data: b64u("ok") } });
  assert.equal(weird.text, "ok");
});

test("7. attachment-only message has no body text", () => {
  const r = extractGmailBody({ mimeType: "multipart/mixed", parts: [pdf, { mimeType: "image/jpeg", filename: "site.jpg", body: { attachmentId: "y" } }] });
  assert.deepEqual(r, { text: "", source: "none", truncated: false });
});

test("8. missing / empty body falls back safely (never throws)", () => {
  for (const payload of [undefined, null, {}, { mimeType: "text/plain" }, { mimeType: "text/plain", body: { size: 0 } }, { mimeType: "multipart/mixed", parts: [] }, { mimeType: "text/html", body: { data: b64u("") } }] as Array<GmailPayloadPart | null | undefined>) {
    const r = extractGmailBody(payload);
    assert.equal(r.text, "");
    assert.equal(r.source, "none");
  }
});

test("8b. an oversized body is capped and flagged", () => {
  const r = extractGmailBody(plain("x".repeat(500)), { maxChars: 100 });
  assert.equal(r.text.length, 100);
  assert.equal(r.truncated, true);
});

// ── quotes and signatures are preserved (converted to standard text conventions) ──

test("9. quoted replies are kept as '>' text and the attribution line survives", () => {
  const gmailReply =
    '<div dir="ltr">Sounds good, Tuesday works.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Sep 21, 2026 at 3:04 PM Mike &lt;mike@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex"><div dir="ltr">Can you do Tuesday?<br>Let me know.</div></blockquote></div>';
  const r = extractGmailBody(html(gmailReply));
  assert.equal(
    r.text,
    "Sounds good, Tuesday works.\n\nOn Mon, Sep 21, 2026 at 3:04 PM Mike <mike@example.com> wrote:\n> Can you do Tuesday?\n> Let me know.",
  );
});

test("9b. Gmail's signature container becomes the standard '-- ' delimiter", () => {
  const r = extractGmailBody(html('<div>Thanks!</div><div><br></div><div data-smartmail="gmail_signature"><div>Aaron G.<br>RenoMeta</div></div>'));
  assert.equal(r.text, "Thanks!\n\n-- \nAaron G.\nRenoMeta");
});

test("9c. HTML that could execute or load remote content contributes only its text", () => {
  const r = extractGmailBody(
    html('<style>.x{background:url(http://evil/x.png)}</style><script>alert(1)</script><p onclick="steal()">Visible</p><img src="http://tracker.example/pixel.gif" width="1" height="1"><a href="javascript:alert(2)">link text</a><!-- hidden comment -->'),
  );
  assert.equal(r.text, "Visible\n\nlink text");
  assert.ok(!/tracker|evil|alert|steal|javascript|hidden/.test(r.text));
});

test("9d. lists, headings, tables and <pre> keep readable structure", () => {
  assert.equal(htmlToText("<h2>Scope</h2><ul><li>Demo</li><li>Frame</li></ul>"), "Scope\n\n- Demo\n- Frame");
  assert.equal(htmlToText("<table><tr><td>Deck</td><td>$1,200</td></tr><tr><td>Rail</td><td>$300</td></tr></table>"), "Deck $1,200\nRail $300");
  assert.equal(htmlToText("<pre>line one\n  indented</pre>"), "line one\n  indented");
});

test("9e. entity decoding: named, decimal, hex, unknown left alone", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry &#39;s &#x2014; &nbsp;&unknown;"), "Tom & Jerry 's —  &unknown;");
});
