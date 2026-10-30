// netlify/functions/lib/email-send-claim.ts
//
// Duplicate-send protection for customer document email (estimates, change
// orders), stored in the document row's existing `metadata` jsonb — no new
// table or migration.
//
// A send first takes a claim with a compare-and-set UPDATE filtered on the
// previous claim id (`metadata->>email_send_claim_id`). Two concurrent
// requests (double click, client retry) read the same previous claim; the
// second UPDATE re-checks its WHERE after the first commits, matches zero
// rows, and is refused — so only one request ever reaches Gmail. Recovery
// paths take the claim over the same way (a new claim id, CAS on the old
// one), so two retries can never both finish recording or both resend.
//
// The claim id doubles as the message's X-RenoMeta-Send-Id header, which is
// how an ambiguous send is found in Gmail's Sent mail later.
//
// States:
//   sending           claimed, Gmail not yet confirmed. A stale one (the
//                     function crashed or timed out mid-send) is treated like
//                     delivery_unknown, never as "nothing was sent".
//   delivery_unknown  Gmail's answer was ambiguous (5xx / network / no id).
//                     The next send request reconciles against Sent mail
//                     before anything is emailed again.
//   sent              Gmail accepted and the document's sent state was saved.
//   sent_unrecorded   Gmail accepted but saving the document's sent state
//                     failed. The next send request finishes recording from
//                     the stored Gmail ids (and, for change orders, the stored
//                     approval-token hash) instead of emailing again.
//   failed            definite failure (nothing sent); free to retry at once.
//
// Neither estimates' activity trigger nor change orders' lifecycle trigger
// reacts to metadata-only updates, so claims add no timeline noise.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findSentGmailMessage, type FetchLike, type GmailSender } from "./gmail-send.ts";

export type ClaimTable = "estimates" | "project_change_orders";
export type ClaimState = "sending" | "delivery_unknown" | "sent" | "sent_unrecorded" | "failed";

/** A crashed/timed-out function can't hold a document hostage longer than this. */
export const SENDING_STALE_MS = 10 * 60 * 1000;
/** A second send of the same document this soon after a confirmed one is treated as a duplicate. */
export const RECENTLY_SENT_MS = 60 * 1000;
/** Sent-mail search can lag a fresh send; "not found" is only trusted after this long. */
export const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;

export const CLAIM_KEYS = {
  id: "email_send_claim_id",
  state: "email_send_state",
  claimedAt: "email_send_claimed_at",
  claimedBy: "email_send_claimed_by",
  version: "email_send_version",
  gmailMessageId: "email_gmail_message_id",
  gmailThreadId: "email_gmail_thread_id",
  fromEmail: "email_from",
  sentAt: "email_sent_at",
  // Change orders only: the SHA-256 of the approval token the email links to
  // (never the token itself), so a delivered email's link can still be
  // activated if finalizing failed.
  tokenHash: "email_token_hash",
  tokenExpiresAt: "email_token_expires_at",
  // The X-RenoMeta-Send-Id of the email this claim is about. Equal to the
  // claim id when the send starts; kept when a recovery takes the claim
  // over (which rotates the claim id), so the email can still be found.
  sendId: "email_send_id",
} as const;

type Metadata = Record<string, unknown>;

type StoredToken = { tokenHash: string | null; tokenExpiresAt: string | null };

export type SentUnrecorded = {
  ok: false;
  code: "email_sent_unrecorded";
  claimId: string;
  sendId: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  fromEmail: string | null;
  sentAt: string | null;
} & StoredToken;

export type DeliveryUnconfirmed = {
  ok: false;
  code: "email_delivery_unconfirmed";
  claimId: string;
  sendId: string;
  claimedAt: string | null;
} & StoredToken;

export type ClaimRefusal =
  | { ok: false; code: "email_send_in_progress" | "email_recently_sent" | "claim_failed" }
  | SentUnrecorded
  | DeliveryUnconfirmed;

export type Claim = { ok: true; claimId: string };

function asMetadata(value: unknown): Metadata {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Metadata) } : {};
}

function ageMs(iso: unknown, now: number): number {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function storedToken(metadata: Metadata): StoredToken {
  return { tokenHash: str(metadata[CLAIM_KEYS.tokenHash]), tokenExpiresAt: str(metadata[CLAIM_KEYS.tokenExpiresAt]) };
}

async function readMetadata(admin: SupabaseClient, table: ClaimTable, id: string, orgId: string): Promise<Metadata | null> {
  const { data, error } = await admin.from(table).select("metadata").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error || !data) return null;
  return asMetadata((data as { metadata?: unknown }).metadata);
}

export async function acquireEmailSendClaim(
  admin: SupabaseClient,
  table: ClaimTable,
  input: { id: string; orgId: string; userId: string; version: number | null; now?: Date },
): Promise<Claim | ClaimRefusal> {
  const now = (input.now ?? new Date()).getTime();
  const metadata = await readMetadata(admin, table, input.id, input.orgId);
  if (!metadata) return { ok: false, code: "claim_failed" };

  const state = metadata[CLAIM_KEYS.state];
  const previousClaimId = str(metadata[CLAIM_KEYS.id]);
  const sameVersion = (metadata[CLAIM_KEYS.version] ?? null) === input.version;
  const sendingStale = state === "sending" && ageMs(metadata[CLAIM_KEYS.claimedAt], now) >= SENDING_STALE_MS;

  if (state === "sending" && !sendingStale) {
    return { ok: false, code: "email_send_in_progress" };
  }
  if (state === "sent" && sameVersion && ageMs(metadata[CLAIM_KEYS.sentAt], now) < RECENTLY_SENT_MS) {
    return { ok: false, code: "email_recently_sent" };
  }
  const gmailMessageId = str(metadata[CLAIM_KEYS.gmailMessageId]);
  if (state === "sent_unrecorded" && sameVersion && previousClaimId && gmailMessageId) {
    return {
      ok: false,
      code: "email_sent_unrecorded",
      claimId: previousClaimId,
      sendId: str(metadata[CLAIM_KEYS.sendId]) ?? previousClaimId,
      gmailMessageId,
      gmailThreadId: str(metadata[CLAIM_KEYS.gmailThreadId]),
      fromEmail: str(metadata[CLAIM_KEYS.fromEmail]),
      sentAt: str(metadata[CLAIM_KEYS.sentAt]),
      ...storedToken(metadata),
    };
  }
  if ((state === "delivery_unknown" || sendingStale) && sameVersion && previousClaimId) {
    return {
      ok: false,
      code: "email_delivery_unconfirmed",
      claimId: previousClaimId,
      sendId: str(metadata[CLAIM_KEYS.sendId]) ?? previousClaimId,
      claimedAt: str(metadata[CLAIM_KEYS.claimedAt]),
      ...storedToken(metadata),
    };
  }

  const claimId = crypto.randomUUID();
  const next: Metadata = {
    ...metadata,
    [CLAIM_KEYS.id]: claimId,
    [CLAIM_KEYS.state]: "sending",
    [CLAIM_KEYS.claimedAt]: new Date(now).toISOString(),
    [CLAIM_KEYS.claimedBy]: input.userId,
    [CLAIM_KEYS.version]: input.version,
    [CLAIM_KEYS.sendId]: claimId,
    [CLAIM_KEYS.tokenHash]: null,
    [CLAIM_KEYS.tokenExpiresAt]: null,
  };

  let query = admin.from(table).update({ metadata: next }).eq("id", input.id).eq("org_id", input.orgId);
  query = previousClaimId
    ? query.eq(`metadata->>${CLAIM_KEYS.id}`, previousClaimId)
    : query.is(`metadata->>${CLAIM_KEYS.id}`, null);
  const { data, error } = await query.select("id");
  if (error) return { ok: false, code: "claim_failed" };
  if (!data || data.length !== 1) return { ok: false, code: "email_send_in_progress" };
  return { ok: true, claimId };
}

export type ClaimPatch = {
  state: ClaimState;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  fromEmail?: string | null;
  sentAt?: string | null;
  tokenHash?: string | null;
  tokenExpiresAt?: string | null;
};

function applyPatch(metadata: Metadata, patch: ClaimPatch): Metadata {
  const next: Metadata = { ...metadata, [CLAIM_KEYS.state]: patch.state };
  if (patch.gmailMessageId !== undefined) next[CLAIM_KEYS.gmailMessageId] = patch.gmailMessageId;
  if (patch.gmailThreadId !== undefined) next[CLAIM_KEYS.gmailThreadId] = patch.gmailThreadId;
  if (patch.fromEmail !== undefined) next[CLAIM_KEYS.fromEmail] = patch.fromEmail;
  if (patch.sentAt !== undefined) next[CLAIM_KEYS.sentAt] = patch.sentAt;
  if (patch.tokenHash !== undefined) next[CLAIM_KEYS.tokenHash] = patch.tokenHash;
  if (patch.tokenExpiresAt !== undefined) next[CLAIM_KEYS.tokenExpiresAt] = patch.tokenExpiresAt;
  return next;
}

/**
 * Move a held claim to a new state, optionally together with other column
 * updates on the same row (one UPDATE — e.g. an estimate's status/sent_at).
 * Only succeeds while this request still owns the claim.
 */
export async function updateEmailSendClaim(
  admin: SupabaseClient,
  table: ClaimTable,
  input: { id: string; orgId: string; claimId: string },
  patch: ClaimPatch,
  columns: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  const metadata = await readMetadata(admin, table, input.id, input.orgId);
  if (!metadata) return { ok: false, error: "row not readable" };
  const { data, error } = await admin
    .from(table)
    .update({ ...columns, metadata: applyPatch(metadata, patch) })
    .eq("id", input.id)
    .eq("org_id", input.orgId)
    .eq(`metadata->>${CLAIM_KEYS.id}`, input.claimId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length !== 1) return { ok: false, error: "claim no longer held" };
  return { ok: true };
}

/**
 * Atomically replace someone else's (unfinished) claim with a new one owned
 * by this request. Exactly one of several concurrent recoveries wins; the
 * rest get null and must refuse.
 */
export async function takeOverEmailSendClaim(
  admin: SupabaseClient,
  table: ClaimTable,
  input: { id: string; orgId: string; claimId: string; userId: string; now?: Date },
  patch: ClaimPatch,
): Promise<string | null> {
  const metadata = await readMetadata(admin, table, input.id, input.orgId);
  if (!metadata || metadata[CLAIM_KEYS.id] !== input.claimId) return null;
  const claimId = crypto.randomUUID();
  const next = applyPatch(
    {
      ...metadata,
      [CLAIM_KEYS.id]: claimId,
      [CLAIM_KEYS.claimedAt]: (input.now ?? new Date()).toISOString(),
      [CLAIM_KEYS.claimedBy]: input.userId,
      // A takeover that starts a NEW send gets a new send id; one that only
      // finishes recording keeps the delivered email's.
      ...(patch.state === "sending" ? { [CLAIM_KEYS.sendId]: claimId } : {}),
    },
    patch,
  );
  const { data, error } = await admin
    .from(table)
    .update({ metadata: next })
    .eq("id", input.id)
    .eq("org_id", input.orgId)
    .eq(`metadata->>${CLAIM_KEYS.id}`, input.claimId)
    .select("id");
  if (error || !data || data.length !== 1) return null;
  return claimId;
}

/** Best-effort release after a definite failure (nothing was sent). */
export async function releaseEmailSendClaim(
  admin: SupabaseClient,
  table: ClaimTable,
  input: { id: string; orgId: string; claimId: string },
): Promise<void> {
  const result = await updateEmailSendClaim(admin, table, input, { state: "failed" });
  if (!result.ok) console.warn(`[email-send-claim] release failed on ${table}:`, result.error);
}

export type ReconcileOutcome =
  /** Gmail has the message: the claim now holds its ids as sent_unrecorded — finish recording, never resend. */
  | { kind: "delivered"; claimId: string; gmailMessageId: string; gmailThreadId: string | null; sentAt: string }
  /** The user confirmed a resend after being told delivery is uncertain: a fresh `sending` claim to send with. */
  | { kind: "not_sent"; claimId: string }
  /**
   * Still can't tell. `canConfirmResend` once the outcome has settled long
   * enough for the user's informed "Send anyway" to be accepted;
   * `sentFolderChecked` when the Sent search ran and simply found nothing.
   */
  | { kind: "unconfirmed"; canConfirmResend: boolean; sentFolderChecked: boolean }
  /** Another request took the claim first. */
  | { kind: "busy" };

/**
 * Resolve an ambiguous earlier send (delivery_unknown, or a stale `sending`)
 * by looking for its X-RenoMeta-Send-Id in the account's Sent mail. Nothing
 * is ever emailed from here.
 *
 * Only a match is conclusive. "Not found" is NOT proof Gmail didn't accept
 * the message — search indexing lags, and the search is bounded — so a
 * resend always needs the user's explicit confirmation (`confirmResend`)
 * after being told delivery is uncertain, and only once the outcome has had
 * RECONCILE_MIN_AGE_MS to settle. There is no automatic resend path.
 */
export async function reconcileUnconfirmedSend(
  admin: SupabaseClient,
  table: ClaimTable,
  input: {
    id: string;
    orgId: string;
    userId: string;
    refusal: DeliveryUnconfirmed;
    sender: GmailSender;
    confirmResend?: boolean;
    now?: Date;
    fetchImpl?: FetchLike;
  },
): Promise<ReconcileOutcome> {
  const now = input.now ?? new Date();
  const claimedAtMs = input.refusal.claimedAt ? Date.parse(input.refusal.claimedAt) : NaN;
  const settled = !Number.isFinite(claimedAtMs) || now.getTime() - claimedAtMs >= RECONCILE_MIN_AGE_MS;
  const ref = { id: input.id, orgId: input.orgId, claimId: input.refusal.claimId, userId: input.userId, now };

  const lookup = await findSentGmailMessage(
    input.sender,
    { sendId: input.refusal.sendId, claimedAt: Number.isFinite(claimedAtMs) ? new Date(claimedAtMs) : now },
    input.fetchImpl,
  );

  if (lookup.status === "found") {
    const sentAt = input.refusal.claimedAt ?? now.toISOString();
    const claimId = await takeOverEmailSendClaim(admin, table, ref, {
      state: "sent_unrecorded",
      gmailMessageId: lookup.gmailMessageId,
      gmailThreadId: lookup.gmailThreadId,
      fromEmail: input.sender.accountEmail,
      sentAt,
    });
    return claimId
      ? { kind: "delivered", claimId, gmailMessageId: lookup.gmailMessageId, gmailThreadId: lookup.gmailThreadId, sentAt }
      : { kind: "busy" };
  }

  if (!settled || input.confirmResend !== true) {
    return { kind: "unconfirmed", canConfirmResend: settled, sentFolderChecked: lookup.status === "not_found" };
  }

  const claimId = await takeOverEmailSendClaim(admin, table, ref, {
    state: "sending",
    gmailMessageId: null,
    gmailThreadId: null,
    sentAt: null,
    tokenHash: null,
    tokenExpiresAt: null,
  });
  return claimId ? { kind: "not_sent", claimId } : { kind: "busy" };
}

/** User-facing text for an unconfirmed earlier send. Never claims the email was or wasn't delivered. */
export function unconfirmedDeliveryMessage(
  documentLabel: string,
  outcome: { canConfirmResend: boolean; sentFolderChecked: boolean },
): string {
  if (!outcome.canConfirmResend) {
    return `Gmail hasn't confirmed whether the earlier ${documentLabel} email was sent. Try again in a couple of minutes — sending now could email the customer twice.`;
  }
  return outcome.sentFolderChecked
    ? `Gmail never confirmed the earlier ${documentLabel} email, and RenoMeta couldn't find it in your Gmail Sent folder — but that isn't certain. Check your Sent folder; if it isn't there, choose Send anyway.`
    : `RenoMeta couldn't check whether the earlier ${documentLabel} email was sent. Check your Gmail Sent folder; if it isn't there, choose Send anyway.`;
}

export type EmailSendClaimSnapshot = {
  claimId: string;
  sendId: string;
  state: string | null;
  version: unknown;
  claimedAt: string | null;
  claimedBy: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  fromEmail: string | null;
  sentAt: string | null;
};

/** Read-only view of a document's claim metadata (null when it has never been claimed). */
export function readEmailSendClaim(metadataValue: unknown): EmailSendClaimSnapshot | null {
  const metadata = asMetadata(metadataValue);
  const claimId = str(metadata[CLAIM_KEYS.id]);
  if (!claimId) return null;
  return {
    claimId,
    sendId: str(metadata[CLAIM_KEYS.sendId]) ?? claimId,
    state: str(metadata[CLAIM_KEYS.state]),
    version: metadata[CLAIM_KEYS.version] ?? null,
    claimedAt: str(metadata[CLAIM_KEYS.claimedAt]),
    claimedBy: str(metadata[CLAIM_KEYS.claimedBy]),
    gmailMessageId: str(metadata[CLAIM_KEYS.gmailMessageId]),
    gmailThreadId: str(metadata[CLAIM_KEYS.gmailThreadId]),
    fromEmail: str(metadata[CLAIM_KEYS.fromEmail]),
    sentAt: str(metadata[CLAIM_KEYS.sentAt]),
  };
}
