// src/routes/-leads-toast.test.ts
//
// Run:  node --test src/routes/-leads-toast.test.ts
//   (filename starts with "-" so the TanStack Router file-based route
//   generator excludes it from the route tree — see routeFileIgnorePrefix
//   in the build output.)
//
// AI-3D/AI-3E. Covers:
//   9. the toast no longer references the nonexistent "Activity" tab
//      (source-text check on leads.tsx — see below for why this file is
//      checked as plain text rather than rendered)
//   - correct toast copy, correct destination, explicit longer duration,
//     and the action callback's actual navigation target — all against the
//     REAL pure helper in lead-qualification-toast.ts, not a re-typed copy.
//
// leads.tsx itself pulls in a large tree of app-wide providers/routing that
// isn't worth mounting just to assert a string literal and a toast call
// site — the same reasoning ai-run-inspector.tsx's own predicate and this
// toast's own options were pulled out into pure, independently-testable
// units instead of being asserted only via JSX/DOM rendering.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEAD_QUALIFICATION_TOAST_MESSAGE,
  LEAD_QUALIFICATION_TOAST_DURATION_MS,
  LEAD_QUALIFICATION_TOAST_DESTINATION,
  buildLeadQualificationSuccessToastOptions,
} from "../lib/lead-qualification-toast.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "leads.tsx"), "utf8");

test("9. the Run Lead Qualification success toast no longer references the nonexistent 'Activity' tab", () => {
  assert.ok(!/AI Center.*Activity/.test(source), "toast text must not say 'AI Center → Activity' — no such tab exists");
});

test("leads.tsx actually uses the shared toast message/options helper, not an inline re-typed copy", () => {
  assert.ok(source.includes("LEAD_QUALIFICATION_TOAST_MESSAGE"), "expected leads.tsx to import and use the shared toast message constant");
  assert.ok(source.includes("buildLeadQualificationSuccessToastOptions"), "expected leads.tsx to import and use the shared toast options builder");
});

test("correct toast copy: mentions AI Center and Test Console, not 'Activity'", () => {
  assert.equal(LEAD_QUALIFICATION_TOAST_MESSAGE, "Lead Qualification ran. View it in AI Center → Test Console.");
});

test("explicit longer duration: 10-15s range, well above sonner's 4s default, no race against the timeout", () => {
  assert.ok(LEAD_QUALIFICATION_TOAST_DURATION_MS >= 10000, "duration must be at least 10s");
  assert.ok(LEAD_QUALIFICATION_TOAST_DURATION_MS <= 15000, "duration must be at most 15s (per the requested range)");
  assert.ok(LEAD_QUALIFICATION_TOAST_DURATION_MS > 4000, "must exceed sonner's own 4s default — that default was the actual root cause");
});

test("correct destination: navigates to /ai-center with tab=console, matching ai-center.tsx's real validateSearch() contract", () => {
  assert.deepEqual(LEAD_QUALIFICATION_TOAST_DESTINATION, { to: "/ai-center", search: { tab: "console" } });
});

test("action callback exists and its onClick invokes navigate with the exact destination object", () => {
  let received: unknown;
  const fakeNavigate = (destination: unknown) => { received = destination; };
  const options = buildLeadQualificationSuccessToastOptions(fakeNavigate);
  assert.equal(options.duration, LEAD_QUALIFICATION_TOAST_DURATION_MS);
  assert.equal(typeof options.action.onClick, "function");
  assert.equal(options.action.label, "View");
  options.action.onClick();
  assert.deepEqual(received, LEAD_QUALIFICATION_TOAST_DESTINATION);
});

test("the action callback does not call navigate until clicked", () => {
  let calls = 0;
  const fakeNavigate = () => { calls++; };
  buildLeadQualificationSuccessToastOptions(fakeNavigate);
  assert.equal(calls, 0, "building the options must not itself navigate");
});
