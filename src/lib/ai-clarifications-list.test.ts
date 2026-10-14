// src/lib/ai-clarifications-list.test.ts
//
// Run:  node --test src/lib/ai-clarifications-list.test.ts
//
// Business Knowledge phase — the Knowledge Clarification list read used by
// the Approvals tab: filter -> status mapping, org scoping, inbound-message
// linkage (never across orgs), and the open-count used by the tab badge.
// No live Supabase, no network (stubbed `@/lib/supabase` env via esbuild
// `define`, exactly like ai-approvals-list.test.ts).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "ai-clarifications-list-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "ai-clarifications-list.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(repoRoot, "src") },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("http://localhost:54321"),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify("test-anon-key"),
  },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function row(over: Record<string, unknown>) {
  return {
    id: `c-${Math.random().toString(36).slice(2)}`, org_id: ORG_A, execution_id: "e1", contact_id: "contact-1", channel: "sms",
    question: "Do you handle permits?", knowledge_key: "permit_handling", category: "permit_handling", suggested_options: [],
    status: "pending", answer: null, save_to_knowledge: false, knowledge_saved_at: null, knowledge_save_error: null, send_error: null,
    inbound_message_id: null, created_at: "2026-10-01T00:00:00Z", resolved_at: null, ...over,
  };
}

function makeClient() {
  return createFakeSupabaseClient({
    ai_clarification_requests: [
      row({ id: "p1", status: "pending", inbound_message_id: "m1" }),
      row({ id: "f1", status: "send_failed", contact_id: "contact-2" }),
      row({ id: "s1", status: "sending", contact_id: "contact-3" }),
      row({ id: "r1", status: "resolved" }),
      row({ id: "d1", status: "dismissed" }),
      row({ id: "other-org", org_id: ORG_B, status: "pending", inbound_message_id: "m-other" }),
    ],
    contacts: [
      { id: "contact-1", org_id: ORG_A, full_name: "John Test", phone: "+15550001111" },
      { id: "contact-2", org_id: ORG_A, full_name: "Maria", phone: null },
    ],
    sms_meta_messages: [
      { id: "m1", org_id: ORG_A, body: "Do you handle permits?", from_address: "+15550001111", created_at: "2026-10-01T00:00:00Z" },
      { id: "m-other", org_id: ORG_B, body: "SECRET of org B", from_address: "x", created_at: "2026-10-01T00:00:00Z" },
    ],
  });
}

const ids = (r: any) => r.clarifications.map((c: any) => c.id).sort();

test("filters map to clarification statuses: Pending = pending+sending+send_failed, Completed = resolved, Rejected = dismissed, All = everything — always org-scoped", async () => {
  const db = makeClient();
  assert.deepEqual(ids(await S.fetchAiClarificationsList(ORG_A, "pending", db)), ["f1", "p1", "s1"]);
  assert.deepEqual(ids(await S.fetchAiClarificationsList(ORG_A, "completed", db)), ["r1"]);
  assert.deepEqual(ids(await S.fetchAiClarificationsList(ORG_A, "rejected", db)), ["d1"]);
  assert.deepEqual(ids(await S.fetchAiClarificationsList(ORG_A, "all", db)), ["d1", "f1", "p1", "r1", "s1"]);
  assert.deepEqual(ids(await S.fetchAiClarificationsList(ORG_B, "all", db)), ["other-org"]);
});

test("openCount is the actionable/in-flight count regardless of the active filter", async () => {
  const db = makeClient();
  assert.equal((await S.fetchAiClarificationsList(ORG_A, "pending", db)).openCount, 3);
  assert.equal((await S.fetchAiClarificationsList(ORG_A, "completed", db)).openCount, 3);
  assert.equal(await S.fetchOpenClarificationCount(ORG_B, db), 1);
});

test("contact and inbound-message enrichment is org-scoped: a different org's message id never resolves", async () => {
  const db = makeClient();
  const a = await S.fetchAiClarificationsList(ORG_A, "pending", db);
  assert.equal(a.contactById.get("contact-1").name, "John Test");
  assert.equal(a.contactById.get("contact-2").phone, null);
  assert.equal(a.inboundById.get("m1").body, "Do you handle permits?");
  assert.equal(a.inboundById.has("m-other"), false);

  const b = await S.fetchAiClarificationsList(ORG_B, "pending", db);
  assert.equal(b.inboundById.has("m1"), false);
  assert.equal(b.inboundById.get("m-other").body, "SECRET of org B", "only ever its own org's message");
});
