// src/components/inbox/gmail-sender-avatar.tsx
//
// Avatar for a Gmail conversation. Deliberately NOT ContactAvatar when the
// sender isn't a saved contact — showing the same illustrated
// contact-style avatar for e.g. a Capital One notification or a random
// newsletter makes it look like a real CRM contact, which is misleading.
//
// Priority for an unmatched sender:
//   1. The sender's domain favicon/logo (fetched live each render — no
//      logo files are ever stored in the DB)
//   2. Two-letter initials derived from the sender's display name, or the
//      email local-part if there's no usable display name
//   3. A generic email icon, only if neither of the above produced
//      anything at all
//
// Logo source: no company-logo/favicon utility already existed in this
// repo (checked first). Uses Google's public favicon-fetching endpoint
// (`https://www.google.com/s2/favicons`) — free, no API key, no paid
// dependency. Tradeoffs, documented per requirement:
//   - Privacy: the sender's email domain is sent to Google's servers on
//     every render (not the full email address, and not stored by us).
//   - Reliability: this is a public, undocumented Google endpoint, not a
//     supported API — no uptime/format guarantee. It also typically
//     returns SOME image (often a generic globe icon) even for domains
//     with no real favicon, rather than a hard 404 — so in practice the
//     "fall back to initials" path mainly triggers on genuine network/
//     load failures, not on "logo exists but is generic." Radix's Avatar
//     primitive (used here via the existing AvatarImage/AvatarFallback
//     components) already only swaps in the image once it has *loaded
//     successfully*, and shows the Fallback the rest of the time — so
//     load failures fall back to initials with no extra state needed here.

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

  // Beyond the specific mail-infra prefixes above: favicons are registered
  // against the registrable domain, not an arbitrary subdomain — e.g.
  // accounts.google.com has no favicon of its own, but google.com does.
  // Reducing to the last two labels is a safe general heuristic for this
  // narrow purpose (logo lookup only — never used for matching/display).
  const labels = domain.split(".").filter(Boolean);
  if (labels.length > 2) domain = labels.slice(-2).join(".");

  return domain || null;
}

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
  if (matchedContactId && UUID_RE.test(matchedContactId)) {
    return <ContactAvatar id={matchedContactId} name={senderName} size={size} className={className} />;
  }

  const domain = senderEmail ? domainForLogo(senderEmail) : null;
  const initials = deriveSenderInitials(senderName, senderEmail);

  return (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
      {domain && (
        <AvatarImage
          src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`}
          alt=""
        />
      )}
      <AvatarFallback className="bg-secondary text-[10px] font-semibold text-muted-foreground">
        {initials || <Mail className="h-3.5 w-3.5" />}
      </AvatarFallback>
    </Avatar>
  );
}
