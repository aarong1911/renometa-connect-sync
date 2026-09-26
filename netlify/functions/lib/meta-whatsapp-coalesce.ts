// netlify/functions/lib/meta-whatsapp-coalesce.ts
//
// WhatsApp burst coalescing + the "one active pending reply per
// conversation" invariant.
//
// Problem: every inbound WhatsApp message used to run its own AI
// orchestration and create its own `send_whatsapp` approval, so a customer
// sending "47", an emoji, "OK" produced three competing pending approvals.
//
// Conversation identity (no dedicated conversation table exists for
// WhatsApp): org_id + contact_id, channel "whatsapp" — the same
// `${contactId}::whatsapp` conversationKey the orchestrator already uses.
// An org has exactly one WhatsApp connection, so this is also one number.
//
// DURABLE MECHANISM — correctness comes from database state, never from a
// sleep finishing or from anything held in process memory:
//
//   WATERMARK. The newest inbound `sms_meta_messages` row of the conversation
//   (ordered by created_at, id) is the watermark. It is already persisted by
//   the webhook before any AI work is dispatched.
//
//   GATE (read from the DB, twice). An invocation may only run the AI when its
//   own message IS the watermark AND the watermark has been quiet for
//   `debounceMs` (measured from the message's own DB created_at, not from when
//   this invocation happened to start). Any invocation whose message is not the
//   watermark exits without side effects. A sleep only shortens the wait for
//   the quiet window; if it is cut short or the instance dies, the message is
//   still unclaimed and a retry / another instance re-evaluates the same DB
//   state and converges on the same single runner.
//
//   CLAIM. The runner atomically claims its message (`meta` null -> non-null,
//   conditional UPDATE) AFTER the gate, so a run that dies while waiting never
//   burns the claim, and duplicate deliveries of the same message run once.
//
//   RECONCILE (the invariant). reconcilePendingWhatsAppApprovals() cancels every
//   pending approval whose trigger message is not the current watermark
//   (`cancelled`, already allowed by the table's CHECK; the row is kept for
//   audit) and, if several pending approvals share the watermark trigger,
//   keeps only the most recently requested one. It is a pure function of DB
//   state and idempotent, so concurrent runs converge on the same result, and
//   it also runs when the newest run FAILS — a stale approval is never left
//   pending (or "resurrected") because the reply that would replace it failed.

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_WHATSAPP_DEBOUNCE_MS = 4000;
const MAX_DEBOUNCE_MS = 10_000;

/** AI_WHATSAPP_DEBOUNCE_MS override (0 disables); clamped to a safe range. */
export function resolveWhatsAppDebounceMs(raw: string | undefined = process.env.AI_WHATSAPP_DEBOUNCE_MS): number {
  if (raw === undefined || raw === "") return DEFAULT_WHATSAPP_DEBOUNCE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WHATSAPP_DEBOUNCE_MS;
  return Math.min(Math.floor(n), MAX_DEBOUNCE_MS);
}

export type InboundKey = { id: string; createdAt: string };

function isLater(a: InboundKey, b: InboundKey): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

export async function loadInboundKey(supabase: SupabaseClient, orgId: string, inboundMessageId: string): Promise<InboundKey | null> {
  const { data } = await supabase
    .from("sms_meta_messages")
    .select("id, created_at")
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data ? { id: data.id as string, createdAt: data.created_at as string } : null;
}

/** The conversation watermark: newest inbound WhatsApp message for org + contact. */
export async function getNewestInbound(supabase: SupabaseClient, orgId: string, contactId: string): Promise<InboundKey | null> {
  const { data } = await supabase
    .from("sms_meta_messages")
    .select("id, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(5);
  let newest: InboundKey | null = null;
  for (const row of (data ?? []) as Array<{ id: string; created_at: string }>) {
    const k = { id: row.id, createdAt: row.created_at };
    if (!newest || isLater(k, newest)) newest = k;
  }
  return newest;
}

/** True when no inbound WhatsApp message newer than this one exists for the conversation. */
export async function isNewestInboundForConversation(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const newest = await getNewestInbound(supabase, orgId, contactId);
  if (!newest) return true; // can't prove a newer one exists — fail toward replying
  return newest.id === inboundMessageId;
}

/** Milliseconds still to wait so the message has been quiet for `debounceMs`, by DB clock time. */
export function remainingQuietMs(messageCreatedAt: string, debounceMs: number, nowMs: number): number {
  const created = Date.parse(messageCreatedAt);
  if (!Number.isFinite(created)) return debounceMs;
  return Math.max(0, Math.min(debounceMs, created + debounceMs - nowMs));
}

/**
 * The customer's latest burst: consecutive inbound messages since the last
 * outbound message, oldest first, joined into one text so the AI answers the
 * combined intent instead of only the final fragment.
 */
export async function collectInboundBurstText(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
  fallbackText: string,
  maxChars = 1000,
): Promise<string> {
  const { data } = await supabase
    .from("sms_meta_messages")
    .select("direction, body, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(20);
  const burst: string[] = [];
  for (const row of (data ?? []) as Array<{ direction: string; body: string | null }>) {
    if (row.direction !== "in") break;
    if (row.body && row.body.trim()) burst.push(row.body.trim());
  }
  if (burst.length === 0) return fallbackText;
  const text = burst.reverse().join("\n");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export type PendingReconcileResult = { keptApprovalId: string | null; cancelledApprovalIds: string[] };

type PendingRow = { id: string; execution_id: string; execution_step_id: string | null; requested_at: string; metadata: any };

function triggerMessageId(row: PendingRow): string | null {
  const m = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return typeof m.inbound_message_id === "string" ? m.inbound_message_id : null;
}

function requestedOrder(a: PendingRow, b: PendingRow): number {
  const ka = `${a.requested_at ?? ""}|${a.id}`;
  const kb = `${b.requested_at ?? ""}|${b.id}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Enforces "at most one pending send_whatsapp approval per (org, contact)":
 * an approval is CURRENT only if its trigger message is the conversation
 * watermark; every other pending approval is stale and is cancelled (history
 * kept). Among current ones, the most recently requested is kept. Approvals
 * without trigger metadata (created before this change) count as stale.
 * Idempotent and order-independent, so concurrent runs converge.
 */
export async function reconcilePendingWhatsAppApprovals(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<PendingReconcileResult> {
  const { data, error } = await supabase
    .from("agent_approval_requests")
    .select("id, execution_id, execution_step_id, requested_at, metadata")
    .eq("org_id", orgId)
    .eq("action_key", "send_whatsapp")
    .eq("target_entity_id", contactId)
    .eq("status", "pending");
  if (error) {
    console.error("[meta-whatsapp-coalesce] pending lookup failed:", error.message);
    return { keptApprovalId: null, cancelledApprovalIds: [] };
  }
  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return { keptApprovalId: null, cancelledApprovalIds: [] };

  const watermark = await getNewestInbound(supabase, orgId, contactId);
  const current = watermark ? rows.filter((r) => triggerMessageId(r) === watermark.id) : rows;
  const keep = [...current].sort(requestedOrder).pop() ?? null;
  const cancelledApprovalIds: string[] = [];

  for (const loser of rows.filter((r) => r.id !== keep?.id)) {
    // Conditional on status = 'pending': never overwrites an approval a human
    // just approved/rejected in the meantime (Postgres re-checks the predicate
    // after taking the row lock, so exactly one of the two writers wins).
    const { data: updated, error: updErr } = await supabase
      .from("agent_approval_requests")
      .update({
        status: "cancelled",
        reviewed_at: new Date().toISOString(),
        rejection_reason: "Superseded by a newer message in this conversation.",
        metadata: {
          ...(loser.metadata && typeof loser.metadata === "object" ? loser.metadata : {}),
          superseded_at_watermark: watermark?.id ?? null,
          ...(keep ? { superseded_by: keep.id } : {}),
        },
      })
      .eq("id", loser.id)
      .eq("org_id", orgId)
      .eq("status", "pending")
      .select("id");
    if (updErr) {
      console.error("[meta-whatsapp-coalesce] supersede failed:", updErr.message);
      continue;
    }
    if ((updated ?? []).length === 0) continue;
    cancelledApprovalIds.push(loser.id);
    // Keep the run history consistent (best-effort).
    if (loser.execution_step_id) {
      await supabase.from("agent_execution_steps").update({ status: "cancelled" }).eq("id", loser.execution_step_id).eq("status", "awaiting_approval");
    }
    await supabase.from("agent_executions").update({ status: "cancelled" }).eq("id", loser.execution_id).eq("org_id", orgId).eq("status", "awaiting_approval");
  }
  return { keptApprovalId: keep?.id ?? null, cancelledApprovalIds };
}

/** Stored on the approval so it can be matched against the conversation watermark. */
export async function buildApprovalTriggerMetadata(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
  inboundMessageId: string,
): Promise<Record<string, unknown>> {
  const key = await loadInboundKey(supabase, orgId, inboundMessageId);
  return {
    channel: "whatsapp",
    conversation_key: `${contactId}::whatsapp`,
    inbound_message_id: inboundMessageId,
    ...(key ? { inbound_at: key.createdAt } : {}),
  };
}
