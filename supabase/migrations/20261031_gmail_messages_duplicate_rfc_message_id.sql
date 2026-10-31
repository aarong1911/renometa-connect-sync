-- Keeps the Message-ID header of a Gmail message that cannot hold it in
-- gmail_messages.rfc_message_id.
--
-- gmail_messages_org_rfc_message_id_uq (20260728) allows one row per
-- (org_id, rfc_message_id). Gmail can hold two distinct messages with the
-- same Message-ID header (a copy delivered twice, to an alias or to Spam, or
-- separate Sent and Inbox copies of mail sent to yourself). Gmail sync
-- (netlify/functions/lib/gmail-history-sync.ts) now stores every such message
-- under its own Gmail id, lets ONE of them keep rfc_message_id (the copy
-- already stored, else the Sent copy, then the earliest), and writes NULL
-- there for the others. This column keeps their original header so nothing
-- is lost; it is informational and deliberately NOT unique.
--
-- The unique index is unchanged and stays the rule. Additive only: no
-- existing row, constraint, index, policy or grant is modified. The sync code
-- works without this column (it then saves the duplicate copies without the
-- header), so the column can be added before or after the code is deployed.
--
-- Live schema audited read-only on 2026-10-31 (information_schema.columns):
-- gmail_messages has id, org_id, thread_id, internal_date, snippet,
-- from_email, to_emails, cc_emails, bcc_emails, subject, labels, created_at,
-- updated_at, rfc_message_id, in_reply_to, references_header, direction,
-- provider_message_id, body_text — no duplicate_rfc_message_id.

alter table public.gmail_messages
  add column if not exists duplicate_rfc_message_id text;

comment on column public.gmail_messages.duplicate_rfc_message_id is
  'Message-ID header of this Gmail message when another Gmail message in the same org already holds it in rfc_message_id (which is then NULL here). Informational; not unique.';

-- ── Verification (run after applying) ───────────────────────────────────────
-- 1. Column exists, nullable text:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'gmail_messages'
--      and column_name = 'duplicate_rfc_message_id';
--   -> 1 row: duplicate_rfc_message_id | text | YES
--
-- 2. The unique index is unchanged:
--   select indexdef from pg_indexes
--    where schemaname = 'public' and indexname = 'gmail_messages_org_rfc_message_id_uq';
--   -> CREATE UNIQUE INDEX ... ON public.gmail_messages USING btree (org_id, rfc_message_id) WHERE (rfc_message_id IS NOT NULL)
--
-- 3. PostgREST sees the new column (the sync writes it through the API):
--   notify pgrst, 'reload schema';
--
-- Rollback (discards any headers already stored in it; the sync code keeps
-- working without the column):
--   alter table public.gmail_messages drop column if exists duplicate_rfc_message_id;
