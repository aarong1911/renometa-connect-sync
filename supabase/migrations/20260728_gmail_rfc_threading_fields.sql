-- Adds standards-based email threading fields to gmail_messages.
--
-- Gmail's own thread_id (already stored) groups messages the way Gmail's
-- own UI does — it is NOT the same thing as the RFC 5322 Message-ID header
-- (rfc_message_id below), which is what mail clients/servers actually use
-- for reply threading (In-Reply-To / References). Both are kept, and must
-- never be confused: thread_id is Gmail-internal grouping (already used by
-- src/lib/gmail-conversations.ts to build one Conversation per thread);
-- rfc_message_id/in_reply_to/references_header are the real mail headers,
-- used only for constructing correct outbound threading headers and for
-- reliable send/sync deduplication (see send-inbox-message.ts,
-- gmail-sync.ts).
--
-- direction is added as a stored column (in/out) so it no longer needs to
-- be re-derived from the labels array on every client read — gmail-sync.ts
-- computes it once, the same way it already does today (SENT label
-- present = outbound), just persisted instead of recomputed.
--
-- provider_message_id is distinct from gmail_messages.id (which is already
-- the Gmail API message id, used as this table's primary key) — it exists
-- so an OUTBOUND message sent via SMTP (nodemailer), which has no Gmail
-- API id at send time, can still be identified once Gmail sync later
-- imports it, without conflating the two identifiers.

alter table public.gmail_messages
  add column if not exists rfc_message_id text,
  add column if not exists in_reply_to text,
  add column if not exists references_header text,
  add column if not exists direction text,
  add column if not exists provider_message_id text;

-- One row per (org, real Message-ID) — nullable, so this only constrains
-- rows that actually have one. Non-unique index for provider_message_id
-- (nodemailer-assigned ids only need to be look-up-able, not universally
-- unique here since NULL is the common case for inbound mail).
create unique index if not exists gmail_messages_org_rfc_message_id_uq
  on public.gmail_messages (org_id, rfc_message_id)
  where rfc_message_id is not null;

create index if not exists gmail_messages_provider_message_id_idx
  on public.gmail_messages (provider_message_id)
  where provider_message_id is not null;

create index if not exists gmail_messages_org_thread_idx
  on public.gmail_messages (org_id, thread_id);
