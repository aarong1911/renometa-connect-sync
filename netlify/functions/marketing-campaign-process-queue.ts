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
// Neither provider this app uses gives this worker a safe, generic way to
// ask "did my last attempt actually go through?" after the fact:
//   - Twilio's Messages API has no client-supplied idempotency key — two
//     identical POSTs create two billed messages, full stop.
//   - Gmail SMTP (nodemailer) is a stateless per-submission protocol with
//     no dedup/idempotency concept at all. (This app's Campaigns email path
//     uses org-level Gmail SMTP, the same as send-inbox-message.ts — NOT
//     Amazon SES, which estimate-send.ts/change-order-send.ts use
//     elsewhere in this repo. Nothing here invents SES idempotency that
//     doesn't exist, because SES isn't in this path to begin with.)
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
import { getOrgSecret } from "./lib/org-secret-store";
import { renderMergeTags, splitFullName } from "../../src/lib/marketing-merge-tags";

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
function buildRecipientMergeContext(recipientName: string | null, org: { name?: string | null; public_name?: string | null } | null | undefined) {
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

async function sendEmail(orgId: string, contactId: string, campaignId: string, to: string, subject: string, body: string, recipientName: string | null): Promise<{ providerMessageId: string | null }> {
  const { data: org } = await supabaseAdmin.from("organizations").select("integration_settings, name, public_name").eq("id", orgId).maybeSingle();
  const gmail = org?.integration_settings?.gmail;
  if (!gmail?.email) throw new Error("Gmail not configured");

  let smtpPassPlain = await getOrgSecret(supabaseAdmin, orgId, "gmail", "smtp_app_password");
  if (!smtpPassPlain && gmail.appPassword) smtpPassPlain = String(gmail.appPassword);
  if (!smtpPassPlain) throw new Error("Gmail not configured");

  const mergeContext = buildRecipientMergeContext(recipientName, org);
  const renderedSubject = renderMergeTags(subject, mergeContext);
  const renderedBody = renderMergeTags(body, mergeContext);

  const unsubscribeUrl = await mintUnsubscribeUrl(orgId, contactId, campaignId);
  const bodyWithFooter = `${renderedBody}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmail.email.trim(), pass: smtpPassPlain.replace(/\s+/g, "") },
  });
  const sendResult = await transporter.sendMail({
    from: `${gmail.senderName ?? "RenoMeta Connect"} <${gmail.email.trim()}>`,
    to,
    subject: renderedSubject,
    text: bodyWithFooter,
  });
  return { providerMessageId: sendResult?.messageId ?? null };
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

  let processed = 0;

  for (const campaign of activeCampaigns) {
    if (processed >= BATCH_SIZE) break;

    // Claim a bounded slice of this campaign's still-queued recipients.
    // Deliberately only 'queued' rows — a 'sending' row is either being
    // worked right now or was already swept to 'failed' above; it is
    // NEVER reclaimed here.
    const { data: claimable } = await supabaseAdmin
      .from("campaign_recipients")
      .select("id, contact_id, destination, contact_name, attempt_count")
      .eq("campaign_id", campaign.id)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE - processed);

    if (!claimable || claimable.length === 0) {
      // No more queued work for this campaign — if it was still marked
      // 'sending'/'queued', finalize it now (only once every recipient is
      // in a terminal state — a recipient still in flight elsewhere means
      // this campaign is not actually done yet).
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

    for (const recipient of claimable) {
      processed += 1;
      const newAttemptCount = (recipient.attempt_count ?? 0) + 1;
      try {
        const result = campaign.campaign_type === "sms"
          ? await sendSms(campaign.org_id, recipient.destination, campaign.content, recipient.contact_name)
          : await sendEmail(campaign.org_id, recipient.contact_id, campaign.id, recipient.destination, campaign.subject ?? "", campaign.content, recipient.contact_name);

        await supabaseAdmin
          .from("campaign_recipients")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            provider_message_id: result.providerMessageId,
            attempt_count: newAttemptCount,
          })
          .eq("id", recipient.id);
      } catch (err: any) {
        // A provider call that threw is treated as a CLEAN failure (the
        // provider rejected it, or the request never left this process) —
        // not ambiguous, so it is safe to mark 'failed' immediately rather
        // than leaving it in 'sending' for the stale sweep. The stale
        // sweep exists specifically for the case this catch block never
        // runs at all (process killed mid-flight).
        await supabaseAdmin
          .from("campaign_recipients")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: String(err.message ?? err).slice(0, 500),
            attempt_count: newAttemptCount,
          })
          .eq("id", recipient.id);
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
