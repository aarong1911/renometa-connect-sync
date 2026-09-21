// netlify/functions/lib/meta-whatsapp-candidates.ts
//
// WhatsApp OAuth connection-quality fix. Replaces meta-oauth-callback.ts's
// previous blind `data[0]` selection (first business -> first WABA ->
// first phone number) with a full enumeration of every
// business/WABA/phone-number combination the connected Meta user can see,
// so the callback can decide whether auto-connect (exactly one candidate)
// or explicit operator selection (more than one) applies — see that
// file's header for the full decision.
//
// Deliberately does NOT guess at which candidate is "real" vs. a test
// number by pattern-matching the phone number (e.g. a "555" area code) —
// Meta does not expose a documented field that reliably marks a number as
// a test/placeholder number, and this task's own instruction is explicit
// that heuristic guessing must not be built into production logic. Every
// field on WhatsAppCandidate is a real field the Graph API returns for
// that node type — nothing invented.
//
// Bounded and best-effort: caps how many businesses/WABAs are scanned (a
// pathological account with hundreds of businesses should not turn one
// OAuth callback into hundreds of serial Graph API calls), and a failure
// partway through returns whatever candidates were already found rather
// than throwing — matches this file's caller's existing "a discovery
// failure must never block the whole connect" pattern for other product
// discovery blocks in meta-oauth-callback.ts. In this file specifically,
// a "return what we found so far" behavior is still safe: the caller
// (meta-oauth-callback.ts) treats zero candidates as a hard failure
// regardless of whether that's because the account truly has none or
// because discovery errored out here.

const MAX_BUSINESSES_SCANNED = 10;
const MAX_WABAS_PER_BUSINESS = 10;

export type WhatsAppCandidate = {
  // businessId/wabaId are null for a manually-validated candidate (see
  // validateWhatsAppPhoneNumberId below) — the whole reason that fallback
  // exists is that Meta's enumeration edges did NOT attribute this phone
  // number to any business/WABA this token could walk to. Every enumerated
  // candidate (discoverWhatsAppCandidates) still always sets both, since
  // they come directly from the business/WABA loop variables.
  businessId: string | null;
  businessName: string | null;
  wabaId: string | null;
  wabaName: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
};

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json().catch(() => ({}));
}

/**
 * Enumerates every WhatsApp phone-number candidate the given access token
 * can see, across every business and every WABA under each business.
 * Never throws — a failure at any level is logged and simply yields fewer
 * candidates, not an exception the caller must handle specially.
 */
export async function discoverWhatsAppCandidates(accessToken: string): Promise<WhatsAppCandidate[]> {
  const candidates: WhatsAppCandidate[] = [];

  let businesses: { id: string; name?: string }[] = [];
  try {
    const biz = await fetchJson(
      `https://graph.facebook.com/v21.0/me/businesses?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    );
    businesses = Array.isArray(biz?.data) ? biz.data : [];
  } catch (e) {
    console.warn("[meta-whatsapp-candidates] business discovery failed:", e);
    return candidates;
  }

  for (const business of businesses.slice(0, MAX_BUSINESSES_SCANNED)) {
    if (!business?.id) continue;
    let wabas: { id: string; name?: string }[] = [];
    try {
      const wabaList = await fetchJson(
        `https://graph.facebook.com/v21.0/${business.id}/owned_whatsapp_business_accounts?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
      );
      wabas = Array.isArray(wabaList?.data) ? wabaList.data : [];
    } catch (e) {
      console.warn("[meta-whatsapp-candidates] WABA discovery failed for business", business.id, e);
      continue;
    }

    for (const waba of wabas.slice(0, MAX_WABAS_PER_BUSINESS)) {
      if (!waba?.id) continue;
      try {
        const phones = await fetchJson(
          `https://graph.facebook.com/v21.0/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(accessToken)}`,
        );
        const phoneList: any[] = Array.isArray(phones?.data) ? phones.data : [];
        for (const phone of phoneList) {
          if (!phone?.id || !phone?.display_phone_number) continue;
          candidates.push({
            businessId: business.id,
            businessName: business.name ?? null,
            wabaId: waba.id,
            wabaName: waba.name ?? null,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
            verifiedName: phone.verified_name ?? null,
            qualityRating: phone.quality_rating ?? null,
          });
        }
      } catch (e) {
        console.warn("[meta-whatsapp-candidates] phone number discovery failed for WABA", waba.id, e);
      }
    }
  }

  return candidates;
}

/** Safe subset of a candidate for the BROWSER — no raw technical ids
 * beyond phoneNumberId (needed so the operator's selection can be
 * submitted back), no access token, no raw Graph payload. */
export type SafeWhatsAppCandidate = {
  phoneNumberId: string;
  businessName: string | null;
  wabaName: string | null;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
};

export function toSafeCandidate(c: WhatsAppCandidate): SafeWhatsAppCandidate {
  return {
    phoneNumberId: c.phoneNumberId,
    businessName: c.businessName,
    wabaName: c.wabaName,
    displayPhoneNumber: c.displayPhoneNumber,
    verifiedName: c.verifiedName,
    qualityRating: c.qualityRating,
  };
}

// Test-safety incident follow-up (2026-09-17/18): the zero/one/many
// branching that used to be inlined in meta-oauth-callback.ts is a pure
// function of the candidate list — no network, no DB. Extracted so it can
// be unit-tested directly with synthetic candidate arrays, independent of
// both discoverWhatsAppCandidates() (network) and the selection-store
// functions (DB). meta-oauth-callback.ts's actual branching logic now
// calls this instead of re-checking candidates.length inline — same
// three outcomes, unchanged behavior.
export type CandidateAction =
  | { type: "auto_connect"; candidate: WhatsAppCandidate }
  | { type: "selection_required"; candidates: WhatsAppCandidate[] }
  | { type: "zero_candidates" };

export function decideCandidateAction(candidates: WhatsAppCandidate[]): CandidateAction {
  if (candidates.length === 0) return { type: "zero_candidates" };
  if (candidates.length === 1) return { type: "auto_connect", candidate: candidates[0] };
  return { type: "selection_required", candidates };
}

// ── "I don't see my number" manual fallback ──────────────────────────────
//
// Repo-wide audit finding (read-only audits, this session): Meta's Graph
// API sometimes does not attribute a real, healthy CLOUD_API phone number
// to ANY business/WABA combination the connecting token can walk via
// /me/businesses -> owned_whatsapp_business_accounts (or
// client_whatsapp_business_accounts) — confirmed against a real case where
// a GREEN-quality, CLOUD_API phone number was invisible to
// discoverWhatsAppCandidates() above despite being directly readable by
// node id with the same token. No alternate generic Meta edge was found
// anywhere in this codebase or documented locally that can discover such a
// number automatically (see that audit's own report) — a manual,
// operator-supplied phoneNumberId is the only generic (non-hardcoded,
// works-for-any-org) way to reach it.
//
// This function is the ONLY thing that makes a manually-entered id
// trustworthy enough to treat as a real candidate: it re-derives every
// field from Meta's own live response using the org's OWN already-granted
// pending-selection access token — never from anything the browser claims
// about the number. See netlify/functions/meta-whatsapp-validate-number.ts
// for the endpoint that calls this.
export type PhoneNodeValidation =
  | {
      ok: true;
      phoneNumberId: string;
      displayPhoneNumber: string;
      verifiedName: string | null;
      codeVerificationStatus: string | null;
      platformType: string;
      qualityRating: string | null;
    }
  | { ok: false; reason: string };

/**
 * Validates that `phoneNumberId` is a real, accessible WhatsApp Cloud API
 * phone-number node for the given access token — a direct-by-id Graph
 * read, not an enumeration. Fails closed on any Meta error, an id
 * mismatch, a missing display_phone_number, or any platform_type other
 * than exactly "CLOUD_API" (rejects ON_PREMISE and anything unrecognized —
 * this is precisely the signal that distinguishes a healthy Cloud API
 * number from a stale on-premise one in the case this fallback exists
 * for). Never throws; a network failure is reported the same way any other
 * validation failure is, through the discriminated return type.
 */
export async function validateWhatsAppPhoneNumberId(
  accessToken: string,
  phoneNumberId: string,
): Promise<PhoneNodeValidation> {
  let body: any;
  try {
    body = await fetchJson(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}` +
        `?fields=id,display_phone_number,verified_name,code_verification_status,platform_type,quality_rating` +
        `&access_token=${encodeURIComponent(accessToken)}`,
    );
  } catch (e) {
    console.warn("[meta-whatsapp-candidates] manual phone validation request failed:", e);
    return { ok: false, reason: "Could not reach Meta to verify this phone number." };
  }

  // Graph returns errors as a 200 with an `error` object for some node
  // reads, and as non-2xx for others — fetchJson() above never inspects
  // res.ok, so both shapes are checked here. Never surface Meta's raw
  // error object to the caller (may contain fbtrace_id or other internal
  // detail) — only a safe, generic reason string.
  if (body?.error) {
    return { ok: false, reason: "Meta could not find or authorize access to this phone number." };
  }
  if (typeof body?.id !== "string" || body.id !== phoneNumberId) {
    return { ok: false, reason: "Meta returned a different result than requested." };
  }
  if (typeof body?.display_phone_number !== "string" || !body.display_phone_number) {
    return { ok: false, reason: "This does not appear to be a WhatsApp phone number." };
  }
  if (typeof body?.platform_type !== "string" || body.platform_type !== "CLOUD_API") {
    return { ok: false, reason: "This phone number is not on WhatsApp Cloud API." };
  }

  return {
    ok: true,
    phoneNumberId: body.id,
    displayPhoneNumber: body.display_phone_number,
    verifiedName: typeof body.verified_name === "string" ? body.verified_name : null,
    codeVerificationStatus: typeof body.code_verification_status === "string" ? body.code_verification_status : null,
    platformType: body.platform_type,
    qualityRating: typeof body.quality_rating === "string" ? body.quality_rating : null,
  };
}
