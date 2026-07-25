// src/lib/gmail-conversations.ts
//
// Real email history for the Inbox's Conversations view, sourced from
// gmail_messages (see CLAUDE.md — no gmail-sync.ts function exists in this
// repo despite ~120 real rows already present; whatever populated the table
// is external to this codebase). Follows the same shape/pattern as
// voice-conversations.ts and sms-meta-conversations.ts: fetch → batch-match
// contacts → group into Conversation/Message entries.
//
// Two things make this table different from sms_meta_messages:
//  - No body/body_html column, only `snippet` (a short preview). We never
//    fabricate a longer body — `snippet` (optionally prefixed with the
//    subject) is genuinely all there is to show.
//  - No direction column — direction is derived from `labels`: a row with
//    the "SENT" label was sent by this org, anything else is inbound.
//  - No org-scoped "our own address" to compare against (organizations.
//    integration_settings.gmail is null for every sampled org), so the
//    SENT label is the only reliable signal, not an address comparison.
//
// Grouped by thread_id (one conversation per Gmail thread) rather than by
// contact. Contact resolution order per thread:
//   1. An explicit conversation_states.contact_id link for this thread
//      (set via "Link to Existing Contact" in inbox.tsx — see
//      src/lib/conversation-states.ts's setGmailContactLink/
//      unlinkGmailContact — never by mutating contacts.email)
//   2. An exact normalized contacts.email match against the *other*
//      party's address on the thread (whichever of from/to isn't our own
//      org's send, approximated by "the address side that isn't on the
//      SENT-labeled rows")
//   3. Unmatched-sender fallback (synthetic `gmail-unknown-<address>` id)

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { Conversation, Message } from "@/lib/mock-data";
import { getOrgId } from "@/lib/org-id";

export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

// ── Timestamp parsing ───────────────────────────────────────────────────
//
// gmail_messages.internal_date is a `timestamp with time zone` column, so
// anything actually stored there is Postgres-valid (confirmed against live
// data: mostly ISO-ish timestamptz strings). But the Gmail API's own
// message.internalDate — what any Gmail-sync writer starts from — is
// documented as a Unix ms timestamp represented AS A STRING, and
// `new Date("1784869200000")` (a bare numeric string) is `Invalid Date` in
// JS, NOT parsed as an epoch — confirmed directly:
//   new Date("1784869200000") -> Invalid Date
//   new Date(1784869200000)   -> a real 2026 date
// so any code path that ever forwards a raw numeric string without
// converting it to a Number first silently breaks. Live data also has 3
// rows (a different org, an earlier/other sync pass) with
// internal_date = "1969-12-31T23:59:59+00:00" — a valid-looking but
// obviously wrong near-epoch-zero value — confirming this table has seen
// genuinely malformed timestamps before. This parser is defensive against
// all of that, not just what's in the table today.
function parseGmailTimestamp(internalDate: unknown, createdAt: unknown): string {
  const fromInternal = parseTimestampValue(internalDate);
  if (fromInternal) return fromInternal;

  const fromCreated = parseTimestampValue(createdAt);
  if (fromCreated) {
    if (import.meta.env.DEV) {
      console.warn("[gmail-conversations] internal_date missing/invalid, falling back to created_at:", internalDate);
    }
    return fromCreated;
  }

  if (import.meta.env.DEV) {
    console.warn("[gmail-conversations] both internal_date and created_at missing/invalid — using epoch fallback:", { internalDate, createdAt });
  }
  // A stable, obviously-old fallback — never Date.now()/new Date(), which
  // would make a message with no valid timestamp at all masquerade as
  // brand new.
  return new Date(0).toISOString();
}

function parseTimestampValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;

  let ms: number | null = null;

  if (typeof value === "number") {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      // A bare integer string — Gmail's raw message.internalDate shape (ms),
      // or conceivably a seconds-based value. `new Date(numericString)`
      // would be Invalid Date, so this must go through Number() first.
      const n = Number(trimmed);
      ms = Math.abs(n) < 1e12 ? n * 1000 : n;
    } else {
      // ISO timestamp, or a Postgres "timestamp with time zone" string
      // (e.g. "2026-07-24T15:53:55+00:00") — both parse directly.
      const parsed = new Date(trimmed);
      ms = Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
    }
  }

  if (ms === null) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ── HTML entity decoding ────────────────────────────────────────────────
//
// Gmail subjects/snippets can arrive HTML-entity-encoded (e.g. "&#39;" for
// an apostrophe). No decoder utility existed anywhere in this repo
// (checked first) — this is a small, safe, string-only decoder: it only
// ever substitutes a recognized entity with its literal character, never
// parses/renders HTML, so there's no risk of injecting markup.
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isNaN(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_HTML_ENTITIES[entity] ?? match;
  });
}

// from_email/to_emails can be a bare address or "Name <addr@x.com>" —
// pull out just the address, normalized (trimmed + lowercased) for
// matching/identity purposes (contactByEmail lookups, synthetic
// gmail-unknown-<address> ids — these must stay case-insensitive and
// stable regardless of how a given message happened to capitalize the
// address).
function extractAddress(raw: string | null | undefined): string {
  return normalizeEmail(extractRawAddress(raw));
}

// Same extraction, but WITHOUT forcing lowercase — preserves the address
// exactly as Gmail sent it, for display/prefill purposes only (see
// Conversation.senderEmail below). Never use this for matching/lookups.
function extractRawAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim();
}

// Companion to extractAddress — pulls the display-name portion of
// "Name <addr@x.com>" when present (trimmed, quotes stripped), so an
// unmatched sender can show a real name instead of a bare email address.
// Returns null for a bare address with no display name.
function extractDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

function firstToAddress(toEmails: unknown): string {
  if (Array.isArray(toEmails) && toEmails.length > 0) return extractAddress(String(toEmails[0]));
  if (typeof toEmails === "string" && toEmails) return extractAddress(toEmails.split(",")[0]);
  return "";
}

function firstToAddressRaw(toEmails: unknown): string {
  if (Array.isArray(toEmails) && toEmails.length > 0) return extractRawAddress(String(toEmails[0]));
  if (typeof toEmails === "string" && toEmails) return extractRawAddress(toEmails.split(",")[0]);
  return "";
}

export function useGmailConversations(): {
  conversations: Conversation[];
  messages: Message[];
  loading: boolean;
  refresh: () => void;
} {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("gmail_messages")
      .select("id, thread_id, internal_date, snippet, from_email, to_emails, subject, labels, created_at, rfc_message_id")
      .eq("org_id", orgId)
      .order("internal_date", { ascending: true })
      .limit(2000);

    if (error) {
      console.error("[gmail-conversations] fetch failed:", error);
      setLoading(false);
      return;
    }

    if (!data || data.length === 0) {
      setConversations([]);
      setMessages([]);
      setLoading(false);
      return;
    }

    // Batch-fetch ALL org contacts (not just ones with an email) — needed
    // both for the email-match path and to resolve an explicit
    // conversation_states.contact_id link to a display name below.
    const { data: allContacts } = await supabase
      .from("contacts")
      .select("id, full_name, email")
      .eq("org_id", orgId);

    const contactById: Record<string, { id: string; name: string; email: string }> = {};
    const contactByEmail: Record<string, { id: string; name: string; email: string }> = {};
    for (const c of allContacts ?? []) {
      const entry = { id: c.id, name: (c as any).full_name ?? "", email: (c as any).email ?? "" };
      contactById[c.id] = entry;
      const norm = normalizeEmail((c as any).email);
      if (norm) contactByEmail[norm] = entry;
    }

    // Explicit thread ↔ contact links (see src/lib/conversation-states.ts —
    // set via "Link to Existing Contact", never by mutating contacts.email).
    // These take priority over the email match below.
    const { data: linkRows } = await supabase
      .from("conversation_states")
      .select("external_conversation_key, contact_id")
      .eq("org_id", orgId)
      .eq("channel", "email")
      .not("contact_id", "is", null)
      .not("external_conversation_key", "is", null);

    const explicitContactByExternalKey: Record<string, string> = {};
    for (const row of (linkRows ?? []) as any[]) {
      if (row.external_conversation_key && row.contact_id) {
        explicitContactByExternalKey[row.external_conversation_key] = row.contact_id;
      }
    }

    // Group rows by thread_id — one conversation per Gmail thread.
    const groups = new Map<string, any[]>();
    for (const row of data as any[]) {
      const key = row.thread_id || `gmail-no-thread-${row.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const convs: Conversation[] = [];
    const msgs: Message[] = [];

    for (const [threadId, groupRows] of groups) {
      // Parse once per row, then sort oldest -> newest by the PARSED value
      // — not by relying on the SQL query's ordering of the raw column, so
      // thread order stays correct even for a row whose raw internal_date
      // needed the fallback/defensive handling in parseGmailTimestamp.
      const rows = [...groupRows].sort(
        (a, b) => new Date(parseGmailTimestamp(a.internal_date, a.created_at)).getTime()
          - new Date(parseGmailTimestamp(b.internal_date, b.created_at)).getTime(),
      );

      // Direction per row: SENT label present = outbound (from us).
      const isOutbound = (row: any) => Array.isArray(row.labels) && row.labels.includes("SENT");

      // The "other party" address for this thread: on an outbound row, it's
      // the recipient; on an inbound row, it's the sender. Prefer the
      // address from an inbound row if one exists (the actual lead/contact),
      // falling back to the first recipient of an outbound-only thread.
      const inboundRow = rows.find((r) => !isOutbound(r));
      const otherAddress = inboundRow
        ? extractAddress(inboundRow.from_email)
        : firstToAddress(rows[0]?.to_emails);
      // Same address, case preserved — for display/prefill only (see
      // Conversation.senderEmail below). Never used for matching.
      const otherAddressRaw = inboundRow
        ? extractRawAddress(inboundRow.from_email)
        : firstToAddressRaw(rows[0]?.to_emails);

      // Contact resolution order: (1) an explicit conversation_states link
      // for this thread, (2) an exact normalized contacts.email match, (3)
      // the unmatched-sender fallback. Priority 1 lets a manually-linked
      // contact stick even if the sender's address never appears on any
      // contact's email field.
      const externalKey = `gmail:${threadId}`;
      const explicitContactId = explicitContactByExternalKey[externalKey];
      const matchedContact = (explicitContactId ? contactById[explicitContactId] : undefined)
        ?? (otherAddress ? contactByEmail[otherAddress] : undefined);
      const contactId = matchedContact?.id ?? (otherAddress ? `gmail-unknown-${otherAddress}` : `gmail-unknown-thread-${threadId}`);
      // Prefer the real contact's saved name, then the Gmail display name
      // (e.g. "Jane Doe" from "Jane Doe <jane@x.com>" — see
      // extractDisplayName), then fall back to the bare address.
      const displayName = inboundRow ? extractDisplayName(inboundRow.from_email) : null;
      const contactName = matchedContact?.name || displayName || otherAddress || "Unknown Sender";

      // The newest row after the explicit oldest->newest sort above — the
      // actual most-recent message in the thread, not just "whatever the
      // DB query happened to return last."
      const newestRow = rows[rows.length - 1];
      const convId = `gm-${threadId}`;
      const lastAt = parseGmailTimestamp(newestRow?.internal_date, newestRow?.created_at);
      const previewRaw = newestRow?.snippet?.slice(0, 80) ?? newestRow?.subject ?? "";

      convs.push({
        id: convId,
        contactId,
        contactName,
        channel: "email",
        preview: decodeHtmlEntities(previewRaw),
        unread: false,
        lastAt,
        // Case-PRESERVED address (not lowercased) — this is what Create
        // Contact/Create Lead show and prefill; normalization only happens
        // at match/storage time (see gmail-contact-actions.ts). Matching
        // itself (contactByEmail, gmail-unknown-<address> ids) still uses
        // the normalized `otherAddress` above.
        senderEmail: otherAddressRaw || otherAddress || undefined,
        // The Gmail From header's display-name portion, parsed directly
        // (e.g. "Jane Doe" from "Jane Doe <jane@x.com>", or "Google" from
        // "Google <no-reply@accounts.google.com>" — both genuinely present
        // in the raw header, not fabricated). Used as the first-priority
        // Create Contact/Lead name — see resolveGmailSenderName in
        // gmail-contact-actions.ts. null when the header has no display
        // name (a bare address).
        senderDisplayName: displayName ?? undefined,
        // Real Subject header from the newest message, decoded — used to
        // prefill "Re: <subject>" when replying to this thread. Never a
        // fabricated/generic subject.
        emailSubject: newestRow?.subject ? decodeHtmlEntities(newestRow.subject) : undefined,
      });

      for (const row of rows) {
        // No body/body_html column exists on this table — snippet plus
        // subject (when present and not already implied) is genuinely all
        // there is; never invent a longer body than what's actually stored.
        const subject = row.subject ? decodeHtmlEntities(row.subject) : row.subject;
        const snippet = row.snippet ? decodeHtmlEntities(row.snippet) : row.snippet;
        const body = subject && snippet && !snippet.startsWith(subject)
          ? `${subject}\n\n${snippet}`
          : (snippet ?? subject ?? "");

        msgs.push({
          id: `gm-msg-${row.id}`,
          conversationId: convId,
          channel: "email",
          direction: isOutbound(row) ? "out" : "in",
          body,
          at: parseGmailTimestamp(row.internal_date, row.created_at),
          rfcMessageId: row.rfc_message_id ?? undefined,
        });
      }
    }

    // Newest thread first — using the same parsed lastAt every conversation
    // was just given above, not the raw column value.
    convs.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

    setConversations(convs);
    setMessages(msgs);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { conversations, messages, loading, refresh: fetchData };
}
