// netlify/functions/lib/google-ads-lead-ingestion.ts
//
// Shared Google Ads lead-form-submission -> CRM ingestion pipeline —
// provider-row persistence/dedupe and contact/lead creation. This is the
// ONLY place that logic lives; BOTH the real production sync
// (google-ads-lead-sync.ts) and the dev-only synthetic test harness
// (google-ads-lead-test-inject.ts) call these same functions rather than
// carrying their own copies. Extracted verbatim from
// google-ads-lead-sync.ts (Phase 3, Step 6C.1) — no business-rule change.
//
// Never calls the Google Ads API. Never logs/returns PII beyond safe IDs.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface GoogleAdsSubmissionInsertPayload {
  organization_id: string;
  google_ads_customer_id: string;
  google_submission_id: string;
  google_resource_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  asset_id: string | null;
  ad_group_id: string | null;
  ad_group_ad_id: string | null;
  gclid: string | null;
  submission_date_time: string | null;
  raw_fields: unknown;
  raw_custom_fields: unknown;
  normalized_email: string | null;
  normalized_phone: string | null;
  normalized_first_name: string | null;
  normalized_last_name: string | null;
  normalized_full_name: string | null;
  ingestion_status: "pending";
}

export interface GoogleAdsSubmissionForCrmLinking {
  id: string;
  normalized_email: string | null;
  normalized_phone: string | null;
  normalized_full_name: string | null;
  campaign_name: string | null;
}

// Atomically insert-or-skip, deduped by the DB unique constraint on
// (organization_id, google_ads_customer_id, google_submission_id).
// ignoreDuplicates: true -> INSERT ... ON CONFLICT DO NOTHING under the
// hood; the returned rows are exactly the ones NEWLY inserted this call.
// A conflicting (already-ingested) submission is silently skipped — this
// is the atomic dedupe decision, never a read-then-write check. Works
// identically for a real batch of N Google rows or a single synthetic
// test row.
export async function insertGoogleAdsLeadSubmissions(
  supabaseAdmin: SupabaseClient,
  payloads: GoogleAdsSubmissionInsertPayload[],
): Promise<GoogleAdsSubmissionForCrmLinking[]> {
  if (payloads.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .upsert(payloads, { onConflict: "organization_id,google_ads_customer_id,google_submission_id", ignoreDuplicates: true })
    .select("id, normalized_email, normalized_phone, normalized_full_name, campaign_name");
  if (error) throw error;
  return data ?? [];
}

interface ContactMatch {
  id: string;
  full_name: string | null;
}

// Looks up an existing contact in the SAME organization by normalized
// phone first (matches the existing addLead()/contacts.org_id+phone
// unique-constraint convention already used elsewhere in the app), then
// falls back to email if no phone match. Name alone is never used to
// match — only phone/email, and only within orgId.
async function findMatchingContact(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  normalizedPhone: string | null,
  normalizedEmail: string | null,
): Promise<ContactMatch | null> {
  if (normalizedPhone) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", orgId)
      .eq("phone", normalizedPhone)
      .maybeSingle();
    if (data) return data as ContactMatch;
  }
  if (normalizedEmail) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", orgId)
      .eq("email", normalizedEmail)
      .limit(1)
      .maybeSingle();
    if (data) return data as ContactMatch;
  }
  return null;
}

// A short, factual, non-fabricated note distinguishing one Google Ads
// lead from another for the SAME contact — separate from leads.name
// (Phase 3, CRM Schema Improvement — each lead now carries its own name
// snapshot, see leadName below). Uses ONLY real, already-attributed data
// (the campaign name) — never a fabricated service/project-type guess.
export function buildGoogleAdsLeadNote(campaignName: string | null): string {
  return campaignName ? `Google Ads lead — Campaign: ${campaignName}` : "Google Ads lead";
}

export type GoogleAdsCrmLinkResult =
  | { ok: true; status: "created" | "matched"; contactId: string; leadId: string }
  | { ok: false; reason: string };

// The single per-submission CRM-linking step: match-or-create the
// contact, ALWAYS create a fresh lead for THIS submission (Step 6A — a
// matched contact is reused, but a lead is never reused from an earlier
// submission by the same contact), link the submission row, and update
// ingestion_status. On any failure, marks the row 'failed' (never
// deletes it, never leaves it silently 'pending') and returns ok:false —
// the caller decides how to surface that, but the row-level failure
// handling itself lives here exactly once.
export async function ingestGoogleAdsSubmission(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  submission: GoogleAdsSubmissionForCrmLinking,
): Promise<GoogleAdsCrmLinkResult> {
  try {
    const existingContact = await findMatchingContact(supabaseAdmin, orgId, submission.normalized_phone, submission.normalized_email);
    const leadNote = buildGoogleAdsLeadNote(submission.campaign_name);

    let contactId: string;
    let status: "matched" | "created";
    // Snapshot written onto leads.name below (Phase 3, CRM Schema
    // Improvement) — the matched contact's OWN stored full_name when an
    // existing contact is reused (it may differ from this particular
    // submission's normalized_full_name, e.g. a returning contact who
    // typed their name slightly differently on a second form), otherwise
    // the exact fullName just written to the newly created/upserted
    // contact — never derived from campaign_name.
    let leadName: string | null;

    if (existingContact) {
      contactId = existingContact.id;
      status = "matched";
      leadName = existingContact.full_name;
    } else {
      const fullName = submission.normalized_full_name || "Unknown Google Ads lead";
      leadName = fullName;
      if (submission.normalized_phone) {
        const { data: contact, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .upsert(
            { org_id: orgId, full_name: fullName, phone: submission.normalized_phone, email: submission.normalized_email, source: "google_ads", labels: ["Lead"] },
            { onConflict: "org_id,phone", ignoreDuplicates: false },
          )
          .select("id")
          .single();
        if (contactErr || !contact) throw new Error("contact_upsert_failed");
        contactId = contact.id as string;
      } else {
        const { data: contact, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .insert({ org_id: orgId, full_name: fullName, email: submission.normalized_email, source: "google_ads", labels: ["Lead"] })
          .select("id")
          .single();
        if (contactErr || !contact) throw new Error("contact_insert_failed");
        contactId = contact.id as string;
      }
      status = "created";
    }

    // Always a NEW lead for this submission — one CRM inquiry per Google
    // submission, regardless of whether the contact was matched or just
    // created, and regardless of whether this is a brand-new submission,
    // a recovered failed one, or a dev-injected synthetic one.
    const { data: newLead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .insert({ org_id: orgId, contact_id: contactId, source: "google_ads", status: "new", notes: leadNote, custom_fields: {}, name: leadName })
      .select("id")
      .single();
    if (leadErr || !newLead) throw new Error("lead_insert_failed");
    const leadId = newLead.id;

    // Only contact_id/lead_id/ingestion_status/ingestion_error/updated_at
    // are ever touched here — google_submission_id, gclid, campaign
    // attribution, raw fields, and submission_date_time are never
    // rewritten.
    const { error: linkErr } = await supabaseAdmin
      .from("google_ads_lead_submissions")
      .update({ contact_id: contactId, lead_id: leadId, ingestion_status: status, ingestion_error: null, updated_at: new Date().toISOString() })
      .eq("id", submission.id)
      .eq("organization_id", orgId);
    if (linkErr) throw new Error("submission_link_failed");

    return { ok: true, status, contactId, leadId };
  } catch (e: any) {
    const reason = e?.message ?? "unknown";
    // A failed row stays exactly 'failed' with lead_id/contact_id still
    // null (this update never sets them) — recoverable by the next sync's
    // durable local-retry pass (see google-ads-lead-sync.ts). Never
    // deleted, never marked successful.
    await supabaseAdmin
      .from("google_ads_lead_submissions")
      .update({ ingestion_status: "failed", ingestion_error: "crm_link_failed", updated_at: new Date().toISOString() })
      .eq("id", submission.id)
      .eq("organization_id", orgId);
    return { ok: false, reason };
  }
}
