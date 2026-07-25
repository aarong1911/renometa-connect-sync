// src/components/inbox/gmail-sender-avatar.tsx
//
// Avatar for a Gmail conversation. Deliberately NOT ContactAvatar when the
// sender isn't a saved contact — showing the same illustrated
// contact-style avatar for e.g. a Capital One notification or a random
// newsletter makes it look like a real CRM contact, which is misleading.
//
// Priority for an unmatched sender:
//   1. A logo, attempted for the sender's normalized domain (see
//      domainForLogo) — every domain gets ONE attempt per browser session,
//      not just a hardcoded allowlist; KNOWN_LOGO_DOMAINS below is a
//      curated list of common senders confirmed to have a real favicon,
//      kept for documentation/clarity, not as a gate.
//   2. Two-letter initials derived from the sender's display name, or the
//      email local-part if there's no usable display name
//   3. A generic email icon, only if neither of the above produced
//      anything at all
//
// Logo source: no company-logo/favicon utility already existed in this
// repo (checked first). Uses Google's public favicon-fetching endpoint —
// https://www.google.com/s2/favicons?domain=<domain>&sz=64 — free, no key,
// no paid dependency, HTTPS, and only ever sent the bare normalized
// domain, never the full email address. This endpoint returns a generic
// fallback icon for most domains rather than a hard 404, but a genuine
// 404/network failure IS possible for some domains — handled by caching a
// per-domain success/failure result for the browser session (module-level
// Map, shared by every instance of this component: conversation list,
// thread header, right-side panel, unmatched-sender banner all look at the
// same cache), so a failing domain is requested at most once per session,
// never repeatedly on re-render or across rows.
//
// Domain normalization: strips known mail-infrastructure subdomains
// (email./mail./notifications./noreply.), then reduces to the
// registrable domain. No public-suffix-list dependency exists in this
// project and none was added solely for this (per instructions) — instead
// a small, non-exhaustive set of common multi-label suffixes
// (KNOWN_MULTI_LABEL_SUFFIXES) prevents mangling domains like
// "example.co.uk" or "example.com.au" down to just "co.uk"/"com.au". This
// isn't a complete public-suffix implementation, but for a display-only
// logo lookup the worst case on an unlisted compound suffix is just "no
// logo, initials fallback" — never anything incorrect or user-visible as
// broken.

import { useState } from "react";
import { Mail } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { cn } from "@/lib/utils";
import { localPartToWords } from "@/lib/gmail-contact-actions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIZE_CLASSES = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
} as const;

// Mail-infrastructure subdomains that don't carry their own brand favicon —
// stripped before resolving a logo so "noreply@email.openai.com" queries
// "openai.com", not a subdomain with no favicon of its own.
const STRIP_PREFIXES = ["email.", "mail.", "notifications.", "noreply."];

// Common two-label public suffixes — checked before reducing to "last two
// labels" so e.g. "news.example.co.uk" correctly becomes "example.co.uk",
// not "co.uk". Deliberately small; see file header for why.
const KNOWN_MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "co.jp", "co.in", "co.za", "co.id",
  "com.br", "com.mx", "com.co", "com.sg", "com.hk", "com.tw",
]);

// Curated list of common Gmail senders confirmed to have a real,
// recognizable favicon — documentation of what this feature is expected to
// cover well. NOT a gate: any other normalized domain is still attempted
// once (see domainForLogo/the session cache below), per requirement.
const KNOWN_LOGO_DOMAINS = new Set([
  "claude.com",
  "anthropic.com",
  "linkedin.com",
  "buffer.com",
  "playstation.com",
  "sony.com",
  "investopedia.com",
  "verizon.com",
  "startengine.com",
  "schwab.com",
  "capitalone.com",
  "google.com",
  "openai.com",
  "skool.com",
  "microsoft.com",
  "apple.com",
  "stripe.com",
]);

function reduceToRegistrableDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return domain;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length > 2 && KNOWN_MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** Normalizes a sender email down to the domain used for logo lookup — never the full address. Null for an unusable address. */
function domainForLogo(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  let domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return null;

  for (const prefix of STRIP_PREFIXES) {
    if (domain.startsWith(prefix)) {
      domain = domain.slice(prefix.length);
      break;
    }
  }

  return reduceToRegistrableDomain(domain) || null;
}

// Session-lived (resets on page reload, per requirement — not persisted
// anywhere) cache of logo attempts, shared across every GmailSenderAvatar
// instance on the page. A domain already known to fail is never requested
// again; a domain already known to succeed doesn't need to be re-decided,
// though the browser's own HTTP cache handles the actual re-fetch cost.
const logoStatusCache = new Map<string, "success" | "failed">();

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
  size = "sm",
  className,
}: {
  senderName: string;
  senderEmail: string;
  /** Real contacts.id when the sender matches or is explicitly linked to a saved contact — anything else (undefined, or a synthetic gmail-unknown-* id) gets the unmatched-sender treatment. */
  matchedContactId?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  // Only used to re-render THIS instance if its own attempt just failed —
  // other instances/rows for the same domain read the shared cache fresh
  // on their own next render, they don't need to be poked.
  const [, setFailedTick] = useState(0);

  if (matchedContactId && UUID_RE.test(matchedContactId)) {
    return <ContactAvatar id={matchedContactId} name={senderName} size={size} className={className} />;
  }

  const domain = senderEmail ? domainForLogo(senderEmail) : null;
  const initials = deriveSenderInitials(senderName, senderEmail);
  const cachedStatus = domain ? logoStatusCache.get(domain) : undefined;
  const attemptLogo = !!domain && cachedStatus !== "failed";

  return (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
      {attemptLogo && (
        <AvatarImage
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain!)}&sz=64`}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              logoStatusCache.set(domain!, "failed");
              setFailedTick((n) => n + 1);
            } else if (status === "loaded") {
              logoStatusCache.set(domain!, "success");
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
