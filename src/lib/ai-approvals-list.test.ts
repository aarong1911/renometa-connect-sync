// src/lib/ai-approvals-list.test.ts
//
// Run:  node --test src/lib/ai-approvals-list.test.ts
//
// AI-3K. Covers the approval-card inbound-message linkage fix:
//   - a new SMS approval's metadata (messageRowId) resolves and displays
//     the actual inbound body, via a direct, org-scoped lookup
//   - an older approval row with NO linkage at all gets null (renders the
//     existing fallback text in ai-approvals-tab.tsx)
//   - WhatsApp's own pre-existing meta->>execution_id linkage still works
//     unchanged (backward compatibility — that channel's background
//     dispatcher was never changed by this pass)
//   - cross-org lookup cannot resolve (an approval's messageRowId pointing
//     at a DIFFERENT org's sms_meta_messages row never resolves)
//
// No live Supabase, no network. The real module default-imports
// `supabase` from "@/lib/supabase" (which reads import.meta.env at module
// load time) — stubbed via esbuild `define` below since every test here
// always passes its OWN explicit fake client and never touches that
// default.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "ai-approvals-list-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "ai-approvals-list.ts")],
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

function baseApproval(over: Record<string, unknown> = {}) {
  return {
    id: `appr-${Math.random().toString(36).slice(2)}`,
    execution_id: `exec-${Math.random().toString(36).slice(2)}`,
    action_key: "send_sms",
    target_entity_type: "lead",
    target_entity_id: "lead-1",
    proposed_input: { contactId: "contact-1", body: "AI drafted reply" },
    summary: "AI proposed an SMS reply",
    risk_level: "medium",
    status: "pending",
    requested_at: "2026-01-01T00:00:00Z",
    reviewed_at: null,
    expires_at: null,
    rejection_reason: null,
    metadata: null,
    org_id: ORG_A,
    ...over,
  };
}

test("new SMS approval metadata (messageRowId) resolves and displays the actual inbound body, org-scoped", async () => {
  const msgId = "msg-1";
  const approval = baseApproval({ metadata: { agentKey: "lead_qualification", source: "inbound_lead_message", leadId: "lead-1", channel: "sms", messageRowId: msgId } });
  const db = createFakeSupabaseClient({
    agent_approval_requests: [approval],
    sms_meta_messages: [{ id: msgId, org_id: ORG_A, body: "Hi, I'm interested in remodeling my kitchen.", from_address: "+17547048148", direction: "in", channel: "sms", created_at: "2026-01-01T00:00:00Z" }],
  });
  const result = await S.fetchAiApprovalsList(ORG_A, "pending", db);
  const inbound = result.inboundByApproval.get(approval.id);
  assert.ok(inbound, "expected a resolved inbound message");
  assert.equal(inbound.body, "Hi, I'm interested in remodeling my kitchen.");
});

test("an older approval row with no linkage at all resolves to null (fallback text renders in the UI)", async () => {
  const approval = baseApproval({ metadata: null, execution_id: "exec-with-no-matching-row" });
  const db = createFakeSupabaseClient({
    agent_approval_requests: [approval],
    sms_meta_messages: [],
  });
  const result = await S.fetchAiApprovalsList(ORG_A, "pending", db);
  assert.equal(result.inboundByApproval.get(approval.id), null);
});

test("WhatsApp's pre-existing meta->>execution_id linkage still resolves unchanged (backward compatibility)", async () => {
  const approval = baseApproval({ action_key: "send_whatsapp", metadata: null, execution_id: "exec-wa-1" });
  const db = createFakeSupabaseClient({
    agent_approval_requests: [approval],
    sms_meta_messages: [{ id: "msg-wa-1", org_id: ORG_A, body: "WhatsApp inbound text", from_address: "+17547048148", direction: "in", channel: "whatsapp", created_at: "2026-01-01T00:00:00Z", meta: { execution_id: "exec-wa-1" } }],
  });
  const result = await S.fetchAiApprovalsList(ORG_A, "pending", db);
  const inbound = result.inboundByApproval.get(approval.id);
  assert.ok(inbound, "expected WhatsApp's existing linkage mechanism to still resolve");
  assert.equal(inbound.body, "WhatsApp inbound text");
});

test("cross-org lookup cannot resolve: a messageRowId pointing at a different org's row never resolves", async () => {
  const msgId = "msg-other-org";
  const approval = baseApproval({ metadata: { messageRowId: msgId } });
  const db = createFakeSupabaseClient({
    agent_approval_requests: [approval],
    sms_meta_messages: [{ id: msgId, org_id: ORG_B, body: "A different org's message", from_address: "+19995551234", direction: "in", channel: "sms", created_at: "2026-01-01T00:00:00Z" }],
  });
  const result = await S.fetchAiApprovalsList(ORG_A, "pending", db);
  assert.equal(result.inboundByApproval.get(approval.id), null, "must never resolve another org's message, even with the exact row id");
});

test("new linkage (messageRowId) takes priority over the old execution_id-based fallback when both could apply", async () => {
  const msgId = "msg-priority";
  const approval = baseApproval({ metadata: { messageRowId: msgId }, execution_id: "exec-shared" });
  const db = createFakeSupabaseClient({
    agent_approval_requests: [approval],
    sms_meta_messages: [
      { id: msgId, org_id: ORG_A, body: "The correct, directly-linked message", from_address: "+1", direction: "in", channel: "sms", created_at: "2026-01-01T00:00:00Z" },
      { id: "msg-decoy", org_id: ORG_A, body: "A decoy that happens to share the execution_id", from_address: "+1", direction: "in", channel: "sms", created_at: "2026-01-02T00:00:00Z", meta: { execution_id: "exec-shared" } },
    ],
  });
  const result = await S.fetchAiApprovalsList(ORG_A, "pending", db);
  assert.equal(result.inboundByApproval.get(approval.id)?.body, "The correct, directly-linked message");
});

test("readMessageRowId reads messageRowId from metadata, safely handling non-object/missing shapes", () => {
  assert.equal(S.readMessageRowId({ messageRowId: "abc" }), "abc");
  assert.equal(S.readMessageRowId({}), undefined);
  assert.equal(S.readMessageRowId(null), undefined);
  assert.equal(S.readMessageRowId("not an object"), undefined);
  assert.equal(S.readMessageRowId({ messageRowId: 123 }), undefined);
});
