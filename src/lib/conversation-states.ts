// src/lib/conversation-states.ts
//
// Real, persisted Archive state for the Inbox, backed by the
// conversation_states table (see
// supabase/migrations/20260724_conversation_states.sql +
// supabase/migrations/20260726_conversation_states_external_key.sql — both
// must be applied). Organization-wide.
//
// Identity rule (channel-first, not contact-first):
//   - Gmail (channel "email"): ALWAYS keyed by external_conversation_key =
//     `gmail:<thread_id>` — the Gmail thread is the stable, permanent
//     identity for a conversation. contact_id may ALSO be stored on the row
//     when the thread currently resolves to a saved contact, but it is
//     metadata only — it is never the lookup key, and re-linking/matching a
//     different contact later must never change which row (or its archived
//     state) is found. This is deliberate: a contact_id-first lookup would
//     "lose" a Gmail thread's archive state the moment its sender becomes a
//     saved contact (lookup silently switches to a brand-new, unarchived
//     contact_id row) — keying on the thread itself avoids that entirely.
//   - SMS / WhatsApp / Messenger / Instagram: unchanged — always contact_id
//     + channel, exactly as before Gmail support was added.
//
// Archive only in this pass; is_starred exists in the table for forward
// compatibility but has no read/write path here.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return membership?.org_id ?? null;
}

export type ConversationIdentity = {
  /** Metadata only for Gmail rows — never the lookup key when externalKey is set. */
  contactId: string | null;
  /** The lookup key for Gmail rows. Always null for non-email channels. */
  externalKey: string | null;
};

/**
 * Resolves the archive identity for a conversation.
 *
 * Gmail (channel "email") ALWAYS resolves externalKey to `gmail:<thread_id>`
 * — derived from the conversation id, which gmail-conversations.ts always
 * builds as `gm-<thread_id>`, so no change to that file's mapping logic is
 * needed. contactId is included alongside when the conversation currently
 * resolves to a real (UUID) contact, but callers must use externalKey as
 * the identity/lookup key for email — contactId is metadata only.
 *
 * All other channels: a real (UUID) contactId is the identity, same as
 * before. A non-email conversation with no real contact id (e.g. an `sb-`
 * SMS placeholder) has no safe identity and resolves to all-null.
 */
export function resolveConversationIdentity(conv: { id: string; contactId: string; channel: string }): ConversationIdentity {
  const realContactId = UUID_RE.test(conv.contactId) ? conv.contactId : null;

  if (conv.channel === "email") {
    return { contactId: realContactId, externalKey: gmailExternalKeyForConversationId(conv.id) };
  }

  return { contactId: realContactId, externalKey: null };
}

/** `gm-<thread_id>` (gmail-conversations.ts's conversation id) -> `gmail:<thread_id>`, or null if not a Gmail conversation id. */
export function gmailExternalKeyForConversationId(conversationId: string): string | null {
  return conversationId.startsWith("gm-") ? `gmail:${conversationId.slice(3)}` : null;
}

// The lookup key: externalKey takes priority (Gmail), otherwise contactId
// (every other channel). Never combine or fall back from one to the other.
function identityMapKey(identity: ConversationIdentity, channel: string): string | null {
  const id = identity.externalKey ?? identity.contactId;
  return id ? `${id}::${channel}` : null;
}

/** Map key for a conversation object — null means "no stable identity, cannot be archived". */
export function conversationMapKey(conv: { id: string; contactId: string; channel: string }): string | null {
  return identityMapKey(resolveConversationIdentity(conv), conv.channel);
}

export function useConversationArchiveStates(): {
  /** Map of `${identity}::${channel}` -> true for every conversation currently archived. Absence = not archived. */
  archivedMap: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setArchived: (conv: { id: string; contactId: string; channel: string }, archived: boolean) => Promise<void>;
} {
  const [archivedMap, setArchivedMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      setLoading(false);
      return;
    }

    const { data, error: fetchError } = await supabase
      .from("conversation_states")
      .select("contact_id, external_conversation_key, channel, is_archived")
      .eq("org_id", orgId)
      .eq("is_archived", true);

    if (fetchError) {
      console.error("[conversation-states] fetch failed:", fetchError);
      setError("Failed to load archive state.");
      setLoading(false);
      return;
    }

    const next: Record<string, boolean> = {};
    for (const row of data ?? []) {
      // externalKey-first, matching identityMapKey's priority — a Gmail row
      // may carry both columns, and external_conversation_key must win.
      const key = identityMapKey({ contactId: row.contact_id, externalKey: row.external_conversation_key }, row.channel);
      if (key) next[key] = true;
    }
    setArchivedMap(next);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const setArchived = useCallback(
    async (conv: { id: string; contactId: string; channel: string }, archived: boolean) => {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Not authenticated");

      const identity = resolveConversationIdentity(conv);
      if (!identity.contactId && !identity.externalKey) {
        throw new Error("This conversation has no stable identity to archive");
      }
      const mapKey = identityMapKey(identity, conv.channel)!;
      const previous = archivedMap[mapKey] ?? false;

      // Optimistic update — rolled back below if the write fails.
      setArchivedMap((current) => {
        const next = { ...current };
        if (archived) next[mapKey] = true;
        else delete next[mapKey];
        return next;
      });

      try {
        // Explicit select-then-update-or-insert rather than .upsert(onConflict):
        // the two identity paths are enforced by partial unique indexes
        // (see the migration), and Postgres only honors a partial index as
        // an ON CONFLICT arbiter when the conflict target's predicate is
        // repeated in the query — which PostgREST's upsert `on_conflict`
        // column-list parameter has no way to express. Reading the
        // existing row first sidesteps that entirely and matches the same
        // pattern already used for org-scoped upserts elsewhere in this
        // codebase (e.g. gmail-oauth-callback.ts's `integrations` writes).
        //
        // externalKey-first: for Gmail this looks up by thread identity
        // regardless of whatever contact_id is currently resolved, so a
        // re-link/re-match never causes a "new" row to be found.
        let query = supabase
          .from("conversation_states")
          .select("id")
          .eq("org_id", orgId)
          .eq("channel", conv.channel);
        query = identity.externalKey
          ? query.eq("external_conversation_key", identity.externalKey)
          : query.eq("contact_id", identity.contactId!);
        const { data: existing, error: selectError } = await query.maybeSingle();
        if (selectError) throw selectError;

        const payload = {
          org_id: orgId,
          // contact_id is stored for reference on Gmail rows (may be null
          // if still unmatched) but is never part of the lookup above when
          // externalKey is set.
          contact_id: identity.contactId,
          external_conversation_key: identity.externalKey,
          channel: conv.channel,
          is_archived: archived,
          archived_at: archived ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        };

        if (existing) {
          const { error: updateError } = await supabase.from("conversation_states").update(payload).eq("id", existing.id);
          if (updateError) throw updateError;
        } else {
          const { error: insertError } = await supabase.from("conversation_states").insert(payload);
          if (insertError) throw insertError;
        }
      } catch (err) {
        setArchivedMap((current) => {
          const next = { ...current };
          if (previous) next[mapKey] = true;
          else delete next[mapKey];
          return next;
        });
        throw err;
      }
    },
    [archivedMap],
  );

  return { archivedMap, loading, error, refresh: fetchData, setArchived };
}

// ── Gmail thread ↔ contact linking ──────────────────────────────────────
//
// The explicit link between a Gmail thread and a contact lives ONLY on
// conversation_states.contact_id, keyed by (org_id, external_conversation_key,
// channel='email') — never by mutating contacts.email. This keeps linking
// completely independent of archive state (preserved untouched on the same
// row) and independent of contacts data (a contact's email is never
// written to just to associate it with a thread).

/** Sets (or changes, or via unlinkGmailContact clears) which contact a Gmail thread is explicitly linked to. Preserves is_archived/archived_at on an existing row untouched. Never creates duplicate rows — selects the existing row for this thread first. */
export async function setGmailContactLink(conversationId: string, contactId: string | null): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");

  const externalKey = gmailExternalKeyForConversationId(conversationId);
  if (!externalKey) throw new Error("Not a Gmail conversation");

  const { data: existing, error: selectError } = await supabase
    .from("conversation_states")
    .select("id")
    .eq("org_id", orgId)
    .eq("external_conversation_key", externalKey)
    .eq("channel", "email")
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    // Only contact_id + updated_at change — is_archived/archived_at are
    // simply not in this payload, so they're left exactly as they were.
    const { error } = await supabase
      .from("conversation_states")
      .update({ contact_id: contactId, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("conversation_states").insert({
      org_id: orgId,
      external_conversation_key: externalKey,
      channel: "email",
      contact_id: contactId,
      is_archived: false,
      archived_at: null,
    });
    if (error) throw error;
  }
}

/** Removes the explicit contact link (contact_id -> null) for a Gmail thread, preserving its archive state. Returns false if there was no row / no link to remove (e.g. the thread is only matched by email, not an explicit link). */
export async function unlinkGmailContact(conversationId: string): Promise<boolean> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");

  const externalKey = gmailExternalKeyForConversationId(conversationId);
  if (!externalKey) throw new Error("Not a Gmail conversation");

  const { data: existing, error: selectError } = await supabase
    .from("conversation_states")
    .select("id, contact_id")
    .eq("org_id", orgId)
    .eq("external_conversation_key", externalKey)
    .eq("channel", "email")
    .maybeSingle();
  if (selectError) throw selectError;
  if (!existing || !existing.contact_id) return false;

  const { error } = await supabase
    .from("conversation_states")
    .update({ contact_id: null, updated_at: new Date().toISOString() })
    .eq("id", existing.id);
  if (error) throw error;
  return true;
}
