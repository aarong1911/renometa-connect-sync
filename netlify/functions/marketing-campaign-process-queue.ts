// netlify/functions/marketing-campaign-process-queue.ts
//
// Netlify SCHEDULED function (see netlify.toml — runs every 5 minutes).
// This is the durable batch worker Phase 14.1 requires: bulk campaign
// sending must never happen synchronously inside a normal HTTP request
// (marketing-campaign-send.ts only snapshots+queues; this file is what
// actually dispatches to Twilio/Gmail).
//
// ── Idempotency / ambiguous-provider-window analysis (Phase 14.1 pre-apply
//    hardening review, item 8) ──
//
// Twilio's Messages API and Gmail SMTP give this worker no safe, generic way
// to ask "did my last attempt actually go through?" after the fact:
//   - Twilio has no client-supplied idempotency key — two identical POSTs
//     create two billed messages, full stop.
//   - Gmail SMTP (nodemailer) is a stateless per-submission protocol with
//     no dedup/idempotency concept at all.
// Email campaigns now send from the org's connected Google account through
// the Gmail API when it has one (lib/contractor-email.ts), with legacy SMTP
// kept for orgs that don't. Gmail API sends carry X-RenoMeta-Send-Id =
// recipient id, so an ambiguous Gmail result can be looked up in the
// account's Sent mail — only a match counts as sent; anything else still
// fails closed below.
//
// Given that, the failure window is real: if this function's process dies
// (timeout, crash, cold-start eviction) AFTER a provider call resolves
// successfully but BEFORE the resulting status update commits, a naive
// "reclaim anything not yet terminal" retry would send the SAME recipient
// twice. The fix is a durable, persisted interim state, not an in-memory
// step:
//   1. A recipient is claimed AND moved to 'sending' in ONE update, BEFORE
//      the provider is ever called. This is a committed, visible fact —
//      not something that only exists in this function's memory.
//   2. On a real provider response (success or a clean rejection), the row
//      moves to a terminal state ('sent' or 'failed') immediately.
//   3. A row still sitting in 'sending' after STALE_SENDING_MINUTES is, by
//      definition, ambiguous — this worker cannot know whether the
//      provider call that preceded the crash actually went out. The fix
//      is to FAIL CLOSED: sweep it straight to 'failed' with an explicit
//      "ambiguous outcome, not auto-retried" reason, and never let it be
//      reclaimed as 'queued' again. A human can inspect and manually
//      decide whether to create a fresh send; the worker itself never
//      guesses.
//
// Gmail retries (the only automatic retries, and only when Gmail DEFINITELY
// did not accept the message — a rate-limit/quota refusal or Google being
// unreachable before the send): the row goes back to 'queued' with
// claimed_at set to a future "not before" time (bounded, increasing backoff
// — lib/gmail-campaign-pacing.ts), and is failed terminally after the last
// attempt. Queued rows otherwise have claimed_at = null, so the claim query's
// "claimed_at is null or due" filter changes nothing for SMS or SMTP.
// A Gmail authorization failure (revoked / reconnect needed) pauses the
// whole campaign with every unsent recipient still queued; Resume continues
// it after the owner reconnects.
//
// Recipient uniqueness (unique(campaign_id, contact_id) in the migration)
// still guarantees this worker itself can never create two rows for the
// same recipient — the risk this analysis addresses is strictly the
// single-row double-send window above, not a duplicate-row scenario.
//
// Scheduled functions in this repo have no prior precedent (audit found
// zero background/scheduled functions) — this is new infrastructure,
// intentionally NOT reviving the documented-dead workflow_trigger_queue.
//
// Batch size is deliberately small and bounded per invocation to stay
// well inside Netlify's function execution time limit.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { renderMergeTags, splitFullName } from "../../src/lib/marketing-merge-tags";
import { resolveContractorEmailRoute, type ContractorEmailRoute, type SmtpCredentials } from "./lib/contractor-email";
import {
  findSentGmailMessage,
  GmailSendError,
  isGmailAuthorizationError,
  isValidRecipientEmail,
  sendGmailMessage,
  type FetchLike,
  type GmailSender,
} from "./lib/gmail-send";
import { countCampaignEmailsSentSince, gmailCampaignDailyCap, gmailRetryDelayMs } from "./lib/gmail-campaign-pacing";

const BATCH_SIZE = 20;
const STALE_SENDING_MINUTES = 10; // comfortably longer than one function invocation can run
const WORKER_ID = `process-queue-${Date.now()}`;
const SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:9999";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

const FALLBACK_COMPANY_NAME = "Your Company";

type OrgNames = { name?: string | null; public_name?: string | null } | null | undefined;

// Real send-time merge context — the same {{first_name}}/{{last_name}}/
// {{company_name}} tags the composer's preview supports (see
// src/lib/marketing-merge-tags.ts, shared with src/routes/marketing.tsx's
// MessagePreview so preview and real sends can never diverge), but built
// from the ACTUAL recipient and org, never sample data:
//   - first_name/last_name: split from the recipient snapshot's
//     contact_name (campaign_recipients.contact_name, captured at
//     enqueue time in marketing-campaign-send.ts from contacts.full_name).
//   - company_name: the sending organization's own display name
//     (organizations.name, falling back to public_name — same precedence
//     src/lib/organization.ts's useOrganization() uses elsewhere in the
//     app), never a hardcoded/demo business name.
function buildRecipientMergeContext(recipientName: string | null, org: OrgNames) {
  const { firstName, lastName } = splitFullName(recipientName);
  const companyName = org?.name?.trim() || org?.public_name?.trim() || FALLBACK_COMPANY_NAME;
  return { first_name: firstName, last_name: lastName, company_name: companyName };
}

async function sendSms(orgId: string, to: string, body: string, recipientName: string | null): Promise<{ providerMessageId: string | null }> {
  const { data: org } = await supabaseAdmin.from("organizations").select("integration_settings, name, public_name").eq("id", orgId).maybeSingle();
  const twilio = org?.integration_settings?.twilio;
  if (!twilio?.accountSid || !twilio?.authToken || !twilio?.phoneNumber) {
    throw new Error("Twilio not configured");
  }
  const renderedBody = renderMergeTags(body, buildRecipientMergeContext(recipientName, org));
  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: toE164(twilio.phoneNumber), To: toE164(to), Body: renderedBody }).toString(),
  });
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `Twilio error ${res.status}`);
  }
  const result: any = await res.json().catch(() => ({}));
  return { providerMessageId: result?.sid ?? null };
}

// Mints a cryptographically-random, opaque unsubscribe token and returns
// the public unsubscribe URL to append to an outbound campaign email.
// crypto.randomBytes is a CSPRNG (Node's binding to the OS entropy
// source) — never Math.random() or a predictable value.
async function mintUnsubscribeUrl(orgId: string, contactId: string, campaignId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const { error } = await supabaseAdmin
    .from("marketing_unsubscribe_tokens")
    .insert({ org_id: orgId, contact_id: contactId, channel: "email", token, campaign_id: campaignId });
  if (error) throw new Error(`Failed to mint unsubscribe token: ${error.message}`);
  return `${SITE_URL}/.netlify/functions/marketing-unsubscribe?token=${token}`;
}

type EmailContent = { subject: string; body: string; unsubscribeUrl: string; companyName: string | null };

async function buildEmailContent(
  orgId: string, contactId: string, campaignId: string, subject: string, body: string, recipientName: string | null, org: OrgNames,
): Promise<EmailContent> {
  const mergeContext = buildRecipientMergeContext(recipientName, org);
  const unsubscribeUrl = await mintUnsubscribeUrl(orgId, contactId, campaignId);
  return {
    subject: renderMergeTags(subject, mergeContext),
    body: `${renderMergeTags(body, mergeContext)}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`,
    unsubscribeUrl,
    companyName: org?.name?.trim() || org?.public_name?.trim() || null,
  };
}

async function sendSmtpEmail(smtp: SmtpCredentials, to: string, content: EmailContent): Promise<{ providerMessageId: string | null }> {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: smtp.email, pass: smtp.password },
  });
  const sendResult = await transporter.sendMail({
    from: `${smtp.senderName ?? "RenoMeta Connect"} <${smtp.email}>`,
    to,
    subject: content.subject,
    text: content.body,
  });
  return { providerMessageId: sendResult?.messageId ?? null };
}

/** What happened to one Gmail campaign send. Only "sent" means Gmail has the message. */
export type GmailCampaignOutcome =
  | { kind: "sent"; providerMessageId: string }
  /** Gmail definitely refused it (bad address, rejected content): terminal for this recipient. */
  | { kind: "failed"; reason: string }
  /** Gmail may have accepted it and it wasn't found in Sent mail: terminal, never retried. */
  | { kind: "ambiguous"; reason: string }
  /** Rate limit / quota / Google unreachable — nothing was sent; retry later. */
  | { kind: "retry_later"; reason: string; retryAfterSeconds: number | null }
  /** The Google connection can't send (revoked, reconnect needed) — nothing was sent; pause the campaign. */
  | { kind: "pause_campaign"; reason: string };

export async function sendCampaignEmailViaGmail(
  sender: GmailSender,
  input: { recipientId: string; to: string; content: EmailContent },
  fetchImpl: FetchLike = fetch,
): Promise<GmailCampaignOutcome> {
  if (!isValidRecipientEmail(input.to)) return { kind: "failed", reason: "Invalid email address — not sent" };
  const claimedAt = new Date();
  try {
    const sent = await sendGmailMessage(sender, {
      fromName: input.content.companyName,
      fromEmail: sender.accountEmail,
      to: input.to,
      subject: input.content.subject,
      text: input.content.body,
      // The recipient row id: one per recipient, reused across retries
      // (which only follow a definite refusal), so Sent-mail lookup is exact.
      sendId: input.recipientId,
      // RFC 8058 one-click unsubscribe — marketing-unsubscribe.ts accepts a
      // POST carrying the token in the URL.
      extraHeaders: {
        "List-Unsubscribe": `<${input.content.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }, fetchImpl);
    return { kind: "sent", providerMessageId: sent.gmailMessageId };
  } catch (err) {
    if (!(err instanceof GmailSendError)) throw err;
    if (err.maybeSent) {
      const lookup = await findSentGmailMessage(sender, { sendId: input.recipientId, claimedAt }, fetchImpl);
      if (lookup.status === "found") return { kind: "sent", providerMessageId: lookup.gmailMessageId };
      return { kind: "ambiguous", reason: "Ambiguous outcome — Gmail did not confirm this send and it wasn't found in Sent mail; not auto-retried, verify manually before resending" };
    }
    if (isGmailAuthorizationError(err)) return { kind: "pause_campaign", reason: err.message };
    if (err.code === "email_rate_limited" || err.code === "email_provider_unavailable") {
      return { kind: "retry_later", reason: err.message, retryAfterSeconds: err.retryAfterSeconds };
    }
    return { kind: "failed", reason: err.message };
  }
}

/**
 * Unsubscribed/suppressed since the campaign was queued -> never sent. A
 * failed preference read throws, so the recipient is failed (not emailed)
 * rather than sent without the check.
 */
async function emailSuppressionReason(orgId: string, contactId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("marketing_contact_preferences")
    .select("email_unsubscribed, email_suppressed")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error) throw new Error(`preference check failed: ${error.message}`);
  if (data?.email_unsubscribed) return "Unsubscribed before this email was sent";
  if (data?.email_suppressed) return "Suppressed before this email was sent";
  return null;
}

/** Put claimed-but-unsent recipients back in the queue, not before `notBefore`. Never touches attempt_count. */
async function releaseRecipients(ids: string[], notBefore: Date | null, reason: string | null): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin
    .from("campaign_recipients")
    .update({
      status: "queued",
      claimed_by: null,
      claimed_at: notBefore ? notBefore.toISOString() : null,
      ...(reason ? { failure_reason: reason } : {}),
    })
    .in("id", ids)
    .eq("status", "sending");
}

async function pauseCampaign(campaignId: string, fromStatus: string): Promise<void> {
  await supabaseAdmin
    .from("campaigns")
    .update({ status: "paused", paused_at: new Date().toISOString(), paused_from_status: fromStatus })
    .eq("id", campaignId)
    .eq("status", fromStatus);
}

export const handler: Handler = async () => {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_SENDING_MINUTES * 60_000).toISOString();

  // 0. Sweep stale 'sending' rows FIRST, before claiming any new work —
  // an ambiguous prior attempt is resolved (fail closed) before this
  // invocation might otherwise re-claim the same campaign's other
  // recipients and get confused about totals.
  const { data: staleSending } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id")
    .eq("status", "sending")
    .lt("claimed_at", staleThreshold);
  if (staleSending && staleSending.length > 0) {
    await supabaseAdmin
      .from("campaign_recipients")
      .update({
        status: "failed",
        failed_at: now.toISOString(),
        failure_reason: "Ambiguous outcome — worker did not confirm result before timing out; not auto-retried, verify manually before resending",
      })
      .in("id", staleSending.map((r) => r.id));
  }

  // 1. Promote due scheduled campaigns to queued.
  await supabaseAdmin
    .from("campaigns")
    .update({ status: "queued" })
    .eq("status", "scheduled")
    .lte("scheduled_at", now.toISOString());

  // 2. Find campaigns with claimable work (queued or already-sending).
  const { data: activeCampaigns } = await supabaseAdmin
    .from("campaigns")
    .select("id, org_id, campaign_type, subject, content, status")
    .in("status", ["queued", "sending"]);

  if (!activeCampaigns || activeCampaigns.length === 0) {
    return { statusCode: 200 };
  }

  // Per-invocation caches: one provider resolution (and Gmail token
  // preflight) per org, and each Gmail org's remaining daily allowance.
  const routes = new Map<string, Promise<ContractorEmailRoute | GmailSendError>>();
  const routeFor = (orgId: string) => {
    let pending = routes.get(orgId);
    if (!pending) {
      pending = resolveContractorEmailRoute(supabaseAdmin, orgId).catch((err) => {
        if (err instanceof GmailSendError) return err;
        throw err;
      });
      routes.set(orgId, pending);
    }
    return pending;
  };
  const gmailAllowance = new Map<string, number>();
  const orgNames = new Map<string, OrgNames>();

  let processed = 0;

  for (const campaign of activeCampaigns) {
    if (processed >= BATCH_SIZE) break;

    // Email: decide the provider BEFORE claiming anything, so a broken or
    // missing connection never moves recipients into 'sending'.
    let route: ContractorEmailRoute | null = null;
    let claimLimit = BATCH_SIZE - processed;
    if (campaign.campaign_type !== "sms") {
      const resolvedRoute = await routeFor(campaign.org_id);
      if (resolvedRoute instanceof GmailSendError) {
        if (isGmailAuthorizationError(resolvedRoute)) {
          // No usable account at all (no SMTP to fall back to): pause rather
          // than fail every recipient. Resume after reconnecting.
          if (campaign.status === "queued" || campaign.status === "sending") await pauseCampaign(campaign.id, campaign.status);
          console.warn("[process-queue] email campaign paused — no usable email account", { campaignId: campaign.id, code: resolvedRoute.code });
        }
        continue; // transient (Google/DB unavailable): try again next run
      }
      route = resolvedRoute;
      if (route.provider === "gmail_api") {
        if (!gmailAllowance.has(campaign.org_id)) {
          const sentToday = await countCampaignEmailsSentSince(supabaseAdmin, campaign.org_id, new Date(now.getTime() - 24 * 3600_000));
          gmailAllowance.set(campaign.org_id, Math.max(0, gmailCampaignDailyCap() - sentToday));
        }
        claimLimit = Math.min(claimLimit, gmailAllowance.get(campaign.org_id)!);
        if (claimLimit <= 0) continue; // daily allowance used — the rest waits, nothing fails
      }
    }

    // Claim a bounded slice of this campaign's still-queued recipients.
    // Deliberately only 'queued' rows — a 'sending' row is either being
    // worked right now or was already swept to 'failed' above; it is
    // NEVER reclaimed here. A queued row with a future claimed_at is a
    // Gmail retry still in backoff.
    const { data: claimable } = await supabaseAdmin
      .from("campaign_recipients")
      .select("id, contact_id, destination, contact_name, attempt_count")
      .eq("campaign_id", campaign.id)
      .eq("status", "queued")
      .or(`claimed_at.is.null,claimed_at.lte.${now.toISOString()}`)
      .order("created_at", { ascending: true })
      .limit(claimLimit);

    if (!claimable || claimable.length === 0) {
      // No more queued work for this campaign — if it was still marked
      // 'sending'/'queued', finalize it now (only once every recipient is
      // in a terminal state — a recipient still in flight elsewhere, or
      // queued for a Gmail retry, means this campaign is not actually done yet).
      if (!(await hasInFlightRecipients(campaign.id))) {
        await finalizeCampaign(campaign.id);
      }
      continue;
    }

    // Race guard against Pause (marketing-campaign-pause.ts): `campaign`
    // here is a snapshot read at step 2, potentially several claim-loop
    // iterations ago for earlier campaigns in this same invocation. If a
    // user paused this exact campaign in the meantime, campaign.status in
    // this in-memory snapshot is stale. Re-check the durable row right
    // before claiming so a pause that lands between step 2's snapshot and
    // this point stops new recipients from being claimed — the strongest
    // guarantee reasonably achievable without re-checking before every
    // single recipient inside an already-claimed batch (once a batch IS
    // claimed, those recipients are committed to 'sending' and are
    // allowed to reach their terminal outcome, same as the existing
    // stale-sending design — pause never resets/requeues an in-flight
    // attempt).
    const { data: statusCheck } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", campaign.id)
      .maybeSingle();
    if (!statusCheck || (statusCheck.status !== "queued" && statusCheck.status !== "sending")) {
      continue; // paused (or canceled/otherwise moved on) since the snapshot — claim nothing new
    }

    if (statusCheck.status === "queued") {
      await supabaseAdmin.from("campaigns").update({ status: "sending", started_at: now.toISOString() }).eq("id", campaign.id);
    }

    // Claim AND move to 'sending' in the SAME update — this is the durable
    // "attempt in flight" commit the ambiguous-window analysis above
    // depends on. It happens before any provider call.
    const claimIds = claimable.map((r) => r.id);
    await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "sending", claimed_by: WORKER_ID, claimed_at: now.toISOString() })
      .in("id", claimIds);

    if (route && !orgNames.has(campaign.org_id)) {
      const { data: org } = await supabaseAdmin.from("organizations").select("name, public_name").eq("id", campaign.org_id).maybeSingle();
      orgNames.set(campaign.org_id, org);
    }

    for (let index = 0; index < claimable.length; index += 1) {
      const recipient = claimable[index];
      processed += 1;
      const newAttemptCount = (recipient.attempt_count ?? 0) + 1;
      const markFailed = (reason: string, attemptCount = newAttemptCount) =>
        supabaseAdmin
          .from("campaign_recipients")
          .update({ status: "failed", failed_at: new Date().toISOString(), failure_reason: reason.slice(0, 500), attempt_count: attemptCount })
          .eq("id", recipient.id);
      const markSent = (providerMessageId: string | null) =>
        supabaseAdmin
          .from("campaign_recipients")
          .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerMessageId, attempt_count: newAttemptCount })
          .eq("id", recipient.id);

      try {
        if (campaign.campaign_type === "sms") {
          const result = await sendSms(campaign.org_id, recipient.destination, campaign.content, recipient.contact_name);
          await markSent(result.providerMessageId);
          continue;
        }

        // Unsubscribe/suppression is enforced again at send time: a contact
        // who opted out after the campaign was queued is never emailed.
        const suppressed = await emailSuppressionReason(campaign.org_id, recipient.contact_id);
        if (suppressed) {
          await supabaseAdmin
            .from("campaign_recipients")
            .update({ status: "excluded", excluded_reason: suppressed })
            .eq("id", recipient.id);
          continue;
        }

        const content = await buildEmailContent(
          campaign.org_id, recipient.contact_id, campaign.id, campaign.subject ?? "", campaign.content, recipient.contact_name, orgNames.get(campaign.org_id),
        );

        if (route!.provider === "smtp") {
          const result = await sendSmtpEmail(route!.smtp, recipient.destination, content);
          await markSent(result.providerMessageId);
          continue;
        }

        const outcome = await sendCampaignEmailViaGmail(route!.sender, { recipientId: recipient.id, to: recipient.destination, content });
        if (outcome.kind === "sent") {
          gmailAllowance.set(campaign.org_id, (gmailAllowance.get(campaign.org_id) ?? 1) - 1);
          await markSent(outcome.providerMessageId);
          continue;
        }
        if (outcome.kind === "failed" || outcome.kind === "ambiguous") {
          await markFailed(outcome.reason);
          continue;
        }

        // retry_later / pause_campaign: nothing was sent to this recipient or
        // anyone after it in this batch. Requeue them all and stop the batch
        // — and this org's other campaigns for the rest of this run.
        gmailAllowance.set(campaign.org_id, 0);
        const rest = claimable.slice(index + 1).map((r) => r.id);
        if (outcome.kind === "pause_campaign") {
          await releaseRecipients([recipient.id, ...rest], null, null);
          await pauseCampaign(campaign.id, "sending");
          console.warn("[process-queue] email campaign paused — Google connection needs attention", { campaignId: campaign.id });
          break;
        }
        const delayMs = gmailRetryDelayMs(newAttemptCount, outcome.retryAfterSeconds);
        const notBefore = new Date(Date.now() + (delayMs ?? 5 * 60_000));
        if (delayMs === null) {
          await markFailed(`${outcome.reason} Gave up after ${newAttemptCount} attempts — not sent.`);
        } else {
          await supabaseAdmin
            .from("campaign_recipients")
            .update({ status: "queued", claimed_by: null, claimed_at: notBefore.toISOString(), attempt_count: newAttemptCount, failure_reason: `Retrying: ${outcome.reason}`.slice(0, 500) })
            .eq("id", recipient.id)
            .eq("status", "sending");
        }
        await releaseRecipients(rest, notBefore, null);
        break;
      } catch (err: any) {
        // A provider call that threw is treated as a CLEAN failure (the
        // provider rejected it, or the request never left this process) —
        // not ambiguous, so it is safe to mark 'failed' immediately rather
        // than leaving it in 'sending' for the stale sweep. The stale
        // sweep exists specifically for the case this catch block never
        // runs at all (process killed mid-flight). Gmail API sends never
        // reach here with an ambiguous result — sendCampaignEmailViaGmail
        // returns those as outcomes.
        await markFailed(String(err.message ?? err));
      }
    }

    // Reconciliation fix: without this, a campaign whose entire batch fit
    // in a single invocation (the common case for a small audience) would
    // never finalize within THIS run — the zero-claimable branch above is
    // the only other place finalizeCampaign() is called, and it only
    // fires on a LATER invocation that re-picks up the same campaign and
    // finds nothing left to claim. If no later invocation ever happens
    // (e.g. this function is only triggered manually in this environment,
    // or the next scheduled run is still minutes away), the campaign is
    // left stuck at status='sending' with recipients_sent still 0 forever
    // — exactly the bug this comment fixes. Checking again right here,
    // immediately after the batch this same invocation just processed,
    // closes that gap without weakening anything: it only ever finalizes
    // a campaign that genuinely has zero recipients left in
    // pending/queued/sending, the identical condition the other call site
    // already required.
    if (!(await hasInFlightRecipients(campaign.id))) {
      await finalizeCampaign(campaign.id);
    }
  }

  return { statusCode: 200 };
};

// Shared by both finalization call sites — a campaign is only ever
// finalized once it genuinely has no recipients left in an active state.
async function hasInFlightRecipients(campaignId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "queued", "sending"]);
  return !!count && count > 0;
}

async function finalizeCampaign(campaignId: string): Promise<void> {
  // 'delivered' is a strictly later state than 'sent' (a delivered
  // message was, by definition, already sent) — counting only 'sent'
  // would under-report recipients_sent the moment a delivery-status
  // webhook (not implemented yet) starts advancing rows past 'sent'.
  // Counting both here now avoids that regression later without needing
  // to touch this function again when that webhook is added.
  const { count: sentCount } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("status", ["sent", "delivered"]);
  const { count: deliveredCount } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "delivered");
  const { count: failedCount } = await supabaseAdmin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "failed");

  await supabaseAdmin
    .from("campaigns")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      recipients_sent: sentCount ?? 0,
      // Never fabricated from a successful send alone — only a real
      // 'delivered' row (which nothing in this codebase sets yet; there
      // is no Twilio/Gmail delivery-status webhook) ever counts here.
      recipients_delivered: deliveredCount ?? 0,
      recipients_failed: failedCount ?? 0,
    })
    .eq("id", campaignId)
    .in("status", ["queued", "sending"]); // never overwrite an already-terminal row
}
