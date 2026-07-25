// src/components/inbox/gmail-sender-avatar.tsx
//
// Avatar for a Gmail conversation. Deliberately NOT ContactAvatar when the
// sender isn't a saved contact — showing the same illustrated
// contact-style avatar for e.g. a Capital One notification or a random
// newsletter makes it look like a real CRM contact, which is misleading.
//
// Priority for an unmatched sender:
//   1. The connected Gmail account's own Google profile photo, when the
//      sender IS that same account (see connectedAccountEmail/
//      connectedAccountPictureUrl below).
//   2. A logo — ONLY for a domain explicitly present in KNOWN_BRAND_DOMAINS
//      below (after resolving a known mail-infra alias, see
//      ALIAS_STRIP_PREFIXES). This is a strict allowlist, not "attempt
//      every domain once": an unrecognized domain never constructs a
//      favicon URL and never renders <AvatarImage>, so it can never cause a
//      network request (previously every unmatched sender's domain was
//      attempted once per session, which spammed the console with 404s for
//      arbitrary senders like "aimstel.com"/"dealnotes.ai").
//   3. Two-letter initials derived from the sender's display name, or the
//      email local-part if there's no usable display name.
//   4. A generic email icon, only if neither of the above produced
//      anything at all.
//
// Logo source: Google's public favicon-fetching endpoint —
// https://www.google.com/s2/favicons?domain=<domain>&sz=64 — free, no key,
// only ever sent one of the exact KNOWN_BRAND_DOMAINS values, never the
// full email address or an arbitrary/derived domain.
//
// Domain resolution — deliberately NOT a public-suffix/label-reduction
// algorithm. A prior version reduced any domain down to "last two labels"
// (with a small hardcoded exception list for compound suffixes like
// "co.uk"), which is unsafe: a ccTLD it didn't know about (e.g. "co.il")
// got mangled — "company.co.il" was reduced to the bare public suffix
// "co.il" and THAT got requested as a favicon domain. This version never
// reduces labels at all. It only ever strips one of a small fixed set of
// literal known mail-infrastructure subdomain prefixes (ALIAS_STRIP_PREFIXES
// — e.g. "email.claude.com" -> "claude.com", "accounts.google.com" ->
// "google.com") and then requires an EXACT match against
// KNOWN_BRAND_DOMAINS. Any domain that doesn't exactly match after that one
// optional strip — including "company.co.il", or any other domain not on
// the list — falls straight through to initials with zero network activity.

import { useState } from "react";
import { Mail } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { cn } from "@/lib/utils";
import { localPartToWords } from "@/lib/gmail-contact-actions";
import { extractReplyAddress } from "@/lib/composer-recipient";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIZE_CLASSES = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
} as const;

// The ONLY domains a logo will ever be requested for. Adding a brand here
// is the sole way to make its logo appear — there is no fallback path that
// attempts an unlisted domain.
const KNOWN_BRAND_DOMAINS = new Set([
  "google.com",
  "openai.com",
  "anthropic.com",
  "claude.com",
  "linkedin.com",
  "buffer.com",
  "playstation.com",
  "sony.com",
  "capitalone.com",
  "microsoft.com",
  "apple.com",
  "stripe.com",
  "skool.com",
  "investopedia.com",
  "verizon.com",
  "startengine.com",
  "schwab.com",
  // Added from real inbox sender domains (see gmail_messages.from_email) —
  // each is an unambiguous, recognizable brand's own root domain.
  "hostinger.com",
  "indeed.com",
  "redfin.com",
  "paypal.com",
  "wellsfargo.com",
  "zapier.com",
  "gusto.com",
  "quora.com",
  "supabase.com",
  "substack.com",
  "morningstar.com",
  "seekingalpha.com",
  "interactivebrokers.com",
  "aliexpress.com",
  "webull.com",
  "binance.us",
  "bluehost.com",
  "flippa.com",
  "gunbroker.com",
  "caseys.com",
  "acquire.com",
  "neon.tech",
]);

// A small, fixed set of literal (never wildcard, never label-counted) known
// mail-infrastructure subdomain prefixes that some of the brands above send
// from — e.g. "email.claude.com", "accounts.google.com",
// "notifications.linkedin.com", "email.openai.com", "info.hostinger.com",
// "notify.wellsfargo.com", "mail.redfin.com". Stripping one of these
// literal prefixes (at most once) is the only normalization performed
// before the exact KNOWN_BRAND_DOMAINS lookup; it is never applied
// generically to reduce an arbitrary domain's labels.
const ALIAS_STRIP_PREFIXES = [
  "email.", "mail.", "notifications.", "notification.",
  "communications.", "communication.", "accounts.", "noreply.", "no-reply.",
  "info.", "notify.", "customer.", "offers.", "marketing.", "notice.", "send.", "e.",
];

// Sender subdomains tied 1:1 to one specific brand where the subdomain
// itself isn't a generic, reusable mail-infra term (unlike "notify."/
// "marketing." above) — e.g. Indeed's job-alert and job-match senders.
// Explicit full-domain entries only; never pattern-matched.
const EXPLICIT_ALIAS_DOMAINS: Record<string, string> = {
  "jobalert.indeed.com": "indeed.com",
  "match.indeed.com": "indeed.com",
};

/**
 * Resolves a sender email down to a KNOWN_BRAND_DOMAINS member, or null if
 * it isn't one — never returns an arbitrary/derived domain. Null means "no
 * logo attempt, initials only, zero network request."
 */
function knownBrandDomainForLogo(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const rawDomain = email.slice(at + 1).trim().toLowerCase();
  if (!rawDomain) return null;

  if (KNOWN_BRAND_DOMAINS.has(rawDomain)) return rawDomain;
  if (EXPLICIT_ALIAS_DOMAINS[rawDomain]) return EXPLICIT_ALIAS_DOMAINS[rawDomain];

  for (const prefix of ALIAS_STRIP_PREFIXES) {
    if (rawDomain.startsWith(prefix)) {
      const stripped = rawDomain.slice(prefix.length);
      if (KNOWN_BRAND_DOMAINS.has(stripped)) return stripped;
      break; // only one strip attempt — never chain multiple prefixes
    }
  }

  return null;
}

// Session-lived (resets on page reload, not persisted anywhere) cache of
// logo load outcomes — bounded to KNOWN_BRAND_DOMAINS (at most ~17 entries)
// since unknown domains never reach this cache at all. Shared across every
// GmailSenderAvatar instance on the page so a known brand's logo that
// failed to load once isn't re-attempted by every row/instance.
const knownBrandLogoStatusCache = new Map<string, "success" | "failed">();

function initialsFromWords(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "Capital One" -> "CO", "ChatGPT" -> "CH", "Maker Zero: Claude Code, AI (Skool)" -> "MZ", "Google" -> "GO". Falls back to the email local part when there's no usable display name. */
export function deriveSenderInitials(senderName: string | undefined, senderEmail: string): string {
  const fromName = senderName?.trim() ? initialsFromWords(senderName.trim()) : "";
  if (fromName) return fromName;
  const localWords = senderEmail ? localPartToWords(senderEmail) : "";
  const fromLocal = localWords ? initialsFromWords(localWords) : "";
  return fromLocal;
}

export function GmailSenderAvatar({
  senderName,
  senderEmail,
  matchedContactId,
  connectedAccountEmail,
  connectedAccountPictureUrl,
  size = "sm",
  className,
}: {
  senderName: string;
  senderEmail: string;
  /** Real contacts.id when the sender matches or is explicitly linked to a saved contact — anything else (undefined, or a synthetic gmail-unknown-* id) gets the unmatched-sender treatment. */
  matchedContactId?: string | null;
  /** The org's own connected Gmail OAuth account address (see gmail-connection-status.ts) — used only to detect when a thread's sender IS that same account, so its real Google profile photo can be shown instead of a guessed domain logo/initials. Never used to fetch a photo for any OTHER address. */
  connectedAccountEmail?: string | null;
  /** The connected account's own Google profile photo URL, if one has been captured — a safe, non-secret URL only (see gmail-oauth-callback.ts). */
  connectedAccountPictureUrl?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  // Only used to re-render THIS instance if its own attempt just failed —
  // other instances/rows for the same domain read the shared cache fresh
  // on their own next render, they don't need to be poked.
  const [, setFailedTick] = useState(0);
  const [connectedPhotoFailed, setConnectedPhotoFailed] = useState(false);

  if (matchedContactId && UUID_RE.test(matchedContactId)) {
    return <ContactAvatar id={matchedContactId} name={senderName} size={size} className={className} />;
  }

  const initials = deriveSenderInitials(senderName, senderEmail);

  // Sender-is-the-connected-account case: compare normalized bare addresses
  // (never the raw "Name <addr>" form) so e.g. "Aaron G <aarong1911@gmail.com>"
  // matches a connected account email of "aarong1911@gmail.com".
  const normalizedSender = senderEmail ? extractReplyAddress(senderEmail)?.toLowerCase() ?? null : null;
  const normalizedConnected = connectedAccountEmail ? connectedAccountEmail.trim().toLowerCase() : null;
  const isConnectedAccount = !!normalizedSender && !!normalizedConnected && normalizedSender === normalizedConnected;

  if (isConnectedAccount && connectedAccountPictureUrl && !connectedPhotoFailed) {
    return (
      <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
        <AvatarImage
          src={connectedAccountPictureUrl}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === "error") setConnectedPhotoFailed(true);
          }}
        />
        <AvatarFallback className="bg-secondary text-[10px] font-semibold text-muted-foreground">
          {initials || <Mail className="h-3.5 w-3.5" />}
        </AvatarFallback>
      </Avatar>
    );
  }

  const domain = senderEmail ? knownBrandDomainForLogo(senderEmail) : null;
  const cachedStatus = domain ? knownBrandLogoStatusCache.get(domain) : undefined;
  const attemptLogo = !!domain && cachedStatus !== "failed";

  return (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
      {attemptLogo && (
        <AvatarImage
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain!)}&sz=64`}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              knownBrandLogoStatusCache.set(domain!, "failed");
              setFailedTick((n) => n + 1);
            } else if (status === "loaded") {
              knownBrandLogoStatusCache.set(domain!, "success");
            }
          }}
        />
      )}
      <AvatarFallback className="bg-secondary text-[10px] font-semibold text-muted-foreground">
        {initials || <Mail className="h-3.5 w-3.5" />}
      </AvatarFallback>
    </Avatar>
  );
}
