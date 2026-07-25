// src/lib/composer-recipient.ts
//
// Resolves the actual outbound "to" address/identifier for the
// Conversations composer, per channel. The critical distinction is for
// email: an EXISTING Gmail thread must reply to the thread's own sender
// address — never the CRM contact record's email — even when that thread
// is linked to a contact. Linking a Gmail thread to a contact
// (conversation_states.contact_id, see conversation-states.ts) is CRM
// metadata only; it was never meant to, and must never, redirect where a
// reply actually goes. A brand-new email conversation (not yet backed by
// any real Gmail thread) has no sender address to reply to at all, so it
// correctly still requires an explicit contact email.

export type ComposerRecipientChannel = "email" | "sms" | "whatsapp" | "messenger" | "instagram" | "note";

export type ComposerRecipientResult =
  | { ok: true; to: string }
  | { ok: false; error: string };

/** "Jason Smith <jason@example.com>" -> "jason@example.com"; a bare address passes through unchanged (trimmed). */
export function extractReplyAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  const address = (match ? match[1] : raw).trim();
  return address || null;
}

export function resolveComposerRecipient(input: {
  composeChannel: ComposerRecipientChannel;
  /** The active conversation — its own `channel`/`id`/`senderEmail`, independent of any linked contact. */
  activeConversation: { id: string; channel: string; senderEmail?: string; contactName: string } | null | undefined;
  /** The (possibly linked, possibly unmatched) CRM contact for the active conversation — used ONLY for SMS/WhatsApp/Messenger/Instagram, and for a brand-new email conversation with no existing Gmail thread yet. */
  selectedContact: { phone?: string; email?: string; messenger_psid?: string; instagram_igsid?: string } | null | undefined;
}): ComposerRecipientResult {
  const { composeChannel, activeConversation, selectedContact } = input;
  const contactName = activeConversation?.contactName || "This contact";

  if (composeChannel === "sms" || composeChannel === "whatsapp") {
    const to = selectedContact?.phone;
    if (!to) return { ok: false, error: `${contactName} has no phone number on file` };
    return { ok: true, to };
  }

  if (composeChannel === "messenger") {
    const to = selectedContact?.messenger_psid;
    if (!to) return { ok: false, error: `${contactName} has no Messenger connection (they must message you first)` };
    return { ok: true, to };
  }

  if (composeChannel === "instagram") {
    const to = selectedContact?.instagram_igsid;
    if (!to) return { ok: false, error: `${contactName} has no Instagram connection (they must message you first)` };
    return { ok: true, to };
  }

  if (composeChannel === "email") {
    // Existing Gmail thread: conversation ids for real Gmail threads are
    // always `gm-<thread_id>` (see gmail-conversations.ts) — reply to the
    // thread's own sender address, full stop. Do not require, or fall back
    // to, contacts.email — a linked/matched contact having no email (or a
    // different one) must never block or redirect this.
    const isExistingGmailThread = !!activeConversation && activeConversation.channel === "email" && activeConversation.id.startsWith("gm-");
    if (isExistingGmailThread) {
      const to = extractReplyAddress(activeConversation!.senderEmail);
      if (!to) return { ok: false, error: "This email thread has no valid reply address." };
      return { ok: true, to };
    }

    // A brand-new email conversation (New Conversation sheet placeholder,
    // or an SMS-style `sb-` contact stub) has no real Gmail thread/sender
    // address to reply to — the only valid destination is the explicitly
    // selected contact's own email.
    const to = selectedContact?.email;
    if (!to) return { ok: false, error: `${contactName} has no email address on file` };
    return { ok: true, to };
  }

  // "note" never reaches here — handleSend returns before resolving a
  // recipient for notes. Included only for type completeness.
  return { ok: false, error: "Notes are not sent to a recipient" };
}
