// netlify/functions/lib/meta-avatar-url.ts
//
// Tiny, pure helper shared by meta-messenger-crm.ts / meta-instagram-crm.ts
// only — no network calls, no Supabase Storage, no caching/proxying of any
// kind. Used solely to decide whether an already-stored `contacts.avatar_url`
// that points at a Meta CDN URL is worth asking Meta to refresh, so profile
// enrichment can repair a genuinely stale avatar on a later inbound message
// even for a contact whose name is already real (see the callers' own
// enrichment condition). The frontend's ContactAvatar component remains
// solely responsible for gracefully falling back when a stored URL — Meta
// CDN or otherwise — later 403s/404s; this helper only decides whether it's
// worth asking Meta for a new one.
//
// IMPORTANT — this is deliberately NOT "is this URL Meta-hosted?" alone.
// An earlier version of this helper (isMetaCdnAvatarUrl) treated every Meta
// CDN URL as needing a refresh, which meant that even a URL Meta had *just*
// returned a moment ago (still Meta-hosted, obviously) kept tripping the
// same condition on every subsequent inbound message — an unbounded Graph
// API call per message, forever. A freshly returned Meta profile picture
// URL does NOT become a "non-Meta" URL; it's still hosted on fbcdn.net/
// cdninstagram.com. What changes is whether THIS PARTICULAR URL is expired
// or close to it, which is what shouldRefreshMetaAvatar actually checks —
// so a freshly refreshed URL (new, far-future expiry) correctly evaluates
// to "no refresh needed" on the very next message, while a genuinely
// stale/near-expiry one still gets repaired.

// Known Meta-hosted CDN root domains for profile pictures (Facebook/
// Messenger and Instagram both serve these from the same CDN family).
// Matched as an exact hostname or a subdomain of one of these roots — e.g.
// "scontent.fna.fbcdn.net" and "instagram.flhr1-1.fna.fbcdn.net" both match
// the "fbcdn.net" root. Deliberately a narrow allowlist of known root
// domains, not a substring/contains check on the raw URL string, so it can
// only ever recognize genuine Meta CDN URLs — never a false positive on
// some other host that merely mentions "fbcdn" somewhere in its name.
const META_CDN_ROOT_DOMAINS = ["fbcdn.net", "cdninstagram.com"];

/**
 * True only for a URL whose hostname is a known Meta/Instagram CDN host
 * (fbcdn.net / cdninstagram.com and their subdomains). Never throws; an
 * unparseable/empty URL safely returns false. This says nothing about
 * whether the URL is still valid — use shouldRefreshMetaAvatar for that.
 */
export function isMetaCdnAvatarUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return META_CDN_ROOT_DOMAINS.some(
    (root) => hostname === root || hostname.endsWith(`.${root}`),
  );
}

// Meta's signed CDN media URLs (the same scheme used for Facebook/
// Instagram profile pictures and other media) commonly carry an `oe` query
// parameter: a hex-encoded Unix timestamp (seconds since epoch) marking
// when the signed URL expires. Not every Meta CDN URL is guaranteed to
// carry one (format can vary by product/endpoint/CDN edge), so this is
// read defensively — a missing or malformed value means "can't tell",
// never "assume expired" or "assume valid".
const OE_PARAM = "oe";

// Refresh proactively a little before the actual expiry instant, not only
// after it's already broken — small enough to avoid meaningfully
// increasing Graph traffic, large enough to absorb clock drift and the
// time between "we decided to refresh" and "the browser actually loads
// the image".
const EXPIRY_SAFETY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Sanity bound for a decoded `oe` timestamp: Meta's signed CDN URLs expire
// within days, never decades. Rejects a value that decodes to something
// implausible as an expiry timestamp (e.g. a hex string that happens to be
// present for an unrelated reason) rather than trusting it blindly.
const PLAUSIBLE_WINDOW_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years

/**
 * Attempts to read a Meta CDN URL's `oe` expiry parameter and decode it to
 * a millisecond epoch timestamp. Returns null (never throws) whenever the
 * value is absent, non-hex, or decodes to something outside a plausible
 * range — "can't reliably determine expiry" is always represented as null,
 * never guessed at.
 */
function readMetaCdnExpiryMs(url: string): number | null {
  let oe: string | null;
  try {
    oe = new URL(url).searchParams.get(OE_PARAM);
  } catch {
    return null;
  }
  if (!oe || !/^[0-9a-fA-F]+$/.test(oe)) return null;

  const seconds = parseInt(oe, 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const ms = seconds * 1000;
  const now = Date.now();
  if (ms < now - PLAUSIBLE_WINDOW_MS || ms > now + PLAUSIBLE_WINDOW_MS) return null;

  return ms;
}

/**
 * True only when `url` is a Meta CDN avatar URL that is ALREADY expired or
 * expiring within a small safety window — never merely because it's
 * Meta-hosted. A non-Meta URL, a null/empty URL, or a Meta URL whose
 * expiry can't be reliably decoded all return false (fail closed): this
 * deliberately avoids firing a Graph API profile lookup on every inbound
 * message just because we can't prove the current avatar is still good —
 * the existing frontend ContactAvatar fallback already covers that case
 * gracefully on the rare occasion the URL turns out to be stale anyway.
 */
export function shouldRefreshMetaAvatar(url: string | null | undefined): boolean {
  if (!isMetaCdnAvatarUrl(url)) return false;
  const expiryMs = readMetaCdnExpiryMs(url as string);
  if (expiryMs === null) return false;
  return expiryMs <= Date.now() + EXPIRY_SAFETY_WINDOW_MS;
}
