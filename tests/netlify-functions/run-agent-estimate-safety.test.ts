// tests/netlify-functions/run-agent-estimate-safety.test.ts
//
// Run:  node --test tests/netlify-functions/run-agent-estimate-safety.test.ts
//
// Estimate Assistant safety hardening. The legacy AI Center agent runner
// (netlify/functions/run-agent.ts, reachable from the AI Center "Run" button
// via src/lib/ai-center-store.ts's runAgentManually) used to INSERT an
// estimate + line items straight from model JSON, including model-chosen
// unit_price, with no approval. That writer is removed; the agent may still
// READ estimates. Its executeActions() is not exported, so — following this
// repo's source-level-test precedent (see agent-approve-action.test.ts's
// "source wiring" tests) — this pins the invariant on the source itself:
// no estimate/estimate_items write of any kind can exist in this file.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, "..", "..", "netlify/functions/run-agent.ts"), "utf8");

/** Every write method (insert/update/upsert/delete) chained onto
 * `.from("<table>")`. Each `.from(...)` call is inspected on its own — from
 * just after the call up to the next `.from(` or the end of the statement
 * (`;`) — so one chain can never swallow another. */
function chainedWriteMethods(src: string, table: string): string[] {
  const out: string[] = [];
  const fromCall = new RegExp("\\.from\\(\\s*[\"'`]" + table + "[\"'`]\\s*\\)", "g");
  for (const m of src.matchAll(fromCall)) {
    const rest = src.slice((m.index ?? 0) + m[0].length);
    const stop = rest.search(/;|\.from\(/);
    const chain = stop === -1 ? rest : rest.slice(0, stop);
    for (const w of chain.matchAll(/\.(insert|update|upsert|delete)\s*\(/g)) out.push(w[1]);
  }
  return out;
}

test("the scanner itself works: it DOES detect the removed legacy writer shape and ignores plain reads", () => {
  const legacy = [
    "const { data: est } = await supabase",
    "  .from(\"estimates\")",
    "  .insert({ org_id: orgId, total_amount: parsed.subtotal ?? 0 })",
    "  .select().single();",
    "await supabase.from(\"estimate_items\").insert(items);",
    "const { data } = await supabase.from(\"estimates\").select(\"id\").eq(\"org_id\", orgId);",
  ].join("\n");
  assert.deepEqual(chainedWriteMethods(legacy, "estimates"), ["insert"]);
  assert.deepEqual(chainedWriteMethods(legacy, "estimate_items"), ["insert"]);
  assert.deepEqual(chainedWriteMethods("await supabase.from(\"estimates\").select(\"id\");", "estimates"), []);
});

test("run-agent.ts performs NO write (insert/update/upsert/delete) on estimates or estimate_items", () => {
  assert.deepEqual(chainedWriteMethods(source, "estimates"), []);
  assert.deepEqual(chainedWriteMethods(source, "estimate_items"), []);
});

test("the estimate READ paths (Estimate Drafter / Reviewer context) are still present — the agent can still read and summarize", () => {
  assert.match(source, /\.from\("estimates"\)\s*\.select\(/);
});

test("a create_estimate action is recorded honestly as NOT created — run history never implies an estimate exists, and no model-chosen price is persisted", () => {
  assert.match(source, /estimate_not_created/);
  assert.doesNotMatch(source, /estimate_created/);
  assert.doesNotMatch(source, /unit_price:\s*li\.unit_price/);
});

test("the legacy runner still resolves the org from the verified bearer token (unchanged auth)", () => {
  assert.match(source, /resolveOrgFromBearerToken\(/);
});
