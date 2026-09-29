// src/routes/leads-toast.test.ts
//
// Run:  node --test src/routes/leads-toast.test.ts
//
// AI-3D, test 9 of 9. Guards a specific regression: the "Run Lead
// Qualification" success toast in leads.tsx used to say "See the
// recommendation in AI Center → Activity" — there is no Activity tab in AI
// Center (its real tabs are agents/tools/voice/agentic/approvals/console,
// see ai-center.tsx's validateSearch()). This is a plain source-text check,
// not a component render test, since leads.tsx pulls in a large tree of
// app-wide providers/routing that isn't worth mounting just to assert a
// string literal — the same reasoning ai-run-inspector.tsx's own predicate
// was pulled out into a pure, independently-testable unit instead of being
// asserted only via JSX.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "leads.tsx"), "utf8");

test("9. the Run Lead Qualification success toast no longer references the nonexistent 'Activity' tab", () => {
  assert.ok(!/AI Center.*Activity/.test(source), "toast text must not say 'AI Center → Activity' — no such tab exists");
});

test("the success toast instead points at Test Console, the real place the run shows up", () => {
  assert.ok(source.includes("Lead Qualification ran. View it in AI Center → Test Console."), "expected the corrected toast wording to be present verbatim");
});
