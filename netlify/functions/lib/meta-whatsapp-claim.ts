// netlify/functions/lib/meta-whatsapp-claim.ts
//
// Per-message AI-dispatch CLAIM WITH A LEASE, stored in the existing
// `sms_meta_messages.meta` jsonb column (no schema change).
//
// Why a lease: the claim used to be a permanent `meta` null -> non-null flip.
// If the worker was hard-killed after claiming (no catch/finally ran), the
// message stayed claimed forever and no retry could ever run the AI for it.
//
// meta shape while a run is in flight:
//   { ai_dispatch_claimed_at, ai_dispatch_lease_expires_at, ai_dispatch_claim_token }
// after the AI run is linked:   + execution_id
// when the run has finished:    + ai_dispatch_completed_at   (terminal — never reclaimed)
//
// A message is claimable when
//   meta IS NULL                                            (never claimed / released)
//   OR (lease_expires_at < now AND completed_at IS NULL)    (abandoned claim)
// The whole condition is evaluated inside ONE conditional UPDATE (PostgREST
// `or=`), so it is atomic in Postgres: of any number of concurrent workers
// racing for the same message exactly one gets a row back. Rows claimed by the
// pre-lease implementation (no lease field) are treated as terminal.
//
// Every later write (link / complete / release) is conditional on this claim's
// token, so a worker whose lease expired and was taken over cannot clobber the
// new owner's claim.
//
// Lease length: AI orchestration makes up to 4 sequential model calls, each with
// a 55 s child-process timeout (providers/anthropic.ts), plus DB work — worst
// case ~4 min. The debounce wait happens BEFORE the claim, so it does not count.
// 5 minutes therefore never expires under a healthy run, while a hard-killed
// message becomes retryable in a bounded time (Netlify background functions may
// run up to 15 min, so a live slow worker is still possible but harmless: it
// fails its next token-guarded write and stands down, and any duplicate
// proposal is collapsed by reconcilePendingWhatsAppApprovals).

import type { SupabaseClient } from "@supabase/supabase-js";

export const WHATSAPP_AI_CLAIM_LEASE_MS = 5 * 60 * 1000;

type ClaimMeta = Record<string, unknown>;

function newToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function claimMeta(nowMs: number, token: string, extra: ClaimMeta = {}): ClaimMeta {
  return {
    ai_dispatch_claimed_at: new Date(nowMs).toISOString(),
    ai_dispatch_lease_expires_at: new Date(nowMs + WHATSAPP_AI_CLAIM_LEASE_MS).toISOString(),
    ai_dispatch_claim_token: token,
    ...extra,
  };
}

export type AiDispatchClaim = { token: string };

/** Atomically claims (or reclaims an abandoned claim on) an inbound message. Null = not claimed. */
export async function claimForAiDispatch(
  supabase: SupabaseClient,
  orgId: string,
  inboundMessageId: string,
  nowMs: number = Date.now(),
): Promise<AiDispatchClaim | null> {
  const token = newToken();
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await supabase
    .from("sms_meta_messages")
    .update({ meta: claimMeta(nowMs, token) })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .or(`meta.is.null,and(meta->>ai_dispatch_lease_expires_at.lt.${nowIso},meta->>ai_dispatch_completed_at.is.null)`)
    .select("id");
  if (error) {
    console.error("[meta-whatsapp-claim] claimForAiDispatch failed:", error);
    return null;
  }
  return (data ?? []).length > 0 ? { token } : null;
}

/** Records the execution id on our own claim (lease kept). False = we no longer own the claim. */
export async function linkClaimExecution(
  supabase: SupabaseClient,
  orgId: string,
  inboundMessageId: string,
  claim: AiDispatchClaim,
  executionId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from("sms_meta_messages")
    .update({ meta: claimMeta(nowMs, claim.token, { execution_id: executionId }) })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .filter("meta->>ai_dispatch_claim_token", "eq", claim.token)
    .select("id");
  if (error) {
    console.error("[meta-whatsapp-claim] could not link execution_id onto inbound message:", error);
    return true; // observability write only; a DB error is not proof the lease was lost
  }
  return (data ?? []).length > 0;
}

/** Terminal: this message's AI dispatch is finished and must never be re-run. */
export async function completeClaim(
  supabase: SupabaseClient,
  orgId: string,
  inboundMessageId: string,
  claim: AiDispatchClaim,
  executionId: string | undefined,
  nowMs: number = Date.now(),
): Promise<void> {
  const { error } = await supabase
    .from("sms_meta_messages")
    .update({
      meta: {
        ai_dispatch_claimed_at: new Date(nowMs).toISOString(),
        ai_dispatch_claim_token: claim.token,
        ai_dispatch_completed_at: new Date(nowMs).toISOString(),
        ...(executionId ? { execution_id: executionId } : {}),
      },
    })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .filter("meta->>ai_dispatch_claim_token", "eq", claim.token);
  if (error) console.error("[meta-whatsapp-claim] completeClaim failed:", error);
}

/** Frees our own claim after a thrown failure so a platform retry can run. No-op if we lost the claim. */
export async function releaseClaim(
  supabase: SupabaseClient,
  orgId: string,
  inboundMessageId: string,
  claim: AiDispatchClaim,
): Promise<void> {
  const { error } = await supabase
    .from("sms_meta_messages")
    .update({ meta: null })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .filter("meta->>ai_dispatch_claim_token", "eq", claim.token)
    .filter("meta->>ai_dispatch_completed_at", "is", null);
  if (error) console.error("[meta-whatsapp-claim] releaseClaim failed:", error);
}
