-- Additive fix: allow archiving Gmail conversations whose sender is not
-- yet a saved CRM contact.
--
-- conversation_states (20260724_conversation_states.sql) currently requires
-- contact_id NOT NULL. Gmail threads are matched to a contact by email
-- address (see src/lib/gmail-conversations.ts) — when no contacts.email
-- row matches, the conversation uses a synthetic, non-UUID contactId
-- (`gmail-unknown-<address>`) purely for client-side grouping. That
-- synthetic id is NOT a real contacts.id, so it can never satisfy
-- conversation_states.contact_id's foreign key — archiving such a
-- conversation had no valid row to write, surfacing as "This contact must
-- be saved before archiving conversations". The Inbox intentionally never
-- auto-creates a contact just to allow archiving, so the fix is a second,
-- non-contact identity path, not a contact-creation workaround.
--
-- Fix: contact_id becomes nullable, and a new external_conversation_key
-- column carries a stable identity for the non-contact case. For Gmail
-- that's `gmail:<thread_id>` — gmail_messages.thread_id is real, stable,
-- and already what gmail-conversations.ts groups a conversation by (one
-- conversation per thread; convId = `gm-<thread_id>`), so no change to
-- that file's mapping logic is needed — the key is derived client-side
-- from the existing conversation id (see resolveConversationIdentity in
-- src/lib/conversation-states.ts).
--
-- REVISED (before this migration was ever applied): Gmail conversations
-- ALWAYS use external_conversation_key as their identity/lookup key, even
-- once the sender resolves to a saved contact — contact_id may ADDITIONALLY
-- be stored on a Gmail row as metadata, but it is never the lookup key for
-- channel = 'email'. This is deliberate: a contact-first lookup would make
-- a Gmail thread's persisted archive state "disappear" the instant its
-- sender became a saved contact (the lookup would silently switch to a
-- brand-new, unarchived contact_id row) — keying on the thread itself
-- avoids that, and also means one real contact who emails from two
-- different threads correctly gets two independent conversation_states
-- rows (one per thread), not one shared row.
--
-- SMS/WhatsApp/Messenger/Instagram are completely unaffected — they keep
-- using contact_id + channel exactly as before, and every existing row in
-- this table today is contact_id-based (non-email) and is left untouched
-- by this migration.

alter table public.conversation_states
  alter column contact_id drop not null;

alter table public.conversation_states
  add column if not exists external_conversation_key text;

-- Require at least one identity — a row with neither means nothing.
alter table public.conversation_states
  drop constraint if exists conversation_states_identity_chk;
alter table public.conversation_states
  add constraint conversation_states_identity_chk
  check (contact_id is not null or external_conversation_key is not null);

-- Replace the original single composite unique constraint (implicitly
-- contact-only, since contact_id was NOT NULL) with two explicit partial
-- unique indexes, one per identity type/channel scope.
alter table public.conversation_states
  drop constraint if exists conversation_states_org_id_contact_id_channel_key;

-- Non-email only: for every other channel, contact_id + channel IS the
-- conversation identity, same as before. Explicitly excluding channel =
-- 'email' here matters — a Gmail row may carry a contact_id as metadata
-- while a DIFFERENT Gmail thread from the same contact carries the SAME
-- contact_id; those must be allowed to coexist as separate rows (each with
-- its own external_conversation_key), which this index's scope permits.
drop index if exists conversation_states_org_contact_channel_uq;
create unique index conversation_states_org_contact_channel_uq
  on public.conversation_states (org_id, contact_id, channel)
  where contact_id is not null and channel <> 'email';

-- Gmail (and any future non-contact channel): one row per external key —
-- this is what actually keeps one row per Gmail thread.
drop index if exists conversation_states_org_extkey_channel_uq;
create unique index conversation_states_org_extkey_channel_uq
  on public.conversation_states (org_id, external_conversation_key, channel)
  where external_conversation_key is not null;

create index if not exists conversation_states_extkey_channel_idx
  on public.conversation_states (external_conversation_key, channel);

-- No RLS/policy changes needed — every existing policy only references
-- org_id, never contact_id, so org-scoped, organization-wide archive
-- behavior is unaffected by contact_id becoming nullable.
