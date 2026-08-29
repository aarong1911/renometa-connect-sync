// netlify/functions/lib/meta-instagram-crm.ts
//
// Instagram Direct Contact Enrichment + First-Conversation Lead Creation —
// brings Instagram Direct to parity with the already-live-tested Messenger
// CRM behavior (lib/meta-messenger-crm.ts), using ONLY fields/endpoints
// valid for this app's proven architecture: Instagram Messaging via
// Facebook Login with a Page's linked IG professional/business account (NOT
// standalone Instagram Login, NOT instagram_business_* permissions).
//
// Deliberately a SEPARATE file from meta-messenger-crm.ts rather than a
// shared/parameterized helper — Messenger's resolve/create logic is already
// live-tested and must not be touched or risked by a refactor. Some
// structure is intentionally duplicated; this mirrors the same
// separate-per-product precedent lib/meta-messaging.ts already uses for
// ensureMetaMessengerSubscription/ensureMetaInstagramSubscription.
//
// Never logs: message text, email, phone, access/Page tokens, or raw
// webhook payloads. Safe IDs only (orgId, pageId, instagramIgsid, contactId).

import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraphRequest, MetaGraphApiError } from "./meta-graph-api";
import { getMetaPageAccessToken } from "./meta-page-access";
import { decryptMetaAccessToken } from "./meta-token-crypto";

const FALLBACK_CONTACT_NAME = "Instagram Contact";

function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed === "" || trimmed === FALLBACK_CONTACT_NAME;
}

interface InstagramSenderProfile {
  name: string | null;
  username: string | null;
  profilePic: string | null;
}

// Instagram Platform's documented "Instagram User Profile" fields for an
// IGSID under the Facebook-Login + linked-Page architecture (instagram_basic
// + instagram_manage_messages, queried with a PAGE-scoped token — the same
// Page-token requirement Messenger/Lead Ads already established). Instagram
// accounts have one combined display `name` field and a separate `username`
// handle — NOT split first_name/last_name like Messenger's Send API. NOT
// independently re-verified against a live Graph response this session; if
// Meta rejects one of these fields or the whole call under this app's
// current permissions, fetchInstagramSenderProfile fails closed (returns
// null) and the caller proceeds with the existing "Instagram Contact"
// fallback, exactly matching Messenger's "profile lookup must not break
// message ingestion" contract.
const INSTAGRAM_PROFILE_FIELDS = "name,username,profile_pic";

async function fetchInstagramSenderProfile(pageAccessToken: string, senderId: string): Promise<InstagramSenderProfile | null> {
  try {
    const resp = await metaGraphRequest<{ name?: string; username?: string; profile_pic?: string }>({
      path: `/${senderId}`,
      accessToken: pageAccessToken,
      query: { fields: INSTAGRAM_PROFILE_FIELDS },
    });
    return {
      name: typeof resp.name === "string" ? resp.name : null,
      username: typeof resp.username === "string" ? resp.username : null,
      profilePic: typeof resp.profile_pic === "string" ? resp.profile_pic : null,
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.warn("[meta-instagram-crm] profile_lookup_failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
      });
    } else {
      console.warn("[meta-instagram-crm] profile_lookup_failed (non-Graph error)");
    }
    return null;
  }
}

export interface ResolveInstagramContactAndLeadParams {
  orgId: string;
  pageId: string;
  senderId: string;
  /** The connection row's stored, still-encrypted access_token (long-lived USER token). */
  connectionAccessTokenEncrypted: string;
}

export interface ResolveInstagramContactAndLeadResult {
  contactId: string | null;
}

// Ordering mirrors resolveMessengerContactAndLead exactly: resolve existing
// Contact by (org_id, instagram_igsid) -> best-effort profile enrichment
// ONLY if still needed -> create/enrich Contact -> resolve-or-create Lead.
// Message persistence stays in meta-webhook.ts, which calls this first and
// always inserts the inbound sms_meta_messages row regardless of this
// function's outcome (even contactId: null) — profile/Lead failures never
// block message storage.
export async function resolveInstagramContactAndLead(
  supabaseAdmin: SupabaseClient,
  params: ResolveInstagramContactAndLeadParams,
): Promise<ResolveInstagramContactAndLeadResult> {
  const { orgId, pageId, senderId, connectionAccessTokenEncrypted } = params;

  const { data: existingContact, error: lookupErr } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, avatar_url, source")
    .eq("org_id", orgId)
    .eq("instagram_igsid", senderId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[meta-instagram-crm] contact lookup failed", { orgId, instagramIgsid: senderId });
  }

  let contactId: string | null = existingContact?.id ?? null;
  let contactFullName: string | null = existingContact?.full_name ?? null;
  let contactAvatarUrl: string | null = existingContact?.avatar_url ?? null;
  let contactSource: string | null = existingContact?.source ?? null;

  // Best-effort profile enrichment — ONLY attempted while the contact still
  // has no real name (a brand-new contact, or one still holding the
  // "Instagram Contact" placeholder). Never re-fetched on every message once
  // a real name is set, and never overwrites a human-edited name.
  let metaProfile: InstagramSenderProfile | null = null;
  if (isPlaceholderName(contactFullName)) {
    try {
      const userAccessToken = decryptMetaAccessToken(connectionAccessTokenEncrypted);
      const pageAccessToken = await getMetaPageAccessToken(userAccessToken, pageId);
      metaProfile = await fetchInstagramSenderProfile(pageAccessToken, senderId);
    } catch {
      // Token decrypt or Page-token derivation failure — best-effort only,
      // never logs the token itself, never blocks the rest of this flow.
      console.warn("[meta-instagram-crm] profile enrichment unavailable", { orgId, pageId });
    }
  }

  // Name precedence: real display `name` first, then `username` (prefixed
  // for recognizability — it's a handle, not a fabricated name), then the
  // existing fallback. Never fabricates email/phone — Instagram's profile
  // API doesn't return either, and none is invented here.
  const metaFullName = metaProfile
    ? (metaProfile.name && metaProfile.name.trim().length > 0
        ? metaProfile.name.trim()
        : metaProfile.username && metaProfile.username.trim().length > 0
          ? `@${metaProfile.username.trim()}`
          : null)
    : null;

  if (!contactId) {
    const { data: created, error: createErr } = await supabaseAdmin
      .from("contacts")
      .insert({
        org_id: orgId,
        instagram_igsid: senderId,
        full_name: metaFullName || FALLBACK_CONTACT_NAME,
        source: "instagram",
        avatar_url: metaProfile?.profilePic ?? null,
      })
      .select("id, full_name, avatar_url, source")
      .maybeSingle();

    if (createErr) {
      if (createErr.code === "23505") {
        // Lost a concurrent-creation race against idx_contacts_org_instagram_igsid
        // (unique on org_id, instagram_igsid) — re-read the winner rather
        // than erroring. Same idempotent-insert idiom
        // lib/meta-messenger-crm.ts and lib/meta-lead-ads.ts already use.
        const { data: winner } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, avatar_url, source")
          .eq("org_id", orgId)
          .eq("instagram_igsid", senderId)
          .maybeSingle();
        contactId = winner?.id ?? null;
        contactFullName = winner?.full_name ?? null;
        contactAvatarUrl = winner?.avatar_url ?? null;
        contactSource = winner?.source ?? null;
      } else {
        console.error("[meta-instagram-crm] contact_create_failed", { orgId, instagramIgsid: senderId, code: createErr.code });
      }
    } else {
      contactId = created?.id ?? null;
      contactFullName = created?.full_name ?? null;
      contactAvatarUrl = created?.avatar_url ?? null;
      contactSource = created?.source ?? null;
    }
  } else {
    // Existing contact — two INDEPENDENT, additive-only enrichments, never
    // gated on each other (mirrors Messenger's exact rule):
    //   1. Name/avatar: only while the name is still a placeholder — never
    //      overwrites a human-edited or already-enriched name.
    //   2. Source backfill: independent of name state — a Contact that
    //      already has a real name but was created before this backfill
    //      existed (contacts.source still null) still gets backfilled.
    //      NEVER overwrites a meaningful existing source (google_ads,
    //      meta_ads, website, phone, sms, etc.) — only fires when the
    //      stored value is null/empty.
    const patch: Record<string, unknown> = {};
    if (metaFullName && isPlaceholderName(contactFullName)) {
      patch.full_name = metaFullName;
      if (!contactAvatarUrl && metaProfile?.profilePic) patch.avatar_url = metaProfile.profilePic;
    }
    if (!contactSource || contactSource.trim() === "") {
      patch.source = "instagram";
    }

    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await supabaseAdmin
        .from("contacts")
        .update(patch)
        .eq("id", contactId)
        .eq("org_id", orgId);
      if (updateErr) {
        console.error("[meta-instagram-crm] contact_enrichment_failed", { orgId, contactId, code: updateErr.code });
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

  // ── Lead resolution ──────────────────────────────────────────────────
  // "Active/open" = not one of the two terminal statuses in the existing
  // 5-value lead-status model (src/lib/lead-status.ts:
  // new/contacted/qualified/converted/lost) — same rule Messenger uses.
  const { data: activeLead, error: leadLookupErr } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("source", "instagram")
    .not("status", "in", "(converted,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (leadLookupErr) {
    console.error("[meta-instagram-crm] lead_lookup_failed", { orgId, contactId, code: leadLookupErr.code });
    // Fail safe toward NOT creating a possibly-duplicate lead when we can't
    // even confirm whether an active one already exists.
    return { contactId };
  }

  if (!activeLead) {
    // RESIDUAL RACE RISK (documented not hidden, same as Messenger): this is
    // a query-then-insert, not a DB-enforced atomic guarantee — no DB
    // uniqueness exists for "one active Instagram lead per contact", and per
    // this task's explicit instruction no such constraint is added here.
    // Two genuinely simultaneous first-ever Instagram DMs from the same
    // brand-new sender could both pass this check before either INSERT
    // commits, creating two Leads.
    const { error: leadCreateErr } = await supabaseAdmin.from("leads").insert({
      org_id: orgId,
      contact_id: contactId,
      name: contactFullName || FALLBACK_CONTACT_NAME,
      source: "instagram",
      status: "new",
    });
    if (leadCreateErr) {
      console.error("[meta-instagram-crm] lead_create_failed", { orgId, contactId, code: leadCreateErr.code });
    }
  }

  return { contactId };
}
