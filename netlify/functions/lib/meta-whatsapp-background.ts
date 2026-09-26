// netlify/functions/lib/meta-whatsapp-background.ts
//
// AI-2E TESTABILITY REFACTOR. Pure extraction, zero behavior change: the
// entire body of ai-whatsapp-orchestrate-background.ts's handler (after
// secret verification and payload parsing, both of which stay in the
// Netlify handler — see that file) moved here, with the previously
// module-level `supabaseAdmin` and the hardcoded `orchestrateAI` call both
// turned into explicit, dependency-injected parameters.
//
// WHY: same reasoning as lib/meta-whatsapp-inbound.ts's header — this logic
// could not be exercised against scripts/fake-supabase-client.mjs (or with
// a mocked orchestrator, so no real Anthropic call ever happens in a test)
// without this extraction. No routing, no policy, no approval, no
// persistence-schema change — this file calls the SAME unmodified
// orchestrateAI() and the SAME executeStep() every other AI Center action
// goes through, exactly as ai-whatsapp-orchestrate-background.ts did
// inline before this pass.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIChannelEvent, AITrustedContext } from "./ai/types";
import { orchestrateAI } from "./ai/orchestrator";
import { executeStep, type ExecuteStepResult } from "../../../src/lib/agentic/action-executor";
import {
  resolveWhatsAppDebounceMs,
  getNewestInbound,
  isNewestInboundForConversation,
  remainingQuietMs,
  collectInboundBurstText,
  buildApprovalTriggerMetadata,
  reconcilePendingWhatsAppApprovals,
} from "./meta-whatsapp-coalesce";
import { claimForAiDispatch, linkClaimExecution, completeClaim, releaseClaim } from "./meta-whatsapp-claim";

export type WhatsAppBackgroundPayload = {
  orgId: string;
  contactId: string;
  phone: string;
  body: string;
  providerMessageId: string;
  inboundMessageId: string;
};

export function isValidWhatsAppBackgroundPayload(value: unknown): value is WhatsAppBackgroundPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orgId === "string" &&
    typeof v.contactId === "string" &&
    typeof v.phone === "string" &&
    typeof v.body === "string" &&
    typeof v.providerMessageId === "string" &&
    typeof v.inboundMessageId === "string"
  );
}

/** Re-verifies that the contactId our own webhook resolved still belongs
 * to the claimed org — defense in depth, same reasoning as the SMS
 * dispatcher's belongsToOrg(). */
async function contactBelongsToOrg(supabase: SupabaseClient, contactId: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabase.from("contacts").select("id").eq("id", contactId).eq("org_id", orgId).maybeSingle();
  if (error) return false;
  return !!data;
}

export type ProcessWhatsAppBackgroundDeps = {
  /** Server-side Supabase client. Production: the real service-role admin
   * client. Tests: scripts/fake-supabase-client.mjs. */
  supabase: SupabaseClient;
  /** Defaults to the real orchestrateAI() (a real Anthropic call) —
   * ALWAYS override this in a test with a synchronous fake that returns a
   * canned AIOrchestrationResult, never let the default run under
   * test-network-guard.mjs (an un-mocked Anthropic call is a hard test
   * failure by design — see scripts/TEST_SAFETY_RULES.md rule 4). */
  orchestrate?: typeof orchestrateAI;
  /** Quiet window before replying, so a burst of messages becomes ONE AI run
   * (see lib/meta-whatsapp-coalesce.ts). Defaults to AI_WHATSAPP_DEBOUNCE_MS
   * / 4000ms; tests pass 0. */
  debounceMs?: number;
  /** Test seam for the debounce wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the clock used to measure the quiet window. */
  now?: () => number;
};

export type ProcessWhatsAppBackgroundResult = {
  /** The HTTP status the Netlify background-function handler should
   * return — the handler is the only thing that cares about this. */
  statusCode: number;
  /** Everything below is for tests/observability — the handler ignores it. */
  claimed: boolean;
  executionId?: string;
  proposeResult?: ExecuteStepResult;
  /** True when this invocation deferred to a newer inbound message in the same burst. */
  coalesced?: boolean;
  /** True when this worker's claim lease was taken over mid-run and it stood down. */
  leaseLost?: boolean;
};

/**
 * Processes one already-secret-verified, already-shape-validated WhatsApp
 * background-dispatch payload: atomically claims the inbound message for
 * AI dispatch (duplicate-invocation guard), re-verifies the contact
 * belongs to the org, runs orchestration, links the resulting
 * execution_id back onto the inbound row, and — if the model produced a
 * reply — proposes ONE `send_whatsapp` action through the same
 * executeStep() every other AI Center action uses (always
 * approval-gated in this phase; see this module's header).
 *
 * Extracted verbatim from ai-whatsapp-orchestrate-background.ts's handler
 * body — see that file for the ALWAYS-APPROVAL-REQUIRED / trust-boundary
 * background. No behavior change from that version.
 */
export async function processWhatsAppBackground(
  payload: WhatsAppBackgroundPayload,
  deps: ProcessWhatsAppBackgroundDeps,
): Promise<ProcessWhatsAppBackgroundResult> {
  const { supabase } = deps;
  const orchestrate = deps.orchestrate ?? orchestrateAI;

  const { orgId, phone, body, providerMessageId, inboundMessageId } = payload;
  let { contactId } = payload;

  const debounceMs = deps.debounceMs ?? resolveWhatsAppDebounceMs();
  const nowMs = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (contactId && !(await contactBelongsToOrg(supabase, contactId, orgId))) {
    console.error("[meta-whatsapp-background] contactId does not belong to orgId — dropping.");
    contactId = "";
  }
  if (!contactId) {
    console.warn("[meta-whatsapp-background] no verified contactId — skipping AI dispatch entirely.");
    return { statusCode: 200, claimed: false };
  }

  // Durable burst coalescing (see lib/meta-whatsapp-coalesce.ts): the message
  // is already persisted by the webhook, so only the AI reply waits, and what
  // decides who runs is the database — the newest inbound message is the
  // conversation watermark — never this invocation's sleep.
  //
  // 1) A newer inbound message makes every older pending approval stale at
  //    once: cancel them now, so nothing stale is approvable during the wait
  //    (or after a failed newest run).
  await reconcilePendingWhatsAppApprovals(supabase, orgId, contactId);

  // 2) Gate: only the invocation of the watermark message proceeds.
  const watermark = await getNewestInbound(supabase, orgId, contactId);
  if (watermark && watermark.id !== inboundMessageId) {
    console.log("[meta-whatsapp-background] newer inbound message exists for this conversation — deferring to its run:", inboundMessageId);
    return { statusCode: 200, claimed: false, coalesced: true };
  }

  // 3) Quiet window measured from the message's own created_at. The sleep is
  //    only an optimization to wait it out in this invocation; if it is cut
  //    short or the instance dies, nothing has been claimed, and a retry
  //    re-derives the same decision from the database.
  if (debounceMs > 0 && watermark) {
    const wait = remainingQuietMs(watermark.createdAt, debounceMs, nowMs());
    if (wait > 0) await sleep(wait);
  }
  if (!(await isNewestInboundForConversation(supabase, orgId, contactId, inboundMessageId))) {
    console.log("[meta-whatsapp-background] newer inbound message arrived during the quiet window — deferring:", inboundMessageId);
    return { statusCode: 200, claimed: false, coalesced: true };
  }

  // 4) Claim AFTER the gate, atomically (duplicate deliveries run once).
  //    The claim is a LEASE (lib/meta-whatsapp-claim.ts): an abandoned claim
  //    (worker hard-killed after claiming) becomes reclaimable once it expires.
  const claim = await claimForAiDispatch(supabase, orgId, inboundMessageId, nowMs());
  if (!claim) {
    console.log("[meta-whatsapp-background] inbound message", inboundMessageId, "already claimed for AI dispatch — skipping duplicate invocation.");
    return { statusCode: 200, claimed: false };
  }

  try {
    const burstText = await collectInboundBurstText(supabase, orgId, contactId, body);

    const aiEvent: AIChannelEvent = {
      eventId: `whatsapp_${providerMessageId}`,
      channel: "whatsapp",
      eventType: "message_received",
      externalMessageId: providerMessageId,
      identity: { phone },
      content: { type: "text", text: burstText },
      occurredAt: new Date().toISOString(),
    };

    // Same rationale as the SMS dispatcher: level 2 (not 4) — preserves
    // Lead Qualification's existing tool access without granting this
    // execution any special send authority. send_whatsapp's own
    // minimumAutonomyLevel is 4; the proposal below reaches the approval
    // branch via `trustedProposal`, not via this level.
    const EXECUTION_AUTONOMY_LEVEL = 2;

    const trustedContext: AITrustedContext = {
      orgId,
      actor: { actorType: "workflow", actorId: "whatsapp_inbound", source: "whatsapp_inbound" },
      contactId,
      conversationKey: `${contactId}::whatsapp`,
      autonomyLevel: EXECUTION_AUTONOMY_LEVEL,
    };

    const result = await orchestrate({ supabase, event: aiEvent, trustedContext });

    // AI-2B-equivalent linkage onto our own claim (token-guarded, lease kept).
    // If the claim was taken over (our lease expired and another worker
    // reclaimed the message), stand down instead of proposing a duplicate.
    const stillOwner = await linkClaimExecution(supabase, orgId, inboundMessageId, claim, result.executionId, nowMs());
    if (!stillOwner) {
      console.warn("[meta-whatsapp-background] claim lease was taken over by another worker — standing down:", inboundMessageId);
      return { statusCode: 200, claimed: true, executionId: result.executionId, leaseLost: true };
    }

    if (result.status === "failed" || !result.responseText) {
      console.error("[meta-whatsapp-background] AI run did not produce a response.", {
        executionId: result.executionId,
        status: result.status,
        error: result.error,
      });
      // The newest run failed: any older pending proposal is still stale
      // (the customer has written since) and must not stay approvable.
      await reconcilePendingWhatsAppApprovals(supabase, orgId, contactId);
      await completeClaim(supabase, orgId, inboundMessageId, claim, result.executionId, nowMs());
      return { statusCode: 200, claimed: true, executionId: result.executionId };
    }

    // ONE reply max, per AI-2E's explicit scope — always proposed for
    // approval (see this module's header "ALWAYS APPROVAL-REQUIRED"). The
    // WhatsApp 24-hour reactive-window eligibility check happens inside
    // executeStep() -> checkOutboundConsent() (action-executor.ts) — if the
    // window has closed since the inbound message arrived, this call fails
    // closed with no approval row created, rather than creating an approval
    // a human could approve into a rejected/undeliverable send.
    const truncatedBody = result.responseText.slice(0, 1600);
    const proposeResult = await executeStep({
      supabase,
      orgId,
      actor: { actorType: "workflow", actorId: "whatsapp_inbound", source: "whatsapp_inbound" },
      executionId: result.executionId,
      sequence: 1,
      actionKey: "send_whatsapp",
      rawInput: { contactId, body: truncatedBody },
      autonomyLevel: EXECUTION_AUTONOMY_LEVEL,
      trustedProposal: true,
      idempotencyKey: `whatsapp_reply:${result.executionId}`,
      targetEntityType: "contact",
      targetEntityId: contactId,
      approvalSummary: "AI Center proposed a WhatsApp reply to an inbound message.",
      approvalMetadata: await buildApprovalTriggerMetadata(supabase, orgId, contactId, inboundMessageId),
    });

    // One-pending-reply invariant: after a proposal exists, keep only the one
    // triggered by the newest inbound message for this conversation and cancel
    // the rest (history preserved as status 'cancelled').
    // Runs whatever the proposal outcome: even if this proposal failed, older
    // pending ones are stale relative to the newest message.
    await reconcilePendingWhatsAppApprovals(supabase, orgId, contactId);

    console.log("[meta-whatsapp-background] send_whatsapp result:", {
      executionId: result.executionId,
      status: proposeResult.status,
      approvalRequestId: proposeResult.approvalRequestId,
    });

    // AI-2E — Run Inspector observability, same read-merge pattern AI-2D
    // established for SMS (output_summary.smsReplyStatus) — a parallel,
    // NOT shared, field name so SMS's own fields are never touched.
    const { data: execRowForSummary } = await supabase
      .from("agent_executions")
      .select("output_summary")
      .eq("id", result.executionId)
      .maybeSingle();
    const currentOutputSummary =
      execRowForSummary?.output_summary && typeof execRowForSummary.output_summary === "object" && !Array.isArray(execRowForSummary.output_summary)
        ? (execRowForSummary.output_summary as Record<string, unknown>)
        : {};
    await supabase
      .from("agent_executions")
      .update({
        output_summary: {
          ...currentOutputSummary,
          whatsappReplyStatus: proposeResult.status,
        },
      })
      .eq("id", result.executionId);

    // Terminal: this message will never be re-run (even after the lease time).
    await completeClaim(supabase, orgId, inboundMessageId, claim, result.executionId, nowMs());
    return { statusCode: 200, claimed: true, executionId: result.executionId, proposeResult };
  } catch (err) {
    // Release the claim so a platform retry can run this message again; a
    // duplicate proposal (if the failure came late) is collapsed by reconcile.
    await releaseClaim(supabase, orgId, inboundMessageId, claim);
    throw err;
  }
}
