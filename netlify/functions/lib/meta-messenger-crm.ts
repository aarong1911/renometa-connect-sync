// netlify/functions/lib/meta-messenger-crm.ts
//
// Messenger Contact Enrichment + First-Conversation Lead Creation. Messenger
// only — Instagram's contact/message handling in meta-webhook.ts is
// deliberately left untouched (still a plain placeholder-name insert), per
// this task's explicit scope. meta-webhook.ts stays focused on verify/
// parse/dispatch; this file holds the CRM business rules for an inbound
// Messenger sender, one call away (resolveMessengerContactAndLead) — same
// separation-of-concerns precedent as lib/meta-lead-ads.ts's
// processMetaLeadgenEvent.
//
// Never logs: message text, email, phone, access/Page tokens, or raw
// webhook payloads. Safe IDs only (orgId, pageId, messengerPsid, contactId).

import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraphRequest, MetaGraphApiError } from "./meta-graph-api";
import { getMetaPageAccessToken } from "./meta-page-access";
import { decryptMetaAccessToken } from "./meta-token-crypto";

const FALLBACK_CONTACT_NAME = "Messenger Contact";

function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed === "" || trimmed === FALLBACK_CONTACT_NAME;
}

interface MessengerSenderProfile {
  firstName: string | null;
  lastName: string | null;
  profilePic: string | null;
}

// Messenger Platform's long-documented Send API "User Profile" fields for a
// PSID, queried with a PAGE-scoped token (not the stored user token) — the
// same Page-scoped-token requirement already established for
// /{page_id}/leadgen_forms and /{page_id}/subscribed_apps. Not independently
// re-verified against a live Graph response this session; if Meta rejects
// one of these fields or the whole call under this app's current
// permissions, fetchMessengerSenderProfile fails closed (returns null) and
// the caller proceeds with the existing "Messenger Contact" fallback — see
// Part 4's "profile lookup failure must not break message ingestion".
const MESSENGER_PROFILE_FIELDS = "first_name,last_name,profile_pic";

async function fetchMessengerSenderProfile(pageAccessToken: string, senderId: string): Promise<MessengerSenderProfile | null> {
  try {
    const resp = await metaGraphRequest<{ first_name?: string; last_name?: string; profile_pic?: string }>({
      path: `/${senderId}`,
      accessToken: pageAccessToken,
      query: { fields: MESSENGER_PROFILE_FIELDS },
    });
    return {
      firstName: typeof resp.first_name === "string" ? resp.first_name : null,
      lastName: typeof resp.last_name === "string" ? resp.last_name : null,
      profilePic: typeof resp.profile_pic === "string" ? resp.profile_pic : null,
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.warn("[meta-messenger-crm] profile_lookup_failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
      });
    } else {
      console.warn("[meta-messenger-crm] profile_lookup_failed (non-Graph error)");
    }
    return null;
  }
}

export interface ResolveMessengerContactAndLeadParams {
  orgId: string;
  pageId: string;
  senderId: string;
  /** The connection row's stored, still-encrypted access_token (long-lived USER token). */
  connectionAccessTokenEncrypted: string;
}

export interface ResolveMessengerContactAndLeadResult {
  contactId: string | null;
}

// Ordering (Part 15): resolve existing Contact by (org_id, messenger_psid)
// -> best-effort profile enrichment ONLY if still needed -> create/enrich
// Contact -> resolve-or-create Lead. Message persistence itself stays in
// meta-webhook.ts, which calls this first and always inserts the inbound
// sms_meta_messages row regardless of this function's outcome (even
// contactId: null) — profile/Lead failures never block message storage.
export async function resolveMessengerContactAndLead(
  supabaseAdmin: SupabaseClient,
  params: ResolveMessengerContactAndLeadParams,
): Promise<ResolveMessengerContactAndLeadResult> {
  const { orgId, pageId, senderId, connectionAccessTokenEncrypted } = params;

  const { data: existingContact, error: lookupErr } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, avatar_url, source")
    .eq("org_id", orgId)
    .eq("messenger_psid", senderId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[meta-messenger-crm] contact lookup failed", { orgId, messengerPsid: senderId });
  }

  let contactId: string | null = existingContact?.id ?? null;
  let contactFullName: string | null = existingContact?.full_name ?? null;
  let contactAvatarUrl: string | null = existingContact?.avatar_url ?? null;
  let contactSource: string | null = existingContact?.source ?? null;

  // Best-effort profile enrichment — ONLY attempted while the contact still
  // has no real name (a brand-new contact, or one still holding the
  // "Messenger Contact" placeholder from before this feature existed).
  // Never re-fetched on every message once a real name is set (Part 2: "on
  // the FIRST inbound message"), and never overwrites a human-edited name
  // (Part 5/6).
  let metaProfile: MessengerSenderProfile | null = null;
  if (isPlaceholderName(contactFullName)) {
    try {
      const userAccessToken = decryptMetaAccessToken(connectionAccessTokenEncrypted);
      const pageAccessToken = await getMetaPageAccessToken(userAccessToken, pageId);
      metaProfile = await fetchMessengerSenderProfile(pageAccessToken, senderId);
    } catch {
      // Token decrypt or Page-token derivation failure — best-effort only,
      // never logs the token itself, never blocks the rest of this flow.
      console.warn("[meta-messenger-crm] profile enrichment unavailable", { orgId, pageId });
    }
  }

  const metaFullName = metaProfile
    ? [metaProfile.firstName, metaProfile.lastName]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join(" ")
        .trim() || null
    : null;

  if (!contactId) {
    const { data: created, error: createErr } = await supabaseAdmin
      .from("contacts")
      .insert({
        org_id: orgId,
        messenger_psid: senderId,
        full_name: metaFullName || FALLBACK_CONTACT_NAME,
        source: "messenger",
        avatar_url: metaProfile?.profilePic ?? null,
      })
      .select("id, full_name, avatar_url, source")
      .maybeSingle();

    if (createErr) {
      if (createErr.code === "23505") {
        // Lost a concurrent-creation race against idx_contacts_org_messenger_psid
        // (unique on org_id, messenger_psid) — re-read the winner rather than
        // erroring. Same idempotent-insert idiom lib/meta-lead-ads.ts's
        // processMetaLeadgenEvent already uses for meta_lead_submissions.
        const { data: winner } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, avatar_url, source")
          .eq("org_id", orgId)
          .eq("messenger_psid", senderId)
          .maybeSingle();
        contactId = winner?.id ?? null;
        contactFullName = winner?.full_name ?? null;
        contactAvatarUrl = winner?.avatar_url ?? null;
        contactSource = winner?.source ?? null;
      } else {
        console.error("[meta-messenger-crm] contact_create_failed", { orgId, messengerPsid: senderId, code: createErr.code });
      }
    } else {
      contactId = created?.id ?? null;
      contactFullName = created?.full_name ?? null;
      contactAvatarUrl = created?.avatar_url ?? null;
      contactSource = created?.source ?? null;
    }
  } else {
    // Existing contact — two INDEPENDENT, additive-only enrichments, never
    // gated on each other:
    //   1. Name/avatar: only while the name is still a placeholder (Part 5/6
    //      — never overwrites a human-edited or already-Meta-enriched name),
    //      which is also what gates whether a profile Graph call was even
    //      attempted above.
    //   2. Source backfill (Part 1/2): independent of name state — a
    //      Contact that already has a real name from an earlier message but
    //      was created before this backfill existed (contacts.source still
    //      null) still gets backfilled on this message. NEVER overwrites a
    //      meaningful existing source (google_ads, meta_ads, website, phone,
    //      sms, etc.) — only fires when the stored value is null/empty.
    const patch: Record<string, unknown> = {};
    if (metaFullName && isPlaceholderName(contactFullName)) {
      patch.full_name = metaFullName;
      if (!contactAvatarUrl && metaProfile?.profilePic) patch.avatar_url = metaProfile.profilePic;
    }
    if (!contactSource || contactSource.trim() === "") {
      patch.source = "messenger";
    }

    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await supabaseAdmin
        .from("contacts")
        .update(patch)
        .eq("id", contactId)
        .eq("org_id", orgId);
      if (updateErr) {
        console.error("[meta-messenger-crm] contact_enrichment_failed", { orgId, contactId, code: updateErr.code });
      } else {
        if (typeof patch.full_name === "string") contactFullName = patch.full_name;
        if (typeof patch.avatar_url === "string") contactAvatarUrl = patch.avatar_url;
        if (typeof patch.source === "string") contactSource = patch.source;
      }
    }
  }

  if (!contactId) {
    return { contactId: null };
  }

  // ── Lead resolution (Part 8/9) ────────────────────────────────────────
  // "Active/open" = not one of the two terminal statuses in the existing
  // 5-value lead-status model (src/lib/lead-status.ts:
  // new/contacted/qualified/converted/lost) — converted and lost are the
  // only statuses this codebase already treats as closed; the other three
  // are open by construction. No new status is invented.
  const { data: activeLead, error: leadLookupErr } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("source", "messenger")
    .not("status", "in", "(converted,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (leadLookupErr) {
    console.error("[meta-messenger-crm] lead_lookup_failed", { orgId, contactId, code: leadLookupErr.code });
    // Fail safe toward NOT creating a possibly-duplicate lead when we can't
    // even confirm whether an active one already exists.
    return { contactId };
  }

  if (!activeLead) {
    // RESIDUAL RACE RISK (Part 14, documented not hidden): this is a
    // query-then-insert, not a DB-enforced atomic guarantee. Unlike
    // meta_lead_submissions' real (org_id, meta_lead_id) unique constraint,
    // there is no existing DB uniqueness for "one active Messenger lead per
    // contact", and this task's instructions explicitly say not to invent a
    // brittle partial unique index without first understanding full status
    // semantics/migration impact. Two genuinely simultaneous first-ever
    // Messenger messages from the same brand-new sender could both pass
    // this check before either INSERT commits, creating two Leads. This is
    // the strongest safe approach available without a schema change, not a
    // hidden gap.
    const { error: leadCreateErr } = await supabaseAdmin.from("leads").insert({
      org_id: orgId,
      contact_id: contactId,
      name: contactFullName || FALLBACK_CONTACT_NAME,
      source: "messenger",
      status: "new",
    });
    if (leadCreateErr) {
      console.error("[meta-messenger-crm] lead_create_failed", { orgId, contactId, code: leadCreateErr.code });
    }
  }

  return { contactId };
}
