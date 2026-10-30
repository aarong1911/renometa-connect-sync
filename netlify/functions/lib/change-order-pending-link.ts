// netlify/functions/lib/change-order-pending-link.ts
//
// Pending Change Order approval links (migration 20261030). change-order-send
// records the link's token hash BEFORE emailing (prepare_project_change_order_send)
// and activates it once Gmail accepts. If that activation doesn't happen —
// a DB failure after delivery, a lost response, an unconfirmed Gmail outcome
// that was in fact delivered — the customer's first use of the link
// activates it here instead. Only the delivered email holds the plaintext
// token, so presenting it proves delivery: the condition for "sent".
//
// Every pre-existing link has no pending row and gets `not_pending`, so the
// customer-facing paths behave exactly as before for them.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PendingLinkStatus =
  | "not_pending"
  | "already_active"
  | "activated"
  | "discarded"
  | "expired"
  | "changed"
  | "not_sendable"
  /** The activation call itself failed; the link stays pending and can be retried. */
  | "error";

export type SendRpcResult = { isFirstSend?: boolean; changeOrderNumber?: string; title?: string; totalAmount?: number } | null;

export type PendingLinkActivation = { status: PendingLinkStatus; result: SendRpcResult };

export function hashApprovalToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Never throws. Never logs the hash or token. */
export async function activatePendingChangeOrderLink(admin: SupabaseClient, tokenHash: string): Promise<PendingLinkActivation> {
  try {
    const { data, error } = await admin.rpc("activate_project_change_order_send", { p_token_hash: tokenHash });
    if (error) {
      console.error("[change-order-pending-link] activation failed", { message: error.message });
      return { status: "error", result: null };
    }
    const body = (data ?? {}) as { status?: unknown; result?: unknown };
    const status = typeof body.status === "string" ? (body.status as PendingLinkStatus) : "error";
    return { status, result: (body.result ?? null) as SendRpcResult };
  } catch (err) {
    console.error("[change-order-pending-link] activation threw", { message: err instanceof Error ? err.message : String(err) });
    return { status: "error", result: null };
  }
}

/** Mark a link that was never delivered (Gmail definitively rejected it) so it can never go live. Best-effort. */
export async function discardPendingChangeOrderLink(admin: SupabaseClient, input: { tokenHash: string; orgId: string }): Promise<void> {
  const { error } = await admin
    .from("project_change_order_pending_sends")
    .update({ discarded_at: new Date().toISOString() })
    .eq("token_hash", input.tokenHash)
    .eq("org_id", input.orgId)
    .is("activated_at", null);
  if (error) console.warn("[change-order-pending-link] discard failed", { message: error.message });
}
