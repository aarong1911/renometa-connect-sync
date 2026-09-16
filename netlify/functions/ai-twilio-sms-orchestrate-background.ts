/// <reference types="node" />
// netlify/functions/ai-twilio-sms-orchestrate-background.ts
//
// AI-2A. The actual AI reasoning + reply-proposal step for an inbound
// Twilio SMS — dispatched (fire-and-forget) by ai-twilio-sms-inbound.ts
// once the inbound message is safely persisted AND confirmed to be
// neither a compliance keyword nor from an unmatched sender (see that
// file's header). A Netlify BACKGROUND function (filename suffix
// "-background" — Netlify's own platform convention: returns 202
// immediately, keeps running up to 15 minutes).
//
// This file is a CHANNEL ADAPTER: it calls the existing, unmodified
// orchestrateAI() (lib/ai/orchestrator.ts) directly — no HTTP round trip
// through ai-orchestrate.ts (that endpoint is for authenticated
// browser/Test-Console callers; this is a trusted server-to-server call
// with its own, different trust boundary, established below) — and then,
// if the model produced a reply, proposes sending that reply as one
// `send_sms` action through the SAME centralized Gen-2 pipeline
// (action-executor.ts's executeStep()) every other AI Center tool call
// already goes through. It does NOT call Twilio directly, and does NOT
// bypass emergency pause / opt-out / approval.
//
// ── TRUST BOUNDARY FOR THIS ENDPOINT ─────────────────────────────────────
//
// Netlify background functions are still reachable at a public URL (they
// are not automatically private). This endpoint is NOT meant to be called
// by anything other than ai-twilio-sms-inbound.ts, so it requires a
// shared-secret header (X-Internal-Secret, matched against the
// AI_SMS_INTERNAL_DISPATCH_SECRET env var, compared timing-safely — see
// AI-2A correction pass below) rather than accepting a public POST at
// face value. This is a SEPARATE concern from the orgId/contactId/leadId
// in the body themselves: those are additionally independently
// re-verified below (verifyEntityBelongsToOrg-equivalent checks) even
// though they originate from our own webhook, so a compromised or buggy
// caller can never widen scope beyond what the target org actually owns.
//
// ── AI-2A CORRECTION PASS: DURABLE DEDUPE FOR THIS FUNCTION ITSELF ───────
//
// ai-twilio-sms-inbound.ts's unique-index insert on sms_meta_messages
// prevents the PUBLIC webhook from dispatching this function twice for
// the same Twilio delivery — but that guard lives one hop upstream of
// THIS function. If Netlify's own infrastructure (or a network retry)
// invokes this background function a second time for the same dispatch,
// nothing previously stopped it from calling orchestrateAI() again,
// creating a second agent_executions row and a second send_sms approval
// for the same inbound message. Fixed with a small, durable, atomic claim
// on the SAME sms_meta_messages row the webhook already inserted —
// exactly the "piggyback a claim onto an existing jsonb column" pattern
// appointment-reminder-sms.ts already uses (its own
// sms_reminder_claimed_at/sent_at fields on `appointments.metadata`)
// rather than a new generalized queue/event-bus table. Keyed to the
// row's own id, which is itself uniquely tied to (org_id,
// provider_message_id) by the AI-2A dedupe migration — so this is
// effectively "claim by org_id + inbound MessageSid" without needing to
// re-derive that pair.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { orchestrateAI } from "./lib/ai/orchestrator";
import type { AIChannelEvent, AITrustedContext } from "./lib/ai/types";
import { executeStep } from "../../src/lib/agentic/action-executor";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** AI-2A correction pass: timing-safe comparison for the internal
 * dispatch secret — same reasoning as twilio-signature.ts's signature
 * comparison. Equal-length requirement first (timingSafeEqual throws on
 * length mismatch); a length mismatch is itself just "not equal." */
function secretsMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

type DispatchPayload = {
  orgId: string;
  contactId: string | null;
  leadId: string | null;
  phone: string;
  body: string;
  messageSid: string;
  inboundMessageId: string;
};

function isValidPayload(value: unknown): value is DispatchPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orgId === "string" &&
    (v.contactId === null || typeof v.contactId === "string") &&
    (v.leadId === null || typeof v.leadId === "string") &&
    typeof v.phone === "string" &&
    typeof v.body === "string" &&
    typeof v.messageSid === "string" &&
    typeof v.inboundMessageId === "string"
  );
}

/** Re-verifies that an id our own webhook resolved still belongs to the
 * claimed org — defense in depth against a compromised/buggy caller of
 * this internal endpoint, same reasoning as ai-orchestrate.ts's own
 * verifyEntityBelongsToOrg(). Not exported from that file (private helper
 * there), so re-implemented here as the small, local equivalent rather
 * than refactoring an unrelated file for one shared 4-line function. */
async function belongsToOrg(table: "contacts" | "leads", id: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from(table).select("id").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error) return false;
  return !!data;
}

/**
 * Atomically claims the inbound sms_meta_messages row for AI dispatch —
 * the durable, background-function-side idempotency guard described in
 * this file's header. Uses a conditional UPDATE (`.is("meta", null)`) so
 * concurrent/retried invocations for the same row can only ever have ONE
 * winner: Postgres serializes the UPDATE at the row level, and only the
 * request that actually flips `meta` from null to non-null gets rows
 * back. Returns true only for that one winner.
 */
async function claimForAiDispatch(orgId: string, inboundMessageId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("sms_meta_messages")
    .update({ meta: { ai_dispatch_claimed_at: new Date().toISOString() } })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .is("meta", null)
    .select("id");
  if (error) {
    console.error("[ai-twilio-sms-orchestrate-background] claimForAiDispatch failed:", error);
    return false;
  }
  return (data ?? []).length > 0;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const expectedSecret = process.env.AI_SMS_INTERNAL_DISPATCH_SECRET;
  const providedSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (!expectedSecret || !providedSecret || !secretsMatch(expectedSecret, providedSecret)) {
    console.error("[ai-twilio-sms-orchestrate-background] rejected request with missing/invalid internal secret.");
    return { statusCode: 403, body: "" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: "" };
  }
  if (!isValidPayload(payload)) {
    console.error("[ai-twilio-sms-orchestrate-background] malformed payload.");
    return { statusCode: 400, body: "" };
  }

  const { orgId, phone, body, messageSid, inboundMessageId } = payload;
  let { contactId, leadId } = payload;

  // ── Durable dedupe claim — see this file's header. Must happen before
  // any AI work; a lost claim (already claimed by a prior/concurrent
  // invocation) means this invocation does nothing further. ─────────────
  const claimed = await claimForAiDispatch(orgId, inboundMessageId);
  if (!claimed) {
    console.log("[ai-twilio-sms-orchestrate-background] inbound message", inboundMessageId, "already claimed for AI dispatch — skipping duplicate invocation.");
    return { statusCode: 200, body: "" };
  }

  // Independent re-verification — see this file's header. A mismatch
  // silently drops the id rather than failing the whole run; the AI can
  // still read/respond with less context, it just won't get a trust-bound
  // recipient to reply to (which also means no send_sms proposal below).
  if (contactId && !(await belongsToOrg("contacts", contactId, orgId))) {
    console.error("[ai-twilio-sms-orchestrate-background] contactId does not belong to orgId — dropping.");
    contactId = null;
  }
  if (leadId && !(await belongsToOrg("leads", leadId, orgId))) {
    console.error("[ai-twilio-sms-orchestrate-background] leadId does not belong to orgId — dropping.");
    leadId = null;
  }

  // Defensive only — ai-twilio-sms-inbound.ts never dispatches this
  // function at all when no contact was resolved (see its own header
  // "UNMATCHED CONTACT"), so this should be unreachable in practice. Kept
  // as a second guard against a caller bug rather than trusting the
  // upstream check alone.
  if (!contactId) {
    console.warn("[ai-twilio-sms-orchestrate-background] no contactId in payload — skipping AI dispatch entirely (should be unreachable; see ai-twilio-sms-inbound.ts).");
    return { statusCode: 200, body: "" };
  }

  const aiEvent: AIChannelEvent = {
    eventId: `twilio_sms_${messageSid}`,
    channel: "sms",
    eventType: "message_received",
    externalMessageId: messageSid,
    identity: { phone },
    content: { type: "text", text: body },
    occurredAt: new Date().toISOString(),
  };

  // AI-2A CORRECTION PASS: autonomyLevel is now 2, NOT a blanket 4.
  //
  // Level 2 is the LOWEST level that preserves Lead Qualification's
  // existing add_internal_note behavior (minimumAutonomyLevel 2,
  // requiresApproval false — the same level ai-orchestrate.ts's own
  // "Lead Qualification Test" heuristic already grants for a verified
  // leadId). It does NOT grant this execution any special send_sms
  // authority — send_sms's own minimumAutonomyLevel is 4, well above
  // this. Reception has no tool access at all, so this value is inert for
  // it either way.
  //
  // The send_sms PROPOSAL below no longer needs the execution's own
  // autonomyLevel to reach 4 — it uses executeStep()'s new
  // `trustedProposal` parameter instead (action-executor.ts, AI-2A
  // correction pass), which skips ONLY the autonomy-floor check, and ONLY
  // because send_sms.requiresApproval is unconditionally true (see that
  // file's own doc comment for the full safety reasoning). This keeps
  // "the AI execution may autonomously act" cleanly separate from
  // "trusted server code may propose one specific action for human
  // approval" — a future tool with a lower minimumAutonomyLevel can never
  // accidentally inherit elevated auto-execution authority from this
  // context.
  const EXECUTION_AUTONOMY_LEVEL = 2;

  const trustedContext: AITrustedContext = {
    orgId,
    actor: { actorType: "workflow", actorId: "twilio_sms_inbound", source: "twilio_inbound_sms" },
    contactId,
    leadId: leadId ?? undefined,
    conversationKey: `${contactId}::sms`,
    autonomyLevel: EXECUTION_AUTONOMY_LEVEL,
  };

  const result = await orchestrateAI({ supabase: supabaseAdmin, event: aiEvent, trustedContext });

  // AI-2B addition: durable linkage from this inbound message to the
  // execution it produced. Discovered while building the Approvals UI —
  // nothing previously recorded which agent_executions row a given
  // sms_meta_messages row led to, so there was no reliable way for the
  // UI to show "the inbound message this approval is replying to"
  // without an unreliable heuristic (e.g. matching by contact + nearest
  // timestamp, which breaks if a second message arrives while the first
  // approval is still pending). Fixed with the smallest possible
  // addition — no migration needed, `meta` is already a flexible jsonb
  // column on sms_meta_messages (AI-2A's own dedupe-claim already writes
  // to it) — merging `execution_id` into the SAME row's `meta` alongside
  // the existing `ai_dispatch_claimed_at` marker. The Approvals UI then
  // looks up `sms_meta_messages` where `meta->>'execution_id'` equals the
  // approval's own `execution_id` — an exact, non-heuristic match. Does
  // not touch orchestrator.ts/action-executor.ts — this file already owns
  // sms_meta_messages writes (see claimForAiDispatch() above).
  {
    const { error: linkErr } = await supabaseAdmin
      .from("sms_meta_messages")
      .update({ meta: { ai_dispatch_claimed_at: new Date().toISOString(), execution_id: result.executionId } })
      .eq("id", inboundMessageId)
      .eq("org_id", orgId);
    if (linkErr) console.error("[ai-twilio-sms-orchestrate-background] could not link execution_id onto inbound message:", linkErr);
  }

  if (result.status === "failed" || !result.responseText) {
    console.error("[ai-twilio-sms-orchestrate-background] AI run did not produce a response.", {
      executionId: result.executionId,
      status: result.status,
      error: result.error,
    });
    return { statusCode: 200, body: "" };
  }

  // ONE reply max, per this task's explicit scope — this is the only
  // executeStep() call this file ever makes, for the one response
  // orchestrateAI() just produced. Routed through the SAME centralized
  // Gen-2 pipeline every other AI Center action uses: input-schema
  // validation, emergency pause, outbound consent
  // (marketing_contact_preferences.sms_status === "eligible" only), and —
  // because send_sms.requiresApproval is unconditionally true — a real
  // human approval via agent-approve-action.ts (owner/admin-gated) before
  // handlers.ts's sendSms() ever calls Twilio. This call does NOT send
  // anything itself. `trustedProposal: true` is what lets this reach the
  // approval-creation branch at EXECUTION_AUTONOMY_LEVEL (2) instead of
  // send_sms's own minimumAutonomyLevel (4) — see the comment above.
  const truncatedBody = result.responseText.slice(0, 1600);
  const proposeResult = await executeStep({
    supabase: supabaseAdmin,
    orgId,
    actor: { actorType: "workflow", actorId: "twilio_sms_inbound", source: "twilio_inbound_sms" },
    executionId: result.executionId,
    sequence: 1,
    actionKey: "send_sms",
    rawInput: { contactId, body: truncatedBody },
    autonomyLevel: EXECUTION_AUTONOMY_LEVEL,
    trustedProposal: true,
    idempotencyKey: `sms_reply:${result.executionId}`,
    targetEntityType: "contact",
    targetEntityId: contactId,
    approvalSummary: "AI Center proposed an SMS reply to an inbound text message.",
  });

  console.log("[ai-twilio-sms-orchestrate-background] send_sms proposal result:", {
    executionId: result.executionId,
    status: proposeResult.status,
    approvalRequestId: proposeResult.approvalRequestId,
  });

  return { statusCode: 200, body: "" };
};
