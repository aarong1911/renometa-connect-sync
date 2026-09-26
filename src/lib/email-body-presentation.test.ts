// src/lib/email-body-presentation.test.ts
//
// Run:  node --test src/lib/email-body-presentation.test.ts
// (native TypeScript type stripping + node:test; the module under test has no
//  imports.) Covers the presentation-only quote / signature / subject helpers
// and the "email text is never rendered as HTML" guarantee.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dequote, normalizeSubject, shouldShowSubject, splitEmailBody } from "./email-body-presentation.ts";

test("10. subject stays a separate field: shown once where it changes, ignoring Re:/Fwd:, never merged into the body", () => {
  assert.equal(normalizeSubject("  RE: Re: FWD:  Kitchen   remodel "), "kitchen remodel");
  assert.equal(shouldShowSubject("Kitchen remodel", undefined, true), true);
  assert.equal(shouldShowSubject("Re: Kitchen remodel", "Kitchen remodel", false), false);
  assert.equal(shouldShowSubject("Deck estimate", "Kitchen remodel", false), true);
  assert.equal(shouldShowSubject("", "Kitchen remodel", false), false);
  assert.equal(shouldShowSubject(null, undefined, true), false);
  // the splitter only ever sees body text: a body that mentions its subject is untouched
  assert.equal(splitEmailBody("Kitchen remodel\n\nHello").main, "Kitchen remodel\n\nHello");
});

test("11. high-confidence quote detection: 'On ... wrote:' + '>' lines are folded, authored text stays", () => {
  const body = "Sounds good, Tuesday works.\n\nOn Mon, Sep 21, 2026 at 3:04 PM Mike <mike@example.com> wrote:\n> Can you do Tuesday?\n> Let me know.";
  const p = splitEmailBody(body);
  assert.equal(p.main, "Sounds good, Tuesday works.");
  assert.equal(p.quoted, "On Mon, Sep 21, 2026 at 3:04 PM Mike <mike@example.com> wrote:\n> Can you do Tuesday?\n> Let me know.");
  assert.equal(p.signature, null);
  assert.equal(dequote(p.quoted!), "On Mon, Sep 21, 2026 at 3:04 PM Mike <mike@example.com> wrote:\nCan you do Tuesday?\nLet me know.");
  // nothing is lost: main + quoted reproduces the original text
  assert.equal(`${p.main}\n\n${p.quoted}`, body);
});

test("11b. wrapped attribution, trailing '>' block, and Outlook 'Original Message' are recognised", () => {
  const wrapped = splitEmailBody("Thanks!\n\nOn Mon, Sep 21, 2026 at 3:04 PM Mike Smith <mike@example.com>\nwrote:\n> hi");
  assert.equal(wrapped.main, "Thanks!");
  assert.ok(wrapped.quoted?.includes("wrote:"));

  const bare = splitEmailBody("See below.\n> earlier line 1\n> earlier line 2");
  assert.equal(bare.main, "See below.");
  assert.equal(bare.quoted, "> earlier line 1\n> earlier line 2");

  const outlook = splitEmailBody("Yes.\n\n-----Original Message-----\nFrom: Mike\nSent: Monday\nSubject: Deck\n\nCan you do Tuesday?");
  assert.equal(outlook.main, "Yes.");
  assert.ok(outlook.quoted?.startsWith("-----Original Message-----"));

  const rule = splitEmailBody("Yes.\n\n________________________________\nFrom: Mike <m@x.com>\nSent: Monday\n\nHi");
  assert.equal(rule.main, "Yes.");
  assert.ok(rule.quoted?.includes("From: Mike"));
});

test("12. no quote marker -> body preserved exactly", () => {
  const body = "Hi Aaron,\n\nHere is the estimate.\nLet me know what you think.\n\nThanks,\nMike";
  const p = splitEmailBody(body);
  assert.deepEqual(p, { main: body, signature: null, quoted: null });
  assert.deepEqual(splitEmailBody(""), { main: "", signature: null, quoted: null });
  assert.deepEqual(splitEmailBody(null), { main: "", signature: null, quoted: null });
});

test("12b. low confidence -> nothing hidden: inline replies, an all-quoted message, a stray 'wrote:'", () => {
  const inline = "On Mon, Mike wrote:\n> Can you do Tuesday?\nYes, Tuesday.\n> And the deck?\nDeck is fine.";
  assert.equal(splitEmailBody(inline).quoted === null || splitEmailBody(inline).main.includes("Yes, Tuesday."), true);
  assert.ok(splitEmailBody(inline).main.includes("Yes, Tuesday."), "the unquoted replies are never folded away");

  const allQuoted = "> forwarded text\n> more forwarded text";
  assert.deepEqual(splitEmailBody(allQuoted), { main: allQuoted, signature: null, quoted: null });

  const stray = "He said he wrote: the plan last week, and I agree.";
  assert.deepEqual(splitEmailBody(stray), { main: stray, signature: null, quoted: null });
});

test("13. standard '-- ' signature delimiter is separated (delimiter omitted, content kept)", () => {
  const p = splitEmailBody("Thanks, see you then.\n\n-- \nAaron G.\nRenoMeta Construction\n555-0100");
  assert.equal(p.main, "Thanks, see you then.");
  assert.equal(p.signature, "Aaron G.\nRenoMeta Construction\n555-0100");
  const noTrailingSpace = splitEmailBody("Ok.\n--\nAaron");
  assert.equal(noTrailingSpace.signature, "Aaron");
  // signature then quoted history: both separated
  const both = splitEmailBody("Ok.\n\n-- \nAaron\n\nOn Mon, Mike wrote:\n> hi");
  assert.equal(both.main, "Ok.");
  assert.equal(both.signature, "Aaron");
  assert.ok(both.quoted?.startsWith("On Mon, Mike wrote:"));
});

test("14. uncertain signature stays in the body: phone/address/company lines, '--' with no content, very long tail", () => {
  const guessy = "Call me.\n\nAaron G.\nRenoMeta Construction\n123 Main St\n555-0100";
  assert.deepEqual(splitEmailBody(guessy), { main: guessy, signature: null, quoted: null });

  const emptySig = splitEmailBody("Hello\n-- ");
  assert.equal(emptySig.signature, null);
  assert.equal(emptySig.main, "Hello\n-- ", "left exactly as written");

  const longTail = "Intro\n-- \n" + Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const p = splitEmailBody(longTail);
  assert.equal(p.signature, null);
  assert.ok(p.main.includes("line 19"));

  const dashFirst = splitEmailBody("-- \nno text before the delimiter");
  assert.equal(dashFirst.signature, null);
});

test("15. HTML safety: email text is only ever rendered as escaped text, never as markup", () => {
  const hostile = '<img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold?</b>';
  const p = splitEmailBody(hostile);
  assert.equal(p.main, hostile, "helpers never interpret or rewrite markup");
  const component = readFileSync(new URL("../components/inbox/email-message-body.tsx", import.meta.url), "utf8");
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/.test(component), "the email component must never inject HTML");
  assert.ok(component.includes("whitespace-pre-wrap"), "body is rendered as pre-wrapped text");
});
