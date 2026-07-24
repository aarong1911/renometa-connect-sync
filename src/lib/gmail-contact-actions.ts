// src/lib/gmail-contact-actions.ts
//
// Manual conversion actions for an unmatched Gmail sender in Conversations:
// Create Contact, Create Lead (with dedupe), Link to Existing Contact.
// Nothing here runs automatically — every function is only ever called
// from an explicit user action in inbox.tsx. Gmail sync
// (netlify/functions/gmail-sync.ts) is untouched and never creates
// contacts or leads.
//
// Why not just call addLead()/leads-store.ts's built-in contact upsert:
// that upsert dedupes contacts by (org_id, phone) only. Gmail senders
// usually have no phone at all, so relying on it here would silently
// create a duplicate contact on every "Create Lead" click instead of
// reusing the one already on file for that email — this file does its own
// email-based lookup first specifically to avoid that.

import { supabase } from "@/lib/supabase";
import { addContact, upsertContactFromRow, getOrgId } from "@/lib/contacts-store";
import { refreshLeads } from "@/lib/leads-store";
import { normalizeEmail } from "@/lib/gmail-conversations";
import { setGmailContactLink, unlinkGmailContact } from "@/lib/conversation-states";
import type { Contact } from "@/lib/mock-data";

export { normalizeEmail };

/** Finds an existing org contact by normalized email, or null. Never creates anything. */
export async function findContactByEmail(orgId: string, email: string): Promise<Contact | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("org_id", orgId)
    .ilike("email", norm)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[gmail-contact-actions] findContactByEmail failed:", error.message);
    return null;
  }
  if (!data) return null;
  return upsertContactFromRow(data);
}

/** True if the given contact already has at least one lead row. */
async function contactHasLead(contactId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId);
  if (error) {
    console.error("[gmail-contact-actions] contactHasLead check failed:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

// ── Sender display-name resolution (Create Contact / Create Lead prefill) ──
//
// Priority order, per spec:
//   1. The actual display name parsed from the Gmail From header (e.g.
//      "Jane Doe" from "Jane Doe <jane@x.com>" — genuinely present in the
//      header, not fabricated; this is also correctly "Google" for a
//      message that really is From: "Google <no-reply@accounts.google.com>",
//      since that IS the sender).
//   2. The Gmail conversation's own already-resolved display name — but
//      ONLY if it's a real name, not just gmail-conversations.ts's own
//      bare-address or "Unknown Sender" fallback repeated back at us
//      (guarded against below), otherwise this would be indistinguishable
//      from tier 1 in the unmatched-sender case this is used for.
//   3. The email's local-part (before @), cleaned into readable words —
//      e.g. "alerts@example.com" -> "Alerts", "no-reply@x.com" -> "No Reply".
//   4. Empty string. Never a hardcoded label like "Customer" or the Gmail
//      provider name.

/** "no-reply" -> "No Reply", "alerts" -> "Alerts", "" -> "". */
export function localPartToWords(email: string): string {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  if (!local) return "";
  return local
    .replace(/[._+-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function resolveGmailSenderName(input: {
  parsedDisplayName?: string | null;
  conversationName?: string | null;
  email: string;
}): string {
  const parsed = input.parsedDisplayName?.trim();
  if (parsed) return parsed;

  const conv = input.conversationName?.trim();
  const emailNorm = normalizeEmail(input.email);
  if (conv && conv.toLowerCase() !== emailNorm && conv !== "Unknown Sender") {
    return conv;
  }

  const cleaned = localPartToWords(input.email);
  if (cleaned) return cleaned;

  return "";
}

export type CreateContactFromGmailInput = {
  name: string;
  email: string;
};

/** Creates a new contact for an unmatched Gmail sender. Caller is responsible for checking findContactByEmail first if dedupe matters. Refuses to create a contact with no usable email. */
export async function createContactFromGmailSender(input: CreateContactFromGmailInput): Promise<Contact | null> {
  const norm = normalizeEmail(input.email);
  if (!norm) {
    console.error("[gmail-contact-actions] createContactFromGmailSender called with no usable email");
    return null;
  }
  return addContact(
    {
      // The displayed/typed name may retain its original casing (e.g. "Jane
      // Doe") — only the email is normalized, per storage requirements.
      name: input.name || norm,
      email: norm,
      phone: "",
      company: "",
      address: "",
      tags: [],
      owner: "—",
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
    { source: "gmail" },
  );
}

export type CreateLeadFromGmailInput = {
  name: string;
  email: string;
  subject?: string;
  snippet?: string;
};

export type CreateLeadFromGmailResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; reason: string }
  | { ok: false; error: string };

/**
 * Creates a lead for an unmatched Gmail sender, reusing an existing contact
 * by email when one exists rather than creating a duplicate. Blocks with
 * `duplicate: true` if that contact already has a lead — never creates a
 * second lead for the same person.
 */
export async function createLeadFromGmailSender(input: CreateLeadFromGmailInput): Promise<CreateLeadFromGmailResult> {
  const orgId = await getOrgId();
  if (!orgId) return { ok: false, error: "No organization found" };

  const norm = normalizeEmail(input.email);
  if (!norm) return { ok: false, error: "This sender has no usable email address" };

  let contact = await findContactByEmail(orgId, norm);
  if (contact) {
    const hasLead = await contactHasLead(contact.id);
    if (hasLead) {
      return { ok: true, duplicate: true, reason: `A lead already exists for ${norm}` };
    }
  } else {
    contact = await createContactFromGmailSender({ name: input.name, email: norm });
    if (!contact) return { ok: false, error: "Could not create a contact for this lead" };
  }

  const notes = [input.subject, input.snippet].filter(Boolean).join("\n\n") || null;

  const { error: insertError } = await supabase.from("leads").insert({
    org_id: orgId,
    contact_id: contact.id,
    source: "Gmail",
    status: "new",
    estimated_value: 0,
    notes,
  });
  if (insertError) {
    console.error("[gmail-contact-actions] lead insert failed:", insertError.message);
    return { ok: false, error: "Could not create the lead" };
  }

  await refreshLeads();
  return { ok: true, duplicate: false };
}

export type LinkContactResult = { ok: true } | { ok: false; error: string };

/**
 * Links an existing contact to a Gmail thread. This is purely an explicit
 * conversation_states.contact_id relationship for this thread's
 * external_conversation_key — contacts.email (or any other contact field)
 * is never read or written here. Safe to call again later with a
 * different contact to change the link, and preserves whatever archive
 * state that conversation_states row already has.
 */
export async function linkExistingContactToGmailSender(conv: { id: string; channel: string }, contact: Contact): Promise<LinkContactResult> {
  if (conv.channel !== "email") return { ok: false, error: "Linking is only available for Gmail conversations" };
  try {
    await setGmailContactLink(conv.id, contact.id);
    return { ok: true };
  } catch (err: any) {
    console.error("[gmail-contact-actions] link failed:", err.message);
    return { ok: false, error: "Could not link this contact" };
  }
}

export type UnlinkContactResult = { ok: true; hadLink: boolean } | { ok: false; error: string };

/** Removes the explicit contact link for a Gmail thread (contact_id -> null), preserving its archive state. `hadLink: false` means there was nothing explicit to remove (the thread may still show a contact if it matches one by email — see gmail-conversations.ts's resolution order). */
export async function unlinkGmailContactFromThread(conv: { id: string; channel: string }): Promise<UnlinkContactResult> {
  if (conv.channel !== "email") return { ok: false, error: "Unlinking is only available for Gmail conversations" };
  try {
    const hadLink = await unlinkGmailContact(conv.id);
    return { ok: true, hadLink };
  } catch (err: any) {
    console.error("[gmail-contact-actions] unlink failed:", err.message);
    return { ok: false, error: "Could not unlink this contact" };
  }
}

// ── Automatic lead creation — inert, not wired up anywhere yet ─────────────
//
// Prepares the code structure for a future "auto-create leads from Gmail"
// setting. Nothing calls isLikelySystemSender or
// shouldAutoCreateLeadFromGmailThread today — Gmail sync stays read-only
// with respect to contacts/leads, and every conversion in this pass is
// manual (the three functions above, invoked only from explicit button
// clicks in inbox.tsx). When a real setting is added later, gate it on
// this check first.

const SYSTEM_SENDER_PATTERNS: RegExp[] = [
  /no-?reply/i,
  /mailer-daemon/i,
  /\bnotifications?\b/i,
  /\breceipts?\b/i,
  /\bnewsletters?\b/i,
  /\bpromo(tions?)?\b/i,
  /\balerts?\b/i,
  /security-noreply@google\.com/i,
  /accounts-noreply@google\.com/i,
];

/** True if this address looks like a system/automated sender rather than a real person — for future auto-lead gating only, not used to block manual conversion. */
export function isLikelySystemSender(email: string): boolean {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return SYSTEM_SENDER_PATTERNS.some((re) => re.test(norm));
}

/**
 * Stub for a future "auto-create leads from Gmail" setting. Always returns
 * false today — not called from anywhere. When that setting exists, wire
 * it in as: `settingEnabled && shouldAutoCreateLeadFromGmailThread(senderEmail)`.
 */
export function shouldAutoCreateLeadFromGmailThread(senderEmail: string): boolean {
  if (isLikelySystemSender(senderEmail)) return false;
  return false;
}
