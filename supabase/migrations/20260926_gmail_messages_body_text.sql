-- Adds the full readable message body to gmail_messages.
--
-- WHY: gmail-sync.ts used to fetch Gmail `format=metadata`, so the only content
-- stored per message was Gmail's ~200-character `snippet`. A snippet cannot
-- render a real email (no paragraphs, signatures or quoted history). The sync
-- now fetches `format=full`, extracts the body from the MIME tree
-- (netlify/functions/lib/gmail-mime.ts) and stores it here.
--
-- body_text is READABLE TEXT (HTML emails are converted to text; quoted replies
-- and signatures are kept in the text, not stripped). It is NULLABLE and has no
-- default:
--   NULL  = row predates this column / not yet fetched in full. The UI falls
--           back to `snippet`, and the next sync (which re-reads the last 7
--           days) backfills it.
--   ''    = fetched, the message has no text content (e.g. attachment-only).
--           Not re-fetched on every sync.
--
-- SAFETY: additive only. One nullable column, no rewrite of existing rows, no
-- data deleted, no constraint or index changes, existing RLS policies (org
-- scoped) apply to the new column automatically. Safe to run repeatedly
-- (IF NOT EXISTS). Application code tolerates the column being absent only
-- until this is applied — apply BEFORE deploying the matching code.
--
-- NO INDEX: body_text is only ever read for rows already selected by
-- (org_id, id); nothing filters or sorts by it, so an index would only cost
-- write time and space.
--
-- ROLLBACK (only if needed; loses only the extracted bodies, which the next
-- sync can re-derive from Gmail):
--   alter table public.gmail_messages drop column if exists body_text;

alter table public.gmail_messages
  add column if not exists body_text text;

comment on column public.gmail_messages.body_text is
  'Full readable message body (HTML converted to text; quotes/signatures preserved). NULL = not fetched yet (use snippet); empty string = fetched, no text content.';

-- Verify after applying:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'gmail_messages' and column_name = 'body_text';
