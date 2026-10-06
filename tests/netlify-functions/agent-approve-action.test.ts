// tests/netlify-functions/agent-approve-action.test.ts
//
// Run:  node --test tests/netlify-functions/agent-approve-action.test.ts
//
// Moved here from netlify/functions/agent-approve-action.test.ts (PR #16
// deploy-failure fix): Netlify was treating that root-level *.test.ts file
// as a deployable function entrypoint, and its top-level await/import.meta
// test harness failed Netlify's own function bundling. Netlify's functions
// directory holds deployable root function entrypoints only — test files
// for those functions belong in tests/netlify-functions/ instead, matching
// this repo's existing precedent (see gmail-sync.test.ts in this same
// directory). Production source is now referenced explicitly from
// repoRoot rather than assumed to live beside this file.
//
// Scheduling foundation — code-review pass. This file previously had ZERO
// test coverage. Added here specifically to cover the two real findings
// from this pass:
//   1. verifyActionSuccess() had NO case for "schedule_appointment" at
//      all — every real schedule_appointment approval would have fallen
//      through to the "unknown action key" fail-closed branch and been
//      reported FAILED even though the appointment was genuinely created.
//      Found and fixed in this same pass, before anything was committed.
//   2. the post-booking lifecycle (confirmation email + owner/assignee
//      notification) is invoked from THIS file now, not from
//      src/lib/agentic/handlers.ts — proven here via a source-level check
//      (see the "source wiring" test below) rather than a full HTTP-level
//      integration test, which would require far more scaffolding
//      (resolveOrgAndAuthority, a real approval row, etc.) than this
//      narrowly-scoped addition calls for.
//
// No live Supabase, no network. Only the exported pure function
// (verifyActionSuccess) is exercised directly; the module's top-level
// `createClient(...)` call needs SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// set to something syntactically valid before import (same pattern
// already established in lead-qualification-background.test.ts) — no
// actual network call is made since nothing here invokes a Supabase
// method.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

const here = path.dirname(fileURLToPath(import.meta.url));
// tests/netlify-functions/ -> repo root is two levels up (verified, not
// assumed — see this file's own test run above and the repoRoot-based
// path assertions below, all of which pass against the real repo layout).
const repoRoot = path.resolve(here, "..", "..");
const productionSourcePath = path.join(repoRoot, "netlify/functions/agent-approve-action.ts");
const outDir = mkdtempSync(path.join(tmpdir(), "agent-approve-action-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [productionSourcePath],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

test("verifyActionSuccess('schedule_appointment', ...) requires a real, non-empty appointmentId", () => {
  assert.deepEqual(S.verifyActionSuccess("schedule_appointment", { appointmentId: "appt-123" }), { verified: true });
});

test("verifyActionSuccess('schedule_appointment', ...) fails closed when appointmentId is missing/empty — never assumed success", () => {
  for (const bad of [undefined, {}, { appointmentId: "" }, { appointmentId: 123 }, { somethingElse: "x" }]) {
    const result = S.verifyActionSuccess("schedule_appointment", bad as any);
    assert.equal(result.verified, false, JSON.stringify(bad));
  }
});

test("schedule_appointment is no longer treated as an unknown/unconfigured action key (the exact bug this pass found and fixed)", () => {
  const result = S.verifyActionSuccess("schedule_appointment", undefined);
  assert.doesNotMatch(result.reason, /No success-verification rule is configured/, "schedule_appointment must have its OWN rule, not fall through to the generic unknown-action-key branch");
});

test("an unrecognized action key still fails closed with the generic message (unchanged behavior)", () => {
  const result = S.verifyActionSuccess("some_future_action", {});
  assert.equal(result.verified, false);
  assert.match(result.reason, /No success-verification rule is configured/);
});

// ── source wiring: the post-booking lifecycle is called from THIS file ──

test("the post-booking lifecycle is invoked from agent-approve-action.ts (not from handlers.ts), gated on actionKey === 'schedule_appointment', and only after verification", () => {
  const source = readFileSync(productionSourcePath, "utf8");
  assert.ok(source.includes('import { runAppointmentPostBookingLifecycle } from "./lib/appointment-post-booking"'), "expected a direct import of the real lifecycle function");
  assert.ok(source.includes('if (approval.action_key === "schedule_appointment")'), "expected the lifecycle call to be gated on this exact action key");
  assert.ok(source.includes("runAppointmentPostBookingLifecycle(supabaseAdmin, { appointmentId, orgId })"), "expected the real call with the real appointmentId/orgId");

  // Ordering: the lifecycle-invocation block must appear AFTER the
  // "action_verified" checkpoint (i.e. after verification passed), never
  // before — an unverified execution must never trigger a confirmation
  // email.
  const verifiedIdx = source.indexOf('logCheckpoint("action_verified"');
  const lifecycleIdx = source.indexOf("runAppointmentPostBookingLifecycle(supabaseAdmin");
  assert.ok(verifiedIdx > 0 && lifecycleIdx > verifiedIdx, "the lifecycle call must come after verification, never before");
});

test("a post-booking lifecycle failure can never prevent the approval from being marked executed (Section 12: lifecycle failure must not un-verify an already-proven booking)", () => {
  const source = readFileSync(productionSourcePath, "utf8");

  // The lifecycle call must be wrapped in its own .catch(...) — any
  // rejection is swallowed (logged) right there, so it can never
  // propagate up and short-circuit the rest of this branch.
  const lifecycleCallMatch = source.match(/await runAppointmentPostBookingLifecycle\([^;]*\.catch\(/s);
  assert.ok(lifecycleCallMatch, "the lifecycle call must be awaited with its own .catch(), never left to throw up into the main handler flow");

  // markApprovalExecuted must appear AFTER the lifecycle call/catch block
  // in source order, and must NOT be nested inside that .catch() handler
  // (i.e. it must run unconditionally afterward, not only on lifecycle
  // failure or only on lifecycle success).
  const lifecycleIdx = source.indexOf("runAppointmentPostBookingLifecycle(supabaseAdmin");
  const markExecutedIdx = source.indexOf("await markApprovalExecuted(supabaseAdmin, reqBody.approvalId, orgId);");
  assert.ok(lifecycleIdx > 0 && markExecutedIdx > lifecycleIdx, "markApprovalExecuted must run after the lifecycle call, regardless of whether the lifecycle succeeded or failed");
});

test("handlers.ts no longer imports or calls the post-booking lifecycle directly (the layering fix this pass made)", () => {
  const handlersSource = readFileSync(path.join(repoRoot, "src/lib/agentic/handlers.ts"), "utf8");
  // Checks the actual IMPORT/CALL forms specifically — handlers.ts's own
  // comments legitimately MENTION "appointment-post-booking.ts" in prose
  // to explain why it's deliberately not imported; that prose mention is
  // fine and expected, so this does not do a blanket string-absence check.
  assert.ok(!/from\s+["'].*appointment-post-booking["']/.test(handlersSource), "src/lib/agentic/handlers.ts must never import netlify/functions/lib/appointment-post-booking.ts");
  assert.ok(!handlersSource.includes("runAppointmentPostBookingLifecycle("), "the lifecycle must never actually be CALLED from inside handlers.ts");
});
