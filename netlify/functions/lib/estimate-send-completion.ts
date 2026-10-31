// netlify/functions/lib/estimate-send-completion.ts
//
// What happens to an estimate once Gmail has accepted its proposal email:
// mark it sent (in the same compare-and-set UPDATE that closes the
// duplicate-send claim), record the "sent" activity with the Gmail ids,
// fire the estimate_sent workflow and sync the Deal. Shared by
// estimate-send.ts (the normal path and the contractor's retry) and by
// recoverDeliveredProposal below (the customer opening a link whose
// estimate never got marked sent).
//
// recoverDeliveredProposal — proposal-link availability after a partial
// failure. If Gmail accepted the email but the estimate's status update
// failed, the estimate is still draft/ready and proposal-data.ts would
// return 404 for the link the customer just received. The estimate is only
// exposed when there is TRUSTED, server-side evidence of delivery: Gmail
// itself must confirm, with the org's own connected account, that a
// message carrying this send's X-RenoMeta-Send-Id is in Sent mail (by its
// stored Gmail id, or by searching Sent mail when the id never got saved).
// The claim metadata only says WHICH message to look for — it is never
// evidence on its own, so editing it can't expose an unsent draft. A claim
// takeover (compare-and-set) means the customer view and a contractor
// retry can never both record the send.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCustomerActionable, type EstimateStatus } from "../../../src/lib/estimate-status";
import { syncEstimateDeal, logDealSyncWarning } from "../../lib/estimate-deal-sync";
import { readEmailSendClaim, takeOverEmailSendClaim, updateEmailSendClaim } from "./email-send-claim";
import {
  findSentGmailMessage,
  GmailSendError,
  resolveGmailSender,
  verifySentGmailMessage,
  type FetchLike,
  type SentLookup,
} from "./gmail-send";

export type CompletableEstimate = {
  id: string;
  org_id: string;
  status: EstimateStatus;
  number: string | null;
  version_number: number;
  client_id: string | null;
  project_id: string | null;
};

export type EstimateDelivery = {
  gmailMessageId: string;
  gmailThreadId: string | null;
  fromEmail: string | null;
  sentAt: string;
};

/** The status a send moves an estimate to (resends keep their current status). */
export function nextStatusAfterSend(status: EstimateStatus): EstimateStatus {
  return status === "draft" || status === "ready" ? "sent" : status;
}

export async function completeEstimateSend(
  admin: SupabaseClient,
  input: {
    estimate: CompletableEstimate;
    claimId: string;
    delivery: EstimateDelivery;
    recipientEmail: string | null;
    actorUserId: string | null;
    totals: { total: number | null; depositAmount: number | null };
    /** Finishing an earlier send rather than the request that emailed it. */
    recordedAfterRetry: boolean;
    recordedVia?: "customer_view";
    workflowBaseUrl: string;
  },
): Promise<{ ok: true; nextStatus: EstimateStatus } | { ok: false; error: string }> {
  const { estimate, delivery } = input;
  const orgId = estimate.org_id;
  const isFirstSend = !isCustomerActionable(estimate.status) && estimate.status !== "changes_requested";
  const nextStatus = nextStatusAfterSend(estimate.status);

  const finalized = await updateEmailSendClaim(
    admin,
    "estimates",
    { id: estimate.id, orgId, claimId: input.claimId },
    {
      state: "sent",
      gmailMessageId: delivery.gmailMessageId,
      gmailThreadId: delivery.gmailThreadId,
      fromEmail: delivery.fromEmail,
      sentAt: delivery.sentAt,
    },
    { status: nextStatus, sent_at: delivery.sentAt },
  );
  if (!finalized.ok) return { ok: false, error: finalized.error ?? "update failed" };

  const recipientLabel = input.recipientEmail ?? "the customer";
  const { error: activityError } = await admin.from("estimate_activities").insert({
    org_id: orgId,
    estimate_id: estimate.id,
    version_number: estimate.version_number,
    activity_type: "sent",
    actor_type: "user",
    actor_id: input.actorUserId,
    title: isFirstSend ? "Proposal sent" : "Proposal re-sent",
    description: delivery.fromEmail ? `Sent to ${recipientLabel} from ${delivery.fromEmail}` : `Sent to ${recipientLabel}`,
    metadata: {
      delivery_channel: "email",
      provider: "gmail",
      gmail_message_id: delivery.gmailMessageId,
      gmail_thread_id: delivery.gmailThreadId,
      from_email: delivery.fromEmail,
      contact_id: estimate.client_id,
      project_id: estimate.project_id,
      sent_at: delivery.sentAt,
      ...(input.recordedAfterRetry ? { recorded_after_retry: true } : {}),
      ...(input.recordedVia ? { recorded_via: input.recordedVia } : {}),
    },
  });
  if (activityError) {
    // Do not report the email as failed after confirmed delivery.
    console.error("[estimate-send] Sent activity insert failed", { estimateId: estimate.id, code: activityError.code ?? null, message: activityError.message });
  }

  void fetch(`${input.workflowBaseUrl}/.netlify/functions/execute-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orgId,
      triggerType: "estimate_sent",
      triggerData: {
        estimateId: estimate.id,
        estimateNumber: estimate.number,
        version: estimate.version_number,
        status: nextStatus,
        total: input.totals.total,
        depositAmount: input.totals.depositAmount,
        clientId: estimate.client_id,
        ownerId: input.actorUserId,
        occurredAt: delivery.sentAt,
      },
    }),
  }).catch((workflowError: unknown) => {
    console.warn("[estimate-send] Workflow trigger failed", { message: workflowError instanceof Error ? workflowError.message : String(workflowError) });
  });

  // Deal sync is advisory: the email is delivered and the estimate is marked
  // sent, so a sync failure must never turn this into an error.
  try {
    const syncResult = await syncEstimateDeal(admin, {
      estimateId: estimate.id, orgId, trigger: "sent", actorUserId: input.actorUserId ?? undefined,
    });
    if (!syncResult.ok) {
      logDealSyncWarning("sent -> deal sync failed (non-blocking)", { estimateId: estimate.id, orgId, error: syncResult.error });
    }
  } catch (syncError) {
    logDealSyncWarning("sent -> deal sync threw (non-blocking)", { estimateId: estimate.id, orgId, error: syncError instanceof Error ? syncError.message : String(syncError) });
  }

  return { ok: true, nextStatus };
}

const RECOVERABLE_STATES = new Set(["sent_unrecorded", "sending", "delivery_unknown"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer opened (or acted on) a proposal link whose estimate is still
 * draft/ready. Returns the estimate's new status if Gmail confirms the
 * proposal email was delivered and the send was completed (by this call or
 * a concurrent one), otherwise null — the caller keeps returning 404.
 * Never sends anything.
 */
export async function recoverDeliveredProposal(
  admin: SupabaseClient,
  estimate: CompletableEstimate & { metadata: unknown; total: number | string | null; deposit_amount: number | string | null },
  opts: { workflowBaseUrl: string; fetchImpl?: FetchLike },
): Promise<EstimateStatus | null> {
  if (estimate.status !== "draft" && estimate.status !== "ready") return null;
  const claim = readEmailSendClaim(estimate.metadata);
  if (!claim || !claim.state || !RECOVERABLE_STATES.has(claim.state)) return null;
  // The claim must be for this exact version of the estimate.
  if (claim.version !== estimate.version_number) return null;

  let sender;
  try {
    sender = await resolveGmailSender(admin, estimate.org_id, opts.fetchImpl);
  } catch (err) {
    if (err instanceof GmailSendError) return null;
    throw err;
  }

  let evidence: SentLookup;
  if (claim.gmailMessageId) {
    evidence = await verifySentGmailMessage(sender, { gmailMessageId: claim.gmailMessageId, sendId: claim.sendId }, opts.fetchImpl);
  } else {
    const claimedAt = claim.claimedAt ? new Date(claim.claimedAt) : null;
    if (!claimedAt || !Number.isFinite(claimedAt.getTime())) return null;
    evidence = await findSentGmailMessage(sender, { sendId: claim.sendId, claimedAt }, opts.fetchImpl);
  }
  if (evidence.status !== "found") return null;

  const sentAt = claim.sentAt ?? claim.claimedAt ?? new Date().toISOString();
  const recoveryClaimId = await takeOverEmailSendClaim(
    admin,
    "estimates",
    { id: estimate.id, orgId: estimate.org_id, claimId: claim.claimId, userId: claim.claimedBy ?? "proposal-view" },
    { state: "sent_unrecorded", gmailMessageId: evidence.gmailMessageId, gmailThreadId: evidence.gmailThreadId, fromEmail: sender.accountEmail, sentAt },
  );
  if (!recoveryClaimId) {
    // Someone else (a concurrent view or the contractor's retry) is finishing it.
    const { data } = await admin.from("estimates").select("status").eq("id", estimate.id).eq("org_id", estimate.org_id).maybeSingle();
    const status = (data as { status?: EstimateStatus } | null)?.status ?? null;
    return status && status !== "draft" && status !== "ready" ? status : null;
  }

  const { data: contact } = estimate.client_id
    ? await admin.from("contacts").select("email").eq("id", estimate.client_id).eq("org_id", estimate.org_id).maybeSingle()
    : { data: null };
  const toNumber = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

  const completed = await completeEstimateSend(admin, {
    estimate,
    claimId: recoveryClaimId,
    delivery: { gmailMessageId: evidence.gmailMessageId, gmailThreadId: evidence.gmailThreadId, fromEmail: sender.accountEmail, sentAt },
    recipientEmail: (contact as { email?: string | null } | null)?.email?.trim() || null,
    actorUserId: claim.claimedBy && UUID_PATTERN.test(claim.claimedBy) ? claim.claimedBy : null,
    totals: { total: toNumber(estimate.total), depositAmount: toNumber(estimate.deposit_amount) },
    recordedAfterRetry: true,
    recordedVia: "customer_view",
    workflowBaseUrl: opts.workflowBaseUrl,
  });
  if (!completed.ok) {
    console.error("[estimate-send] proposal delivery confirmed by Gmail but recording it failed", { estimateId: estimate.id });
    return null;
  }
  return completed.nextStatus;
}
