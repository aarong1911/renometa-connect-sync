// netlify/functions/lib/gmail-campaign-pacing.ts
//
// Keeps email campaigns sent through a contractor's own Gmail account
// (marketing-campaign-process-queue.ts) inside Gmail's limits.
//
// Gmail is a personal/business mailbox, not a bulk-mail service. Google's
// published sending limits are roughly 500 recipients per rolling 24 hours
// for a consumer @gmail.com account and 2,000 for a Google Workspace user
// (lower during a Workspace trial), shared with everything else that
// mailbox sends — Conversations replies, estimates, the contractor's own
// mail. Exceeding them gets the account temporarily blocked from sending
// (and repeated bulk mail to people who didn't ask for it risks suspension).
// The Gmail API itself also rate-limits per user (users.messages.send costs
// 100 of a 250-units-per-second per-user quota).
//
// So, for Gmail-routed campaigns:
//   - a per-org cap on campaign emails per rolling 24h, deliberately below
//     the consumer limit to leave room for the contractor's normal mail
//     (GMAIL_CAMPAIGN_DAILY_CAP, default 400); remaining recipients simply
//     wait for a later worker run — they are never failed for this;
//   - a Gmail rate-limit / transient-outage response puts the recipient back
//     in the queue with bounded, increasing backoff (nothing was sent), and
//     fails it terminally after GMAIL_MAX_ATTEMPTS.
//
// Legacy SMTP campaigns are unchanged and not paced here.

import type { SupabaseClient } from "@supabase/supabase-js";

export const GMAIL_CAMPAIGN_DAILY_CAP_DEFAULT = 400;

export function gmailCampaignDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.GMAIL_CAMPAIGN_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : GMAIL_CAMPAIGN_DAILY_CAP_DEFAULT;
}

/** Minutes to wait after the 1st, 2nd, 3rd, 4th retryable failure. */
export const GMAIL_RETRY_DELAYS_MIN = [5, 30, 120, 360] as const;
/** The attempt after the last delay is the final one. */
export const GMAIL_MAX_ATTEMPTS = GMAIL_RETRY_DELAYS_MIN.length + 1;

/**
 * Delay before retrying a recipient whose `attemptCount`-th attempt was
 * refused for a retryable reason, or null when it has used every attempt.
 * Google's Retry-After wins when it asks for longer.
 */
export function gmailRetryDelayMs(attemptCount: number, retryAfterSeconds: number | null): number | null {
  if (attemptCount >= GMAIL_MAX_ATTEMPTS) return null;
  const scheduled = GMAIL_RETRY_DELAYS_MIN[Math.max(0, attemptCount - 1)] * 60_000;
  return Math.max(scheduled, (retryAfterSeconds ?? 0) * 1000);
}

/**
 * Campaign emails this org sent (any provider — conservative) in the last
 * 24 hours. Org-scoped on both queries.
 */
export async function countCampaignEmailsSentSince(admin: SupabaseClient, orgId: string, since: Date): Promise<number> {
  const { data: emailCampaigns, error } = await admin
    .from("campaigns")
    .select("id")
    .eq("org_id", orgId)
    .eq("campaign_type", "email");
  if (error) throw new Error(`campaign lookup failed: ${error.message}`);
  const ids = (emailCampaigns ?? []).map((c: { id: string }) => c.id);
  if (ids.length === 0) return 0;
  const { count, error: countErr } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("campaign_id", ids)
    .in("status", ["sent", "delivered"])
    .gte("sent_at", since.toISOString());
  if (countErr) throw new Error(`sent count failed: ${countErr.message}`);
  return count ?? 0;
}

/** Shown when queuing a Gmail campaign larger than one day's allowance. */
export function largeGmailCampaignNotice(recipients: number, dailyCap: number): string | null {
  if (recipients <= dailyCap) return null;
  const days = Math.ceil(recipients / dailyCap);
  return `Gmail limits how much one account can send, so RenoMeta sends at most ${dailyCap} campaign emails a day from your Gmail. This campaign will take about ${days} days to finish.`;
}
