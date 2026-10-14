// netlify/functions/lib/ai/knowledge-clarification.ts
//
// Owner Clarification workflow — the "customer asked a company-specific
// question and Trusted Business Knowledge has no answer" path.
//
//   customer question
//     -> Lead Qualification emits a `clarify` decision (a category label +
//        neutral restatement — nothing else; see agents/lead-qualification.ts)
//     -> handleClarifyDecision() [THIS FILE, trusted server code]:
//          re-checks Business Knowledge itself, validates the category,
//          coalesces duplicates, creates ONE ai_clarification_requests row,
//          returns a DETERMINISTIC holding reply (no model-written promise)
//     -> owner opens AI Center -> Approvals -> "Knowledge Clarification" card
//     -> resolveClarification() [human action]:
//          claim -> send answer via the EXISTING trusted outbound path
//          (executeApprovedStep: emergency pause + opt-out/consent recheck +
//          idempotency + the real send_sms/send_whatsapp handler, which also
//          persists the outbound message) -> optionally upsert Business
//          Knowledge -> final status.
//
// NOT a risky external action: creating a clarification is internal state,
// so it does not go through executeStep()/agent_approval_requests (those
// model PROPOSED ACTIONS — see the migration's header for why a dedicated
// table was used). Only the final customer-facing send is an outbound
// action, and it is gated by the SAME checks every other outbound send is.
//
// ── FAILURE SEMANTICS (documented because they are product decisions) ───
//
//   send fails, knowledge save not requested  -> status `send_failed`, the
//        owner's answer is kept, the card stays actionable; retry re-sends.
//   send fails, knowledge save requested      -> the save is STILL attempted
//        (the owner's answer is a durable business fact independent of
//        whether this one customer's phone was reachable) and recorded; the
//        status is still `send_failed`. A retry does not re-save.
//   send ok, knowledge save fails             -> status `resolved` (the
//        customer HAS their answer — that is the primary outcome), with
//        knowledge_save_error recorded and `knowledge: "failed"` returned so
//        the owner is told plainly. Re-submitting the same clarification
//        retries ONLY the save (never the send).
//   duplicate submit (double click, retry)    -> exactly one send: (1) an
//        atomic conditional UPDATE claims `pending|send_failed -> sending`
//        (a second concurrent call matches no row), (2) the outbound action
//        runs under the idempotency key `clarification_reply:<id>`, which
//        action-executor.ts's agent_action_idempotency makes at-most-once,
//        and (3) an already-`resolved` row returns success without sending.
//   missing contact/channel                   -> clarifications are only ever
//        CREATED with a contact and an executable channel, but this is
//        re-validated at send time; a failure is `send_failed`, never a
//        silent "resolved".

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIBusinessKnowledgeEntry, AIChannel, AIChannelEvent, AIResolvedContext, AITrustedContext } from "./types";
import { executeApprovedStep } from "../../../../src/lib/agentic/action-executor";
import {
  MAX_ANSWER_LENGTH,
  resolveKnowledgeTarget,
  suggestedOptionsForKey,
  type KnowledgeOption,
} from "../../../../src/lib/agentic/business-knowledge-catalog";
import { upsertKnowledgeEntry } from "./business-knowledge-store";

/** Channels a clarification can be CREATED for: exactly those with a real,
 * registered, executable outbound send action (action-registry.ts). A
 * promise to follow up is only made where the system can actually keep it. */
export const CLARIFICATION_CHANNELS: ReadonlySet<AIChannel> = new Set<AIChannel>(["sms", "whatsapp"]);

const SEND_ACTION_FOR_CHANNEL: Record<string, "send_sms" | "send_whatsapp"> = {
  sms: "send_sms",
  whatsapp: "send_whatsapp",
};

const OPEN_STATUSES = ["pending", "sending", "send_failed"] as const;

// Deterministic customer-facing replies. Deliberately NOT model-generated:
// the model must never be the author of a "we'll get back to you" promise.
// The first two are only ever used when a clarification row really exists
// (so the follow-up genuinely will be sent once the owner answers).
export const CLARIFICATION_HOLDING_REPLY =
  "Good question — I want to give you accurate information, so I'm confirming the details with our team and will get back to you shortly.";
export const CLARIFICATION_STILL_PENDING_REPLY =
  "Thanks for your patience — our team is still confirming that and we'll follow up as soon as we have the answer.";
export const CLARIFICATION_UNSUPPORTED_REPLY =
  "That's a good question — I'd want to confirm the specifics with our team rather than guess.";

const HOLDING_REPLY_BODIES: ReadonlySet<string> = new Set([
  CLARIFICATION_HOLDING_REPLY,
  CLARIFICATION_STILL_PENDING_REPLY,
]);

/**
 * STALE HOLDING-REPLY CLEANUP. In review mode (autonomy >= 2) the dispatcher
 * proposes the deterministic holding reply as an ordinary send_sms/
 * send_whatsapp approval (lead-qualification-dispatch.ts). That approval is
 * independent of the clarification: once the owner has ANSWERED (or
 * dismissed) the question, approving it later would send "I'm confirming
 * the details with our team…" AFTER the real answer — a false, confusing
 * message. Nothing else cancels it (SMS has no supersede mechanism; its
 * idempotency key differs from the clarification send's), so it is
 * cancelled here.
 *
 * Deliberately narrow: only PENDING approvals, same org, same contact, a
 * send action, AND a body that is byte-for-byte one of the two
 * deterministic holding texts (which a model can never author — see
 * CLARIFICATION_*_REPLY above). An unrelated pending reply to the same
 * customer is never touched. Best-effort: a failure here is logged and
 * never affects the already-completed send/dismiss.
 */
export async function cancelStaleHoldingReplies(supabase: SupabaseClient, row: { org_id: string; contact_id: string; created_at?: string }): Promise<number> {
  try {
    let query = supabase
      .from("agent_approval_requests")
      .select("id, proposed_input")
      .eq("org_id", row.org_id)
      .eq("status", "pending")
      .in("action_key", ["send_sms", "send_whatsapp"])
      .limit(100);
    if (row.created_at) query = query.gte("requested_at", row.created_at);
    const { data, error } = await query;
    if (error) {
      console.error("[knowledge-clarification] stale holding-reply lookup failed:", error.message);
      return 0;
    }
    const stale = (data ?? []).filter((a: { proposed_input?: { contactId?: unknown; body?: unknown } | null }) =>
      a.proposed_input?.contactId === row.contact_id && typeof a.proposed_input?.body === "string" && HOLDING_REPLY_BODIES.has(a.proposed_input.body));
    let cancelled = 0;
    for (const approval of stale as Array<{ id: string }>) {
      const { data: updated } = await supabase
        .from("agent_approval_requests")
        .update({
          status: "cancelled",
          reviewed_at: new Date().toISOString(),
          rejection_reason: "Superseded: the owner already answered this customer's question.",
        })
        .eq("id", approval.id)
        .eq("org_id", row.org_id)
        .eq("status", "pending") // never overwrites an approval the owner decided in the meantime
        .select("id")
        .maybeSingle();
      if (updated) cancelled += 1;
    }
    return cancelled;
  } catch (err) {
    console.error("[knowledge-clarification] stale holding-reply cleanup threw:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export type ClarifyDecisionInput = { category: string; question: string };

export type ClarifyOutcome =
  /** Trusted Business Knowledge DOES contain the answer — never create a request. */
  | { kind: "answer_from_knowledge"; entry: AIBusinessKnowledgeEntry }
  | { kind: "clarification"; clarificationId: string; created: boolean; reply: string; knowledgeKey: string; category: string }
  /** No request created; `reply` is a safe holding answer that promises nothing automatic. */
  | { kind: "unsupported"; reply: string; reason: "invalid_category" | "knowledge_unavailable" | "channel_not_supported" | "no_contact" | "db_error" };

function readMessageRowId(event: AIChannelEvent): string | null {
  const v = event.metadata?.messageRowId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function handleClarifyDecision(params: {
  supabase: SupabaseClient;
  trustedContext: AITrustedContext;
  event: AIChannelEvent;
  context: AIResolvedContext;
  decision: ClarifyDecisionInput;
  executionId: string;
}): Promise<ClarifyOutcome> {
  const { supabase, trustedContext, event, context, decision, executionId } = params;

  const target = resolveKnowledgeTarget(decision.category, decision.question);
  if (!target) return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "invalid_category" };

  // The model may have flagged a gap that doesn't exist — Business Knowledge
  // is re-checked here, by server code, against the context it was just
  // built from. "Unavailable" means we cannot know, so we must not ask the
  // owner something they may already have answered.
  const knowledge = context.businessKnowledge;
  if (!knowledge || knowledge.status === "unavailable") {
    return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "knowledge_unavailable" };
  }
  const existing = knowledge.entries.find((e) => e.key === target.key);
  if (existing) return { kind: "answer_from_knowledge", entry: existing };

  if (!CLARIFICATION_CHANNELS.has(event.channel)) {
    return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "channel_not_supported" };
  }
  const contactId = trustedContext.contactId;
  if (!contactId) return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "no_contact" };

  const orgId = trustedContext.orgId;

  const findOpen = async () => {
    const { data, error } = await supabase
      .from("ai_clarification_requests")
      .select("id")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .eq("knowledge_key", target.key)
      .in("status", [...OPEN_STATUSES])
      .limit(1)
      .maybeSingle();
    return { row: data as { id: string } | null, error };
  };

  // Coalesce: one unresolved clarification per (org, contact, key).
  const open = await findOpen();
  if (open.error) {
    console.error("[knowledge-clarification] open-request lookup failed:", open.error.message);
    return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "db_error" };
  }
  if (open.row) {
    return { kind: "clarification", clarificationId: open.row.id, created: false, reply: CLARIFICATION_STILL_PENDING_REPLY, knowledgeKey: target.key, category: target.category };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("ai_clarification_requests")
    .insert({
      org_id: orgId,
      execution_id: executionId,
      contact_id: contactId,
      lead_id: trustedContext.leadId ?? null,
      inbound_message_id: readMessageRowId(event),
      channel: event.channel,
      question: decision.question.trim().slice(0, 300),
      knowledge_key: target.key,
      category: target.category,
      suggested_options: suggestedOptionsForKey(target.key),
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  if (insertError || !inserted) {
    // 23505 = the partial unique index: a concurrent turn created the same
    // open request between our lookup and insert. Converge on it.
    if ((insertError as { code?: string } | null)?.code === "23505") {
      const raced = await findOpen();
      if (raced.row) {
        return { kind: "clarification", clarificationId: raced.row.id, created: false, reply: CLARIFICATION_STILL_PENDING_REPLY, knowledgeKey: target.key, category: target.category };
      }
    }
    console.error("[knowledge-clarification] insert failed:", insertError?.message);
    return { kind: "unsupported", reply: CLARIFICATION_UNSUPPORTED_REPLY, reason: "db_error" };
  }

  return { kind: "clarification", clarificationId: inserted.id as string, created: true, reply: CLARIFICATION_HOLDING_REPLY, knowledgeKey: target.key, category: target.category };
}

// ── Owner resolution ─────────────────────────────────────────────────────

export type ClarificationRow = {
  id: string;
  org_id: string;
  execution_id: string;
  contact_id: string;
  lead_id: string | null;
  channel: string;
  question: string;
  knowledge_key: string;
  category: string;
  suggested_options: KnowledgeOption[];
  status: "pending" | "sending" | "send_failed" | "resolved" | "dismissed";
  answer: string | null;
  option_id: string | null;
  save_to_knowledge: boolean;
  knowledge_saved_at: string | null;
  knowledge_save_error: string | null;
  send_error: string | null;
  provider_message_id: string | null;
  created_at: string;
};

const CLARIFICATION_COLUMNS =
  "id, org_id, execution_id, contact_id, lead_id, channel, question, knowledge_key, category, suggested_options, status, answer, option_id, save_to_knowledge, knowledge_saved_at, knowledge_save_error, send_error, provider_message_id, created_at";

export type KnowledgeSaveOutcome = "saved" | "not_requested" | "failed";

export type ResolveClarificationResult =
  | { status: "resolved"; clarificationId: string; knowledge: KnowledgeSaveOutcome; alreadyResolved: boolean; providerMessageId?: string }
  | { status: "send_failed"; clarificationId: string; error: string; knowledge: KnowledgeSaveOutcome }
  | { status: "in_progress"; clarificationId: string }
  | { status: "dismissed"; clarificationId: string }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

async function loadClarification(supabase: SupabaseClient, orgId: string, id: string): Promise<{ row: ClarificationRow | null; error: boolean }> {
  const { data, error } = await supabase
    .from("ai_clarification_requests")
    .select(CLARIFICATION_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[knowledge-clarification] load failed:", error.message);
    return { row: null, error: true };
  }
  return { row: (data as ClarificationRow | null) ?? null, error: false };
}

async function nextStepSequence(supabase: SupabaseClient, executionId: string): Promise<number> {
  const { data } = await supabase
    .from("agent_execution_steps")
    .select("sequence")
    .eq("execution_id", executionId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as { sequence?: number } | null)?.sequence ?? 0) + 1;
}

/** Inserts the audit step the executor's finishStep() will complete. unique(execution_id, sequence) races retry once. */
async function insertSendStep(
  supabase: SupabaseClient,
  row: ClarificationRow,
  actionKey: string,
  inputSnapshot: Record<string, unknown>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sequence = await nextStepSequence(supabase, row.execution_id);
    const { data, error } = await supabase
      .from("agent_execution_steps")
      .insert({
        execution_id: row.execution_id,
        org_id: row.org_id,
        sequence,
        step_type: "notify",
        action_key: actionKey,
        status: "running",
        input_snapshot: inputSnapshot,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (!error && data) return data.id as string;
    if ((error as { code?: string } | null)?.code !== "23505") {
      console.error("[knowledge-clarification] step insert failed:", error?.message);
      return null;
    }
  }
  return null;
}

type SendOutcome = { ok: true; providerMessageId: string } | { ok: false; error: string };

/**
 * Sends the owner's answer through the EXISTING trusted outbound path. The
 * owner's explicit "Send Answer" IS the human approval, so this calls
 * executeApprovedStep() (the post-approval half of the pipeline: fresh
 * emergency-pause + opt-out/consent re-check, idempotency slot, the real
 * send_sms/send_whatsapp handler which persists the outbound message to
 * sms_meta_messages) rather than executeStep() (which would create a second,
 * redundant approval). No Twilio/Meta code lives here.
 */
async function sendAnswer(supabase: SupabaseClient, row: ClarificationRow, userId: string, answer: string): Promise<SendOutcome> {
  const actionKey = SEND_ACTION_FOR_CHANNEL[row.channel];
  if (!actionKey || !row.contact_id) return { ok: false, error: "This conversation's channel can't be replied to automatically." };

  const input = { contactId: row.contact_id, body: answer };
  const stepId = await insertSendStep(supabase, row, actionKey, { ...input, clarificationId: row.id });
  if (!stepId) return { ok: false, error: "Could not record the outbound message. Please try again." };

  const result = await executeApprovedStep({
    supabase,
    orgId: row.org_id,
    actor: { actorType: "user", actorId: userId, source: "ai_clarification_resolve" },
    executionId: row.execution_id,
    stepId,
    actionKey,
    approvedInput: input,
    idempotencyKey: `clarification_reply:${row.id}`,
  });

  // Success is only ever claimed on a real provider message id — never
  // inferred from `status === "succeeded"` alone (same proof-of-success rule
  // as agent-approve-action.ts's verifyActionSuccess for send_sms).
  let providerMessageId: unknown;
  if (result.status === "succeeded") {
    providerMessageId = (result.output as { providerMessageId?: unknown } | undefined)?.providerMessageId;
  } else if (result.status === "skipped") {
    const dup = result.output as { reason?: string; result?: { providerMessageId?: unknown } } | undefined;
    if (dup?.reason === "duplicate_suppressed") providerMessageId = dup.result?.providerMessageId;
  }
  if (typeof providerMessageId === "string" && providerMessageId.length > 0) return { ok: true, providerMessageId };
  return { ok: false, error: result.error ?? "Could not verify the message was sent. Please try again." };
}

async function saveKnowledgeFromClarification(supabase: SupabaseClient, row: ClarificationRow, userId: string, answer: string, optionId: string | null): Promise<boolean> {
  const result = await upsertKnowledgeEntry(supabase, {
    orgId: row.org_id,
    userId,
    key: row.knowledge_key,
    question: row.question,
    answer,
    source: "owner_clarification",
    optionId: optionId ?? undefined,
  });
  const now = new Date().toISOString();
  if (result.ok) {
    await supabase.from("ai_clarification_requests").update({ knowledge_saved_at: now, knowledge_save_error: null }).eq("id", row.id).eq("org_id", row.org_id);
    return true;
  }
  await supabase.from("ai_clarification_requests").update({ knowledge_save_error: result.message }).eq("id", row.id).eq("org_id", row.org_id);
  return false;
}

export type ResolveClarificationParams = {
  supabase: SupabaseClient;
  /** Verified, server-resolved org + user — never from the request body. */
  orgId: string;
  userId: string;
  clarificationId: string;
  answer: string;
  optionId?: string;
  saveToKnowledge: boolean;
};

export async function resolveClarification(params: ResolveClarificationParams): Promise<ResolveClarificationResult> {
  const { supabase, orgId, userId, clarificationId, saveToKnowledge } = params;
  const answer = (params.answer ?? "").trim();
  if (!answer) return { status: "invalid", message: "Please choose or write an answer." };
  if (answer.length > MAX_ANSWER_LENGTH) return { status: "invalid", message: `Answers are limited to ${MAX_ANSWER_LENGTH} characters.` };

  const loaded = await loadClarification(supabase, orgId, clarificationId);
  if (loaded.error) return { status: "invalid", message: "Could not load this request. Please try again." };
  const row = loaded.row;
  if (!row) return { status: "not_found" };

  if (row.status === "dismissed") return { status: "dismissed", clarificationId };
  if (row.status === "sending") return { status: "in_progress", clarificationId };

  if (row.status === "resolved") {
    // Duplicate submit after success: NEVER send again. The only thing a
    // repeat may still do is heal a failed knowledge save the owner asked for.
    let knowledge: KnowledgeSaveOutcome = row.save_to_knowledge ? (row.knowledge_saved_at ? "saved" : "failed") : "not_requested";
    if (row.save_to_knowledge && !row.knowledge_saved_at && row.answer) {
      knowledge = (await saveKnowledgeFromClarification(supabase, row, userId, row.answer, row.option_id)) ? "saved" : "failed";
    }
    await cancelStaleHoldingReplies(supabase, row);
    return { status: "resolved", clarificationId, knowledge, alreadyResolved: true, providerMessageId: row.provider_message_id ?? undefined };
  }

  // Atomic claim: pending|send_failed -> sending. A concurrent second submit
  // matches no row here and reports in_progress instead of racing the send.
  const { data: claimed, error: claimError } = await supabase
    .from("ai_clarification_requests")
    .update({ status: "sending", answer, option_id: params.optionId ?? null, save_to_knowledge: saveToKnowledge, resolved_by: userId, send_error: null })
    .eq("id", clarificationId)
    .eq("org_id", orgId)
    .in("status", ["pending", "send_failed"])
    .select(CLARIFICATION_COLUMNS)
    .maybeSingle();
  if (claimError) {
    console.error("[knowledge-clarification] claim failed:", claimError.message);
    return { status: "invalid", message: "Could not process this request. Please try again." };
  }
  if (!claimed) return { status: "in_progress", clarificationId };
  const claimedRow = claimed as ClarificationRow;

  const sent = await sendAnswer(supabase, claimedRow, userId, answer);

  let knowledge: KnowledgeSaveOutcome = "not_requested";
  if (saveToKnowledge) {
    knowledge = claimedRow.knowledge_saved_at
      ? "saved"
      : (await saveKnowledgeFromClarification(supabase, claimedRow, userId, answer, params.optionId ?? null)) ? "saved" : "failed";
  }

  const now = new Date().toISOString();
  if (sent.ok) {
    await supabase
      .from("ai_clarification_requests")
      .update({ status: "resolved", resolved_at: now, provider_message_id: sent.providerMessageId, send_error: null })
      .eq("id", clarificationId)
      .eq("org_id", orgId);
    // The real answer is out — a still-pending "we're confirming" holding reply is now false.
    await cancelStaleHoldingReplies(supabase, claimedRow);
    return { status: "resolved", clarificationId, knowledge, alreadyResolved: false, providerMessageId: sent.providerMessageId };
  }

  await supabase
    .from("ai_clarification_requests")
    .update({ status: "send_failed", send_error: sent.error })
    .eq("id", clarificationId)
    .eq("org_id", orgId);
  return { status: "send_failed", clarificationId, error: sent.error, knowledge };
}

export type DismissClarificationResult = { status: "dismissed" | "not_found" | "already_resolved" | "in_progress" };

export async function dismissClarification(params: { supabase: SupabaseClient; orgId: string; userId: string; clarificationId: string }): Promise<DismissClarificationResult> {
  const { supabase, orgId, userId, clarificationId } = params;
  const loaded = await loadClarification(supabase, orgId, clarificationId);
  if (!loaded.row) return { status: "not_found" };
  if (loaded.row.status === "dismissed") return { status: "dismissed" };
  if (loaded.row.status === "resolved") return { status: "already_resolved" };
  if (loaded.row.status === "sending") return { status: "in_progress" };

  const { data } = await supabase
    .from("ai_clarification_requests")
    .update({ status: "dismissed", resolved_by: userId, resolved_at: new Date().toISOString() })
    .eq("id", clarificationId)
    .eq("org_id", orgId)
    .in("status", ["pending", "send_failed"])
    .select("id")
    .maybeSingle();
  if (!data) return { status: "in_progress" };
  // Dismissed = no answer will follow, so a pending "we'll get back to you" holding reply would be a false promise.
  await cancelStaleHoldingReplies(supabase, loaded.row);
  return { status: "dismissed" };
}
