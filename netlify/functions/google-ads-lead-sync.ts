// netlify/functions/google-ads-lead-sync.ts
//
// Phase 3, Step 6, Part B: authenticated, manually-triggered ingestion of
// Google Ads lead-form submissions into RenoMeta Connect. Server-only —
// resolves the organization from the caller's Supabase session (same as
// every other Google Ads endpoint), decrypts the org's stored refresh
// token, fetches lead_form_submission_data since the last successful sync
// (with a small overlap window), dedupes by Google's own immutable
// submission ID (database-enforced, never a read-then-write check), and
// links each new submission to a CRM contact/lead — matching an existing
// contact by normalized email/phone within the SAME organization, or
// creating a new contact when no match exists.
//
// Step 6A product decision: each NEW Google submission is its own CRM
// inquiry/opportunity. The CONTACT may be reused across a person's
// multiple submissions over time, but a LEAD is always created fresh for
// every genuinely new submission — never reused from an earlier
// submission by the same contact. Idempotency is preserved because CRM
// creation only ever runs for a submission row that either (a) was just
// newly inserted this run, or (b) previously failed CRM linking and still
// has no lead_id (see the retry pass below) — a submission that already
// has a lead_id is never touched again.
//
// Step 6B: the retry pass is a DURABLE LOCAL RECOVERY QUEUE, independent
// of the current Google API fetch batch/incremental window. A failed row
// is retried purely because it still exists locally with lead_id null —
// never because its google_submission_id happens to still be inside
// `since`/the overlap window. See buildRetryCandidatesQuery below.
//
// Step 6C.1: provider-row persistence/dedupe and CRM contact/lead
// creation live in lib/google-ads-lead-ingestion.ts
// (insertGoogleAdsLeadSubmissions / ingestGoogleAdsSubmission) — the SAME
// two functions the dev-only synthetic test harness
// (google-ads-lead-test-inject.ts) calls, so there is exactly one
// implementation of this business logic, never two.
//
// This function does NOT export offline conversions back to Google — see
// google_ads_lead_submissions' gclid/submission_date_time/campaign columns,
// which exist specifically so a later phase can do that without re-fetching
// from Google.
//
// Never logs or returns: encrypted_refresh_token, the decrypted refresh
// token, the temporary access token, GOOGLE_ADS_CLIENT_SECRET,
// GOOGLE_ADS_DEVELOPER_TOKEN, raw lead PII (email/phone/name), or a raw
// Google response body.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  preflightGoogleAdsConnection,
  GoogleAdsApiError,
  GoogleAdsResultLimitExceededError,
  type GoogleAdsConnectionRowForSummary,
} from "./lib/google-ads-api";
import { buildGoogleAdsLeadFormSubmissionQuery, parseGoogleAdsLeadFormSubmissionRow } from "./lib/google-ads-leads-api";
import {
  parseGoogleAdsLeadFormFields,
  parseGoogleAdsLeadFormCustomFields,
  normalizeGoogleAdsLeadFields,
  normalizeGoogleAdsLeadEmail,
  normalizeGoogleAdsLeadPhone,
} from "./lib/google-ads-lead-fields";
import {
  insertGoogleAdsLeadSubmissions,
  ingestGoogleAdsSubmission,
  type GoogleAdsSubmissionInsertPayload,
  type GoogleAdsSubmissionForCrmLinking,
} from "./lib/google-ads-lead-ingestion";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Part B4: initial sync fetches a conservative recent window; subsequent
// syncs use lead_last_synced_at minus an overlap, so a submission that
// arrived (or was still being indexed by Google) right at the edge of a
// prior sync window is never permanently missed. Dedupe is NEVER based on
// this window alone — the DB unique constraint on
// (organization_id, google_ads_customer_id, google_submission_id) is what
// actually prevents duplicates; the overlap just makes sure a real new
// submission is never skipped by a timestamp gap.
const INITIAL_SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SYNC_OVERLAP_MS = 10 * 60 * 1000; // 10 minutes

// Step 6B: bounded local-recovery-queue batch size — one bad/stuck failed
// row must never block the rest of a sync, and this caps how much retry
// work a single manual sync run takes on. Chosen conservatively small
// (this is a manually-triggered, synchronous HTTP request, not a
// background worker) — any remaining failed rows beyond this batch are
// simply picked up by the next sync run, oldest-first (see the retry query
// below), so nothing is ever skipped forever.
const RETRY_BATCH_LIMIT = 50;

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
  lead_last_synced_at: string | null;
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-lead-sync:${requestId}] ${phase}`, extra ?? {});
  const logWarn = (phase: string, extra?: Record<string, unknown>) =>
    console.warn(`[google-ads-lead-sync:${requestId}] ${phase}`, extra ?? {});

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    logError("server_configuration", { hasDeveloperToken: false });
    return errorResponse(headers, 500, "server_configuration");
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id, lead_last_synced_at")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    logError("connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId, loginCustomerId } = preflight;
  const connectionId = connection!.id;

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection!.encrypted_refresh_token!);
  } catch {
    logError("decrypt_failed");
    return errorResponse(headers, 500, "server_configuration");
  }

  const tokenResult = await refreshGoogleAdsAccessToken(refreshTokenPlain);
  if (!tokenResult.ok) {
    const nowIso = new Date().toISOString();
    if (tokenResult.errorCode === "reconnect_required") {
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", lead_last_error_code: "reconnect_required", lead_last_error_at: nowIso, updated_at: nowIso })
        .eq("id", connectionId)
        .eq("organization_id", orgId);
      return errorResponse(headers, 409, "reconnect_required");
    }
    await supabaseAdmin
      .from("google_ads_connections")
      .update({ lead_last_error_code: tokenResult.errorCode, lead_last_error_at: nowIso, updated_at: nowIso })
      .eq("id", connectionId)
      .eq("organization_id", orgId);
    return errorResponse(headers, 500, tokenResult.errorCode);
  }
  const { accessToken } = tokenResult;

  // Part B4 — incremental window, computed entirely server-side.
  const since = connection!.lead_last_synced_at
    ? new Date(new Date(connection!.lead_last_synced_at).getTime() - SYNC_OVERLAP_MS)
    : new Date(Date.now() - INITIAL_SYNC_WINDOW_MS);

  let rawResults: unknown[];
  try {
    const query = buildGoogleAdsLeadFormSubmissionQuery(since);
    rawResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, query, loginCustomerId);
  } catch (e) {
    const nowIso = new Date().toISOString();
    let errorCode = "network_error";
    if (e instanceof GoogleAdsResultLimitExceededError) {
      errorCode = "result_limit_exceeded";
      logError("result_limit_exceeded");
    } else if (e instanceof GoogleAdsApiError) {
      errorCode = "google_ads_api_error";
      logError("google_ads_api_error", { status: e.status });
    } else {
      logError("network_error");
    }
    await supabaseAdmin
      .from("google_ads_connections")
      .update({ lead_last_error_code: errorCode, lead_last_error_at: nowIso, updated_at: nowIso })
      .eq("id", connectionId)
      .eq("organization_id", orgId);
    return errorResponse(headers, 500, errorCode);
  }

  const parsedRows = rawResults
    .map(parseGoogleAdsLeadFormSubmissionRow)
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const fetched = parsedRows.length;

  // ── Insert-or-skip, atomically deduped by the DB unique constraint ─────
  // ignoreDuplicates: true -> INSERT ... ON CONFLICT DO NOTHING under the
  // hood; the returned rows are exactly the ones that were NEWLY inserted
  // this run. A conflicting (already-ingested) submission is silently
  // skipped here — its CRM linkage was already resolved by whichever
  // earlier run first inserted it, so there is nothing further to do for
  // it. This is the atomic dedupe decision (Part B4/B5) — never a
  // read-then-write check in this function.
  const insertPayload: GoogleAdsSubmissionInsertPayload[] = parsedRows.map((row) => {
    const standardFields = parseGoogleAdsLeadFormFields(row.rawFields);
    const normalized = normalizeGoogleAdsLeadFields(standardFields);
    return {
      organization_id: orgId,
      google_ads_customer_id: selectedCustomerId,
      google_submission_id: row.submissionId,
      google_resource_name: row.resourceName,
      campaign_id: row.campaignId,
      campaign_name: row.campaignName,
      asset_id: row.assetId,
      ad_group_id: row.adGroupId,
      ad_group_ad_id: row.adGroupAdId,
      gclid: row.gclid,
      submission_date_time: row.submissionDateTime,
      raw_fields: parseGoogleAdsLeadFormFields(row.rawFields),
      raw_custom_fields: parseGoogleAdsLeadFormCustomFields(row.rawCustomFields),
      normalized_email: normalizeGoogleAdsLeadEmail(normalized.email),
      normalized_phone: normalizeGoogleAdsLeadPhone(normalized.phone),
      normalized_first_name: normalized.firstName,
      normalized_last_name: normalized.lastName,
      normalized_full_name: normalized.fullName,
      ingestion_status: "pending" as const,
    };
  });

  let newlyInserted: GoogleAdsSubmissionForCrmLinking[] = [];
  try {
    newlyInserted = await insertGoogleAdsLeadSubmissions(supabaseAdmin, insertPayload);
  } catch (e: any) {
    logError("submission_insert_failed", { code: e?.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const newSubmissions = newlyInserted.length;
  const existingSubmissions = fetched - newSubmissions;

  // ── Step 6B: durable local recovery queue — a submission row that
  // already exists (from ANY earlier run, not just this fetch) but never
  // successfully linked to CRM (ingestion_status = 'failed', lead_id still
  // null) gets retried here. Deliberately NOT constrained to
  // `google_submission_id IN <this run's Google fetch batch>` — that was
  // the exact bug: a failed row could become permanently stranded once
  // Google stopped returning it (outside the incremental window/overlap)
  // even though it was still sitting locally, fully recoverable, with all
  // the data needed to retry. Scoped to the SAME org + SAME selected
  // advertiser only (Step 13) — never another org's or another Google Ads
  // account's failed rows. Bounded batch, oldest-first by created_at (not
  // updated_at, which changes on every retry attempt and would otherwise
  // let a repeatedly-failing recent row keep jumping ahead of genuinely
  // older failures) — Step 3.
  //
  // contact_id IS NULL is included as defense-in-depth, not because it's
  // independently necessary: contact_id and lead_id are only ever written
  // together in the success path below (one .update() call), and the
  // failure catch path never touches contact_id — so a row with
  // ingestion_status='failed' is already guaranteed to have contact_id
  // null too. This just makes that invariant explicit at the query level.
  let retryCandidates: GoogleAdsSubmissionForCrmLinking[] = [];
  {
    const { data, error: retryErr } = await supabaseAdmin
      .from("google_ads_lead_submissions")
      .select("id, normalized_email, normalized_phone, normalized_full_name, campaign_name")
      .eq("organization_id", orgId)
      .eq("google_ads_customer_id", selectedCustomerId)
      .eq("ingestion_status", "failed")
      .is("lead_id", null)
      .is("contact_id", null)
      .order("created_at", { ascending: true })
      .limit(RETRY_BATCH_LIMIT);
    if (retryErr) {
      logWarn("retry_candidate_lookup_failed", { code: retryErr.code });
    } else {
      retryCandidates = data ?? [];
    }
  }
  const retriedFailed = retryCandidates.length;

  // ── Step 6: dedupe the combined work list by DB row id — defense in
  // depth. In the current single-request flow a row can never appear in
  // BOTH newlyInserted (status='pending' at insert time) and
  // retryCandidates (status='failed'), but a Map keyed by id guarantees no
  // submission is ever processed twice even if that invariant changes
  // later.
  const retryIds = new Set(retryCandidates.map((r) => r.id));
  const workListById = new Map<string, GoogleAdsSubmissionForCrmLinking>();
  for (const s of newlyInserted) workListById.set(s.id, s);
  for (const s of retryCandidates) workListById.set(s.id, s);

  // ── CRM dedupe/creation — the SAME shared pipeline
  // (ingestGoogleAdsSubmission, lib/google-ads-lead-ingestion.ts) for
  // genuinely new submissions and recovered failed rows (Step 4): field
  // data was already normalized/persisted at insert time (Step 5 — never
  // re-fetched from Google to retry). An already-ingested, already-linked
  // submission is never touched again. Step 6C.1: this is the exact same
  // function the dev-only test harness calls — no duplicated business
  // logic between the two.
  let crmCreated = 0;
  let crmMatched = 0;
  let failed = 0;
  let recoveredFailed = 0;

  for (const submission of workListById.values()) {
    const result = await ingestGoogleAdsSubmission(supabaseAdmin, orgId, submission);
    if (result.ok) {
      if (result.status === "created") crmCreated++;
      else crmMatched++;
      if (retryIds.has(submission.id)) recoveredFailed++;
    } else {
      failed++;
      logWarn("crm_link_failed", { submissionRowId: submission.id, reason: result.reason });
    }
  }

  // ── Operational bookkeeping — lead-sync-specific fields only. Never the
  // selected account, login customer, encrypted refresh token, status
  // (account status), or accessible IDs (Part 9 equivalent for this
  // endpoint). A failure here must not turn a successful sync into a
  // failed response. ─────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("google_ads_connections")
    .update({ lead_last_synced_at: nowIso, lead_last_error_code: null, lead_last_error_at: null, updated_at: nowIso })
    .eq("id", connectionId)
    .eq("organization_id", orgId);
  if (updateErr) {
    logWarn("lead_last_synced_at_update_failed", { code: updateErr.code });
  }

  // Safe summary counts only — never a raw lead payload, never PII.
  console.log(`[google-ads-lead-sync:${requestId}] ok`, {
    fetched, newSubmissions, existingSubmissions, retriedFailed, recoveredFailed, crmCreated, crmMatched, failed,
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      connected: true,
      fetched,
      newSubmissions,
      existingSubmissions,
      // Step 10 — additive, backward-safe: existing fields keep their
      // exact prior meaning, these two are new. retriedFailed = how many
      // locally-stored failed rows were attempted this run (independent of
      // the Google fetch batch); recoveredFailed = how many of those
      // actually succeeded this run.
      retriedFailed,
      recoveredFailed,
      crmCreated,
      crmMatched,
      failed,
      lastSyncedAt: nowIso,
    }),
  };
};
