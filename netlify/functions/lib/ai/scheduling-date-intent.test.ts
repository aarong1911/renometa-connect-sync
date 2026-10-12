// netlify/functions/lib/ai/scheduling-date-intent.test.ts
//
// Run:  node --test netlify/functions/lib/ai/scheduling-date-intent.test.ts
//
// LIVE BUG FIX. A real production-preview Scheduling turn proved the
// model cannot be trusted to turn "Thursday afternoon" into an
// authoritative calendar date — see scheduling-date-intent.ts's own
// header for the full root cause. This file is the focused unit-test
// matrix for resolveDateIntent(), the one trusted deterministic resolver
// that replaces that model arithmetic. Pure, no Supabase, no model, no
// network — fixed `now` values throughout, always America/New_York.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "scheduling-date-intent-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "scheduling-date-intent.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const TZ = "America/New_York";

/** `hour` is a local (America/New_York) hour; EDT (UTC-4) applies for
 * every date used in this file (none fall in winter DST). Matches the
 * exact helper convention every other scheduling test file in this repo
 * already uses. */
function nyInstant(ymd: string, hour = 12): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour + 4, 0, 0));
}

// ── 1. LIVE BUG REPRODUCTION ──────────────────────────────────────────────

test("1. LIVE BUG REPRODUCTION: now=2026-10-11 (the real org-local date the live defect occurred on), weekday=thursday/next_occurrence resolves to 2026-10-15, and MUST NOT return 2026-10-16", () => {
  const result = S.resolveDateIntent({
    dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" },
    timeZone: TZ,
    now: nyInstant("2026-10-11"),
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.date, "2026-10-15");
  assert.notEqual(result.date, "2026-10-16", "this is the exact wrong date the live, model-computed defect produced");
});

// ── 2-4. "tomorrow" across ordinary/month/year boundaries ────────────────

test("2. tomorrow across an ordinary day: 2026-10-11 -> 2026-10-12", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "tomorrow" }, timeZone: TZ, now: nyInstant("2026-10-11") });
  assert.deepEqual(result, { status: "resolved", date: "2026-10-12" });
});

test("3. tomorrow across a month boundary: 2026-10-31 -> 2026-11-01", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "tomorrow" }, timeZone: TZ, now: nyInstant("2026-10-31") });
  assert.deepEqual(result, { status: "resolved", date: "2026-11-01" });
});

test("4. tomorrow across a year boundary: 2026-12-31 -> 2027-01-01", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "tomorrow" }, timeZone: TZ, now: nyInstant("2026-12-31") });
  assert.deepEqual(result, { status: "resolved", date: "2027-01-01" });
});

// ── 5-6. weekday resolution near month/year boundaries ───────────────────

test("5. weekday near a month boundary resolves correctly across it: 2026-10-29 (Thursday) -> next_occurrence 'thursday' is TODAY (see bare-weekday semantics below), 'friday' rolls into November", () => {
  // 2026-10-29 is a Thursday (confirmed via real calendar math, not assumed).
  const todaySame = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-10-29") });
  assert.deepEqual(todaySame, { status: "resolved", date: "2026-10-29" });

  const rollsOver = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "sunday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-10-29") });
  assert.deepEqual(rollsOver, { status: "resolved", date: "2026-11-01" });
});

test("6. weekday near a year boundary resolves correctly across it: from 2026-12-30 (Wednesday), the next Friday rolls into January 2027", () => {
  // 2026-12-30 is a Wednesday (confirmed via real calendar math).
  const result = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "friday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-12-30") });
  assert.deepEqual(result, { status: "resolved", date: "2027-01-01" });
});

// ── 7. "next Thursday" vs bare "Thursday" ─────────────────────────────────

test("7. 'next Thursday' (occurrence: next_week) is distinct from, and always exactly 7 days later than, bare 'Thursday' (next_occurrence) — regardless of today's own weekday", () => {
  const bare = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-10-11") });
  const next = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_week" }, timeZone: TZ, now: nyInstant("2026-10-11") });
  assert.equal(bare.date, "2026-10-15");
  assert.equal(next.date, "2026-10-22");
  assert.notEqual(bare.date, next.date);

  // Documented bare-weekday rule: when today itself IS the requested
  // weekday, next_occurrence means TODAY (0 days ahead) — "next_week"
  // must still always be a full 7 days later than that, never the same
  // day and never ambiguous about which "week" is meant.
  const todayIsThursday = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-10-15") });
  const nextThursdayFromThursday = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_week" }, timeZone: TZ, now: nyInstant("2026-10-15") });
  assert.equal(todayIsThursday.date, "2026-10-15", "bare 'Thursday' said ON a Thursday means today");
  assert.equal(nextThursdayFromThursday.date, "2026-10-22", "'next Thursday' said on a Thursday must still mean a full week out, never today");
});

// ── 8. today in America/New_York when the UTC date differs ──────────────

test("8. 'today' resolves to the ORG-LOCAL calendar date, not the UTC date, when they differ", () => {
  // 2026-10-12T02:30:00Z is 2026-10-11 22:30 in America/New_York (EDT) — a
  // different calendar day than the raw UTC instant.
  const now = new Date("2026-10-12T02:30:00.000Z");
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "today" }, timeZone: TZ, now });
  assert.equal(result.status, "resolved");
  assert.equal(result.date, "2026-10-11", "must be the org-local date, not 2026-10-12 (the raw UTC date)");
});

// ── 9. DST transition weekend ────────────────────────────────────────────

test("9. a DST transition occurring between 'now' and the target date never perturbs calendar-day resolution — America/New_York falls back on 2026-11-01", () => {
  // 'now' is the Saturday before the US fall-back DST transition (EDT,
  // UTC-4); the resolved 'tomorrow' (Sunday 2026-11-01) is the actual
  // transition day itself (EST, UTC-5) — the calendar date must still
  // resolve correctly, with no wall-clock offset math involved at all.
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "tomorrow" }, timeZone: TZ, now: nyInstant("2026-10-31") });
  assert.deepEqual(result, { status: "resolved", date: "2026-11-01" });

  // A weekday resolution that spans the same transition weekend.
  const weekdayAcrossDst = S.resolveDateIntent({ dateIntent: { kind: "weekday", weekday: "monday", occurrence: "next_occurrence" }, timeZone: TZ, now: nyInstant("2026-10-30") });
  assert.deepEqual(weekdayAcrossDst, { status: "resolved", date: "2026-11-02" });
});

// ── 10. invalid timezone fails closed ────────────────────────────────────

test("10. an invalid timezone fails closed — never resolves to a guessed/UTC date", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "relative_day", value: "today" }, timeZone: "Not/ARealZone", now: nyInstant("2026-10-11") });
  assert.deepEqual(result, { status: "invalid_timezone" });
});

// ── 11. invalid explicit date fails closed ───────────────────────────────

test("11. a syntactically well-formed but impossible explicit date (e.g. 2026-02-30) fails closed, never silently rolled into a different real date", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "explicit_date", date: "2026-02-30" }, timeZone: TZ, now: nyInstant("2026-01-01") });
  assert.equal(result.status, "invalid_explicit_date");
});

// ── 12. leap-day validation ───────────────────────────────────────────────

test("12. leap-day validation: Feb 29 is valid in a real leap year (2028) and invalid in a non-leap year (2026)", () => {
  const validLeap = S.resolveDateIntent({ dateIntent: { kind: "explicit_date", date: "2028-02-29" }, timeZone: TZ, now: nyInstant("2026-01-01") });
  assert.deepEqual(validLeap, { status: "resolved", date: "2028-02-29" });

  const invalidNonLeap = S.resolveDateIntent({ dateIntent: { kind: "explicit_date", date: "2026-02-29" }, timeZone: TZ, now: nyInstant("2026-01-01") });
  assert.equal(invalidNonLeap.status, "invalid_explicit_date");
});

test("a real, valid explicit date is accepted exactly as given", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "explicit_date", date: "2026-10-22" }, timeZone: TZ, now: nyInstant("2026-10-11") });
  assert.deepEqual(result, { status: "resolved", date: "2026-10-22" });
});

test("an unrecognized dateIntent kind fails closed with invalid_intent, never a guessed date", () => {
  const result = S.resolveDateIntent({ dateIntent: { kind: "sometime_later" } as any, timeZone: TZ, now: nyInstant("2026-10-11") });
  assert.equal(result.status, "invalid_intent");
});
