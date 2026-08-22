// netlify/functions/lib/google-ads-conversion-events.ts
//
// Phase 3, Step 7A: local Google Ads conversion-event recording — resolves
// Google Ads attribution (submission, gclid, campaign, contact) for a
// given CRM lead EXACTLY (never "the contact's latest submission" — see
// Part 3 of the task), determines export eligibility, and idempotently
// records/queues a google_ads_conversion_events row. This is the ONLY
// place this logic lives; the trusted endpoint
// (google-ads-conversion-event-create.ts) and any future automated hook
// both call recordGoogleAdsConversionEvent() rather than reimplementing
// attribution resolution.
//
// Makes NO Google Ads API call. Never uploads anything to Google. Never
// accepts a gclid or google_ads_customer_id directly from a caller — both
// are always resolved server-side from google_ads_lead_submissions.
//
// Phase 3, Step 7A.1: also exports resolveGoogleAdsConversionMilestone() —
// the CRM-side counterpart to recordGoogleAdsConversionEvent()'s Google
// attribution resolution. Where recordGoogleAdsConversionEvent() proves
// "which Google submission does this lead belong to", this proves "did
// this CRM milestone actually happen" (leads.status === 'qualified' /
// a real linked appointment / deals.status === 'won'). The production
// endpoint (google-ads-conversion-event-create.ts) calls this FIRST and
// only calls recordGoogleAdsConversionEvent() if it returns valid:true —
// this is the ONLY place CRM milestone validation lives, so the endpoint
// never re-derives it.
//
// Schema note (audited directly from src/lib/leads-store.ts,
// src/lib/appointments-store.ts, src/lib/deals-store.ts — not assumed):
// leads/contacts/appointments/deals all use org_id, but
// google_ads_lead_submissions/google_ads_conversion_events use
// organization_id. Both are populated from the SAME resolved orgId value
// (see resolveOrgFromBearerToken) — just different column names on
// different tables. Every query below uses the column name that matches
// the table being queried.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSyntheticTestGoogleAdsSubmission } from "./google-ads-lead-fields";

export type GoogleAdsConversionEventType = "qualified_lead" | "appointment_booked" | "deal_won";

const VALID_EVENT_TYPES: GoogleAdsConversionEventType[] = ["qualified_lead", "appointment_booked", "deal_won"];

export function isValidGoogleAdsConversionEventType(value: unknown): value is GoogleAdsConversionEventType {
  return typeof value === "string" && (VALID_EVENT_TYPES as string[]).includes(value);
}

export type GoogleAdsConversionExportStatus = "pending" | "ready" | "exported" | "failed" | "ineligible";

export interface RecordGoogleAdsConversionEventInput {
  organizationId: string;
  leadId: string;
  eventType: GoogleAdsConversionEventType;
  eventAt: string; // ISO 8601 — validated by the caller (trusted endpoint) before this is invoked
  dealId?: string | null;
  appointmentId?: string | null;
  conversionValue?: number | null;
  currencyCode?: string | null;
}

export interface GoogleAdsConversionEventRecord {
  id: string;
  eventType: GoogleAdsConversionEventType;
  exportStatus: GoogleAdsConversionExportStatus;
  googleAdsLeadSubmissionId: string;
  gclid: string | null;
}

export type RecordGoogleAdsConversionEventResult =
  | { ok: true; created: boolean; event: GoogleAdsConversionEventRecord }
  | { ok: false; reason: "no_provider_attribution" | "lookup_failed" | "insert_failed" };

interface ProviderSubmissionRow {
  id: string;
  contact_id: string | null;
  google_ads_customer_id: string;
  gclid: string | null;
  raw_fields: unknown;
}

interface MappingRow {
  conversion_action_id: string;
}

// Determines pending vs. ready vs. ineligible (Part 8):
// - a synthetic dev-fixture submission (marked via raw_fields —
//   Step 6C.1) is ALWAYS ineligible, regardless of anything else. This is
//   the one hard rule this function enforces unconditionally — a
//   synthetic gclid must never become exportable.
// - a real submission with a configured, enabled conversion-action
//   mapping for this event_type is 'ready'.
// - a real submission with no mapping yet is 'pending' (has real
//   attribution, just not yet wired to a Google conversion action).
function computeExportStatus(isSynthetic: boolean, hasMapping: boolean): GoogleAdsConversionExportStatus {
  if (isSynthetic) return "ineligible";
  return hasMapping ? "ready" : "pending";
}

export async function recordGoogleAdsConversionEvent(
  supabaseAdmin: SupabaseClient,
  input: RecordGoogleAdsConversionEventInput,
): Promise<RecordGoogleAdsConversionEventResult> {
  // Part 3 — resolve attribution from the EXACT provider submission linked
  // to THIS lead_id. Never queries by contact_id or "most recent for this
  // contact" — google_ads_lead_submissions.lead_id is set once per
  // submission (Step 6A: one lead is always created fresh per submission),
  // so this is a 1:1 lookup, not a "pick the latest" heuristic.
  const { data: submission, error: subErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("id, contact_id, google_ads_customer_id, gclid, raw_fields")
    .eq("organization_id", input.organizationId)
    .eq("lead_id", input.leadId)
    .maybeSingle();

  if (subErr) return { ok: false, reason: "lookup_failed" };
  if (!submission) return { ok: false, reason: "no_provider_attribution" };
  const sub = submission as ProviderSubmissionRow;

  const isSynthetic = isSyntheticTestGoogleAdsSubmission(sub.raw_fields);

  let hasMapping = false;
  if (!isSynthetic) {
    const { data: mapping } = await supabaseAdmin
      .from("google_ads_conversion_mappings")
      .select("conversion_action_id")
      .eq("organization_id", input.organizationId)
      .eq("google_ads_customer_id", sub.google_ads_customer_id)
      .eq("event_type", input.eventType)
      .eq("enabled", true)
      .maybeSingle();
    hasMapping = !!(mapping as MappingRow | null);
  }

  const exportStatus = computeExportStatus(isSynthetic, hasMapping);

  const payload = {
    organization_id: input.organizationId,
    google_ads_customer_id: sub.google_ads_customer_id,
    google_ads_lead_submission_id: sub.id,
    lead_id: input.leadId,
    contact_id: sub.contact_id,
    deal_id: input.dealId ?? null,
    appointment_id: input.appointmentId ?? null,
    event_type: input.eventType,
    event_at: input.eventAt,
    gclid: sub.gclid,
    conversion_value: input.conversionValue ?? null,
    currency_code: input.currencyCode ?? null,
    export_status: exportStatus,
  };

  // Part 5/17 — atomic idempotent insert, deduped by the DB unique
  // constraint on (organization_id, google_ads_lead_submission_id,
  // event_type). ignoreDuplicates: true -> INSERT ... ON CONFLICT DO
  // NOTHING; an empty return means this exact milestone already has an
  // event for this submission — never a second row, never a read-then-write
  // race.
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("google_ads_conversion_events")
    .upsert(payload, { onConflict: "organization_id,google_ads_lead_submission_id,event_type", ignoreDuplicates: true })
    .select("id, event_type, export_status, google_ads_lead_submission_id, gclid");

  if (insertErr) return { ok: false, reason: "insert_failed" };

  if (inserted.length > 0) {
    const row = inserted[0];
    return {
      ok: true,
      created: true,
      event: {
        id: row.id,
        eventType: row.event_type,
        exportStatus: row.export_status,
        googleAdsLeadSubmissionId: row.google_ads_lead_submission_id,
        gclid: row.gclid,
      },
    };
  }

  // Duplicate — fetch the existing row so the caller still gets a
  // meaningful, idempotent result (Part 17: "Second attempt should be
  // idempotent/no-op or return already exists").
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("google_ads_conversion_events")
    .select("id, event_type, export_status, google_ads_lead_submission_id, gclid")
    .eq("organization_id", input.organizationId)
    .eq("google_ads_lead_submission_id", sub.id)
    .eq("event_type", input.eventType)
    .maybeSingle();

  if (existingErr || !existing) return { ok: false, reason: "insert_failed" };

  return {
    ok: true,
    created: false,
    event: {
      id: existing.id,
      eventType: existing.event_type,
      exportStatus: existing.export_status,
      googleAdsLeadSubmissionId: existing.google_ads_lead_submission_id,
      gclid: existing.gclid,
    },
  };
}

// ── CRM milestone validation (Phase 3, Step 7A.1) ────────────────────────
//
// Proves a conversion-worthy CRM milestone actually happened before a
// production conversion event is ever created. Never trusts a
// browser-supplied eventAt, dealId-implies-won, or conversionValue — every
// field in a `valid: true` result is derived from the database row(s)
// this function itself loaded, using the org-scoped leadId (and, for
// appointment_booked/deal_won, an org+lead-scoped appointmentId/dealId)
// as the only caller-supplied identifiers.

export type GoogleAdsConversionMilestoneRejectionReason =
  | "lead_not_found"
  | "lead_not_qualified"
  | "appointment_not_found"
  | "appointment_lead_mismatch"
  | "deal_not_found"
  | "deal_not_won"
  | "deal_lead_mismatch";

export interface ResolveGoogleAdsConversionMilestoneInput {
  organizationId: string;
  leadId: string;
  eventType: GoogleAdsConversionEventType;
  // Required for appointment_booked / deal_won respectively — ignored for
  // qualified_lead. Never used as a substitute for the leadId ownership
  // check; both the lead and the related entity must independently belong
  // to organizationId, and the related entity must link back to leadId.
  appointmentId?: string | null;
  dealId?: string | null;
}

export interface GoogleAdsConversionMilestoneResolved {
  valid: true;
  leadId: string;
  contactId: string | null;
  dealId: string | null;
  appointmentId: string | null;
  // Always server-derived — see the per-event-type comments below for
  // exactly which column each event type's eventAt comes from, and the
  // documented precision/drift limitations where no dedicated milestone
  // timestamp column exists yet.
  eventAt: string;
  conversionValue: number | null;
  currencyCode: string | null;
}

export type ResolveGoogleAdsConversionMilestoneResult =
  | GoogleAdsConversionMilestoneResolved
  | { valid: false; reason: GoogleAdsConversionMilestoneRejectionReason };

interface LeadRow {
  id: string;
  org_id: string;
  status: string | null;
  contact_id: string | null;
  updated_at: string;
}

interface AppointmentRow {
  id: string;
  org_id: string;
  entity_type: string | null;
  entity_id: string | null;
  contact_id: string | null;
  created_at: string;
}

interface DealRow {
  id: string;
  org_id: string;
  lead_id: string | null;
  contact_id: string | null;
  status: string;
  value: number | string | null;
  actual_close_date: string | null;
  updated_at: string;
}

export async function resolveGoogleAdsConversionMilestone(
  supabaseAdmin: SupabaseClient,
  input: ResolveGoogleAdsConversionMilestoneInput,
): Promise<ResolveGoogleAdsConversionMilestoneResult> {
  // leads.org_id (NOT organization_id) — see the schema note at the top of
  // this file. Loaded once regardless of eventType: every milestone type
  // needs the lead to exist in this org, and qualified_lead needs its
  // status/updated_at directly.
  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, org_id, status, contact_id, updated_at")
    .eq("id", input.leadId)
    .eq("org_id", input.organizationId)
    .maybeSingle();

  if (!lead) return { valid: false, reason: "lead_not_found" };
  const leadRow = lead as LeadRow;

  if (input.eventType === "qualified_lead") {
    // Canonical state: leads.status === 'qualified' (src/lib/lead-status.ts
    // — no separate qualified/lifecycle enum exists; do not invent one).
    if (leadRow.status !== "qualified") {
      return { valid: false, reason: "lead_not_qualified" };
    }
    // Step 4 finding: leads has no dedicated qualified_at / status_changed_at
    // column (audited: leads-store.ts + supabase/migrations — neither
    // exists). leads.updated_at is the best available canonical timestamp,
    // but it is a generic mutation timestamp, not a dedicated
    // qualification-moment column — a later, unrelated edit to the same
    // lead row after it became qualified would advance this value past the
    // true qualification moment. Documented limitation, not treated as
    // exact. No migration added for this in Step 7A.1 per instructions.
    return {
      valid: true,
      leadId: leadRow.id,
      contactId: leadRow.contact_id,
      dealId: null,
      appointmentId: null,
      eventAt: leadRow.updated_at,
      conversionValue: null,
      currencyCode: null,
    };
  }

  if (input.eventType === "appointment_booked") {
    if (!input.appointmentId) return { valid: false, reason: "appointment_not_found" };

    const { data: appointment } = await supabaseAdmin
      .from("appointments")
      .select("id, org_id, entity_type, entity_id, contact_id, created_at")
      .eq("id", input.appointmentId)
      .eq("org_id", input.organizationId)
      .maybeSingle();

    if (!appointment) return { valid: false, reason: "appointment_not_found" };
    const apptRow = appointment as AppointmentRow;

    // appointments has no lead_id column (audited: appointments-store.ts —
    // only a polymorphic entity_type/entity_id pair plus contact_id).
    // Strongest available relation: entity_type === 'lead' &&
    // entity_id === leadId. Falls back to a shared contact_id only when
    // the entity link isn't set to this lead — never accepts an
    // appointment whose entity/contact points anywhere else (another org
    // is already excluded by the org_id filter above; another
    // contact/lead is excluded here).
    const matchesLeadEntity = apptRow.entity_type === "lead" && apptRow.entity_id === leadRow.id;
    const matchesContact = !!leadRow.contact_id && !!apptRow.contact_id && apptRow.contact_id === leadRow.contact_id;
    if (!matchesLeadEntity && !matchesContact) {
      return { valid: false, reason: "appointment_lead_mismatch" };
    }

    // Step 6 decision: "booked" is the moment the appointment record was
    // created, not its scheduled/start time (a future site visit is
    // "booked" today even though the visit itself hasn't happened yet).
    // appointments.created_at is used, never scheduled_at.
    return {
      valid: true,
      leadId: leadRow.id,
      contactId: leadRow.contact_id,
      dealId: null,
      appointmentId: apptRow.id,
      eventAt: apptRow.created_at,
      conversionValue: null,
      currencyCode: null,
    };
    // Step 7 decision: a cancelled appointment is NOT re-checked here —
    // the existence of the row proves a booking occurred at some point,
    // which remains valid conversion evidence even if the appointment was
    // later cancelled. No automatic retraction/update of an already-
    // created conversion event happens anywhere in this codebase (no
    // Google upload/retract API exists yet at all).
  }

  if (input.eventType === "deal_won") {
    if (!input.dealId) return { valid: false, reason: "deal_not_found" };

    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id, org_id, lead_id, contact_id, status, value, actual_close_date, updated_at")
      .eq("id", input.dealId)
      .eq("org_id", input.organizationId)
      .maybeSingle();

    if (!deal) return { valid: false, reason: "deal_not_found" };
    const dealRow = deal as DealRow;

    // deals.lead_id is a direct FK (audited: deals-store.ts) — exact
    // equality required, no fallback needed (unlike appointments).
    if (dealRow.lead_id !== leadRow.id) {
      return { valid: false, reason: "deal_lead_mismatch" };
    }
    if (dealRow.status !== "won") {
      return { valid: false, reason: "deal_not_won" };
    }

    // Step 9 decision: deals.actual_close_date (audited: deals-store.ts'
    // resolveDealStatusForOutcome — set once, only when a deal first
    // enters won/lost, never overwritten afterward) is the canonical won
    // timestamp, preferred over updated_at because updated_at can advance
    // on any later, unrelated edit to an already-won deal. Documented
    // limitation: actual_close_date is stored as a DATE (`YYYY-MM-DD`,
    // via `.slice(0, 10)`), not a full timestamp — no time-of-day
    // precision is available, so this is rendered as UTC midnight on that
    // date. Falls back to updated_at only in the unexpected case
    // actual_close_date is null despite status === 'won'.
    const eventAt = dealRow.actual_close_date
      ? `${dealRow.actual_close_date}T00:00:00.000Z`
      : dealRow.updated_at;

    // Step 10: conversion_value is ALWAYS deals.value here — never a
    // caller-supplied conversionValue, never estimates/project/budget.
    // Left null (not fabricated) if deals.value is itself null.
    const conversionValue =
      dealRow.value === null || dealRow.value === undefined
        ? null
        : (() => {
            const n = Number(dealRow.value);
            return Number.isFinite(n) ? n : null;
          })();

    return {
      valid: true,
      leadId: leadRow.id,
      contactId: leadRow.contact_id ?? dealRow.contact_id,
      dealId: dealRow.id,
      appointmentId: null,
      eventAt,
      conversionValue,
      // Step 11: no canonical app-wide currency field exists (confirmed by
      // repo audit — not on deals/organizations/leads). Left null rather
      // than hardcoding USD/ILS; a future Step 7B option is reading the
      // connected Google Ads account's own currencyCode
      // (GoogleAdsSafeAccount.currencyCode) if that's ever judged an
      // appropriate source — not done here.
      currencyCode: null,
    };
  }

  // Exhaustive per GoogleAdsConversionEventType — never reached given
  // isValidGoogleAdsConversionEventType() gates the caller's input first.
  return { valid: false, reason: "lead_not_found" };
}

// ── Export eligibility (Phase 3, Step 7B.2) ──────────────────────────────
//
// Two phases, deliberately split so the LOCAL-ONLY checks (Phase A) can run
// — and reject a synthetic fixture — before anything that requires a
// network call (an OAuth token refresh, let alone a live Google Ads
// request) ever happens. This is what makes the Step 7B.2 network-safety
// test possible: attempting to export a synthetic fixture must result in
// ZERO requests to googleads.googleapis.com, not just a rejection after
// the fact.
//
// Canonical event_type -> conversion_action_id mapping lookup and the live
// Google Ads conversion-action revalidation (Phase B) both require
// network/DB access the caller already has open by that point, so they
// stay as separate composable checks rather than one giant async function
// — google-ads-conversion-export.ts calls them in sequence, in this exact
// order, and never reorders or skips one.

export type GoogleAdsExportRejectionReason =
  | "already_exported"
  | "synthetic_fixture_ineligible"
  | "event_not_ready"
  | "missing_gclid"
  | "mapping_not_found"
  | "mapping_disabled"
  | "conversion_action_not_found"
  | "conversion_action_not_upload_clicks";

// Known synthetic-fixture GCLID namespace (see
// google-ads-lead-test-inject.ts / the Step 7A.1 controlled tests, which
// always use "phase3-gclid-001", "phase3-gclid-002", etc.). This is
// SECONDARY, defense-in-depth only — the canonical synthetic check is
// always isSyntheticTestGoogleAdsSubmission() against the linked
// google_ads_lead_submissions.raw_fields marker. This prefix check exists
// only to catch the (should-never-happen) case where that marker were
// somehow missing/lost, never as a replacement for it.
const SYNTHETIC_FIXTURE_GCLID_PREFIX = "phase3-gclid-";

export function isKnownSyntheticFixtureGclid(gclid: string | null | undefined): boolean {
  return !!gclid && gclid.startsWith(SYNTHETIC_FIXTURE_GCLID_PREFIX);
}

// The one combined synthetic check — true if EITHER the canonical
// raw_fields marker OR the secondary gclid-prefix guard trips. Handles
// raw_fields being either shape isSyntheticTestGoogleAdsSubmission()
// itself already supports (array of {fieldType,fieldValue}) — see that
// function's own doc comment; this wrapper adds no new parsing, it only
// combines the two signals.
export function isSyntheticGoogleAdsConversionEvent(rawFields: unknown, gclid: string | null | undefined): boolean {
  return isSyntheticTestGoogleAdsSubmission(rawFields) || isKnownSyntheticFixtureGclid(gclid);
}

export interface GoogleAdsConversionEventForPreExportCheck {
  exportStatus: GoogleAdsConversionExportStatus;
  gclid: string | null;
}

export type GoogleAdsPreExportCheckResult =
  | { ok: true }
  | { ok: false; reason: "already_exported" | "synthetic_fixture_ineligible" | "event_not_ready" | "missing_gclid" };

// Phase A — local-only, no network/DB call of its own (caller already has
// the event + linked submission's raw_fields loaded). Order matters:
// already-exported and synthetic are checked before the plain "not ready"
// check so their specific, more useful reasons are never masked by a
// generic not-ready result.
export function checkGoogleAdsConversionEventPreExport(
  event: GoogleAdsConversionEventForPreExportCheck,
  submissionRawFields: unknown,
): GoogleAdsPreExportCheckResult {
  if (event.exportStatus === "exported") return { ok: false, reason: "already_exported" };
  if (isSyntheticGoogleAdsConversionEvent(submissionRawFields, event.gclid)) {
    return { ok: false, reason: "synthetic_fixture_ineligible" };
  }
  // 'failed' is deliberately allowed through alongside 'ready' — this is
  // what makes an explicit retry possible (Step 7B.2's retry design).
  // 'pending' and 'ineligible' are not: 'pending' has no mapping/CRM
  // milestone resolved yet, and 'ineligible' means something (usually the
  // synthetic check above, but potentially a future non-synthetic
  // ineligibility reason) already permanently disqualified this event.
  // Neither represents "a real upload attempt was made and failed" — only
  // 'failed' does, so only 'failed' gets retry treatment.
  if (event.exportStatus !== "ready" && event.exportStatus !== "failed") {
    return { ok: false, reason: "event_not_ready" };
  }
  if (!event.gclid) return { ok: false, reason: "missing_gclid" };
  return { ok: true };
}

export interface GoogleAdsMappingRowForExport {
  conversion_action_id: string;
  enabled: boolean;
}

export type GoogleAdsMappingCheckResult =
  | { ok: true; conversionActionId: string }
  | { ok: false; reason: "mapping_not_found" | "mapping_disabled" };

// Phase B, part 1 — after the caller has looked up
// google_ads_conversion_mappings for (organization_id,
// google_ads_customer_id, event_type). Never re-derives that lookup here;
// only interprets its result.
export function checkGoogleAdsConversionMappingForExport(
  mapping: GoogleAdsMappingRowForExport | null,
): GoogleAdsMappingCheckResult {
  if (!mapping) return { ok: false, reason: "mapping_not_found" };
  if (!mapping.enabled) return { ok: false, reason: "mapping_disabled" };
  return { ok: true, conversionActionId: mapping.conversion_action_id };
}

export interface GoogleAdsConversionActionForExport {
  status: string | null;
  type: string | null;
}

export type GoogleAdsActionCheckResult =
  | { ok: true }
  | { ok: false; reason: "conversion_action_not_found" | "conversion_action_not_upload_clicks" };

// Phase B, part 2 — Step 20's "do not blindly trust the saved mapping
// forever" revalidation. Called with the result of a LIVE Google Ads
// conversion_action query at actual upload time (never the value cached
// from when the mapping was originally saved).
export function checkGoogleAdsConversionActionForExport(
  action: GoogleAdsConversionActionForExport | null,
  clickUploadCompatibleType: string,
): GoogleAdsActionCheckResult {
  if (!action || action.status !== "ENABLED") return { ok: false, reason: "conversion_action_not_found" };
  if (action.type !== clickUploadCompatibleType) return { ok: false, reason: "conversion_action_not_upload_clicks" };
  return { ok: true };
}
