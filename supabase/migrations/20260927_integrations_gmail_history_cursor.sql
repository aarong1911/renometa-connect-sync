-- Adds a durable Gmail History API cursor to the existing `integrations` table.
--
-- WHY: routine Gmail sync only ever listed the newest 10 messages
-- (netlify/functions/gmail-sync.ts). In a busy mailbox, more than 10 unrelated
-- emails between syncs could push a genuine CRM reply outside that window, so
-- it would never be fetched — even though auto-sync itself was working. This
-- replaces that fixed window with Gmail's incremental History API
-- (users.history.list), which needs a durable cursor (`historyId`) stored
-- somewhere that survives across syncs, browser sessions and deploys.
--
-- `integrations` is NOT defined by any migration in this repo (see
-- database-migrations skill: it predates the migrations folder, like
-- `companies`/`contacts`/`vendors`) — its real columns are known from repo
-- evidence: gmail-sync.ts, gmail-connection-status.ts and
-- gmail-oauth-callback.ts all select/update `org_id, provider, status,
-- access_token_encrypted, refresh_token_encrypted, token_expires_at,
-- provider_account_email, config, last_sync_at, last_sync_status, sync_error`
-- against it today, confirming the table already exists with that shape.
-- This migration only ADDS to it.
--
-- gmail_history_id (text, nullable):
--   Gmail's historyId cursor, stored and compared as a STRING. Gmail documents
--   historyId as an opaque value that can exceed safe JS integer precision —
--   it is never parsed into a JS `number`. NULL = this connection has never
--   completed a bootstrap sync (or was just reconnected to a different
--   account — see the next column); the next sync performs a bounded
--   bootstrap instead of an incremental history fetch.
--
-- gmail_history_id_account_email (text, nullable):
--   The Gmail account (provider_account_email) the stored cursor was
--   established for. A stored historyId is only ever trusted when this
--   matches the connection's CURRENT provider_account_email — this is what
--   stops a stale cursor from one Google account being reused after the org
--   reconnects Gmail as a different account. Reconnecting the SAME account
--   keeps using its existing cursor (no unnecessary re-bootstrap).
--
-- SAFETY: additive only. Two nullable columns, no default, no rewrite of
-- existing rows, no data deleted, no constraint or index added. Existing RLS
-- policies (org-scoped) apply to the new columns automatically. Safe to run
-- repeatedly (IF NOT EXISTS). Application code (netlify/functions/gmail-sync.ts
-- and netlify/functions/lib/gmail-history-sync.ts) tolerates the columns being
-- absent only until this migration is applied — apply BEFORE deploying the
-- matching code, or every sync falls back to selecting a non-existent column
-- and errors (same failure mode as any other missing-column deploy ordering
-- issue in this repo; not a new risk class).
--
-- NO INDEX: both columns are only ever read by primary-key (`integrations.id`)
-- or by the existing `(org_id, provider)` lookup gmail-sync.ts already does;
-- nothing filters or sorts by either new column.

alter table public.integrations
  add column if not exists gmail_history_id text,
  add column if not exists gmail_history_id_account_email text;

comment on column public.integrations.gmail_history_id is
  'Gmail History API cursor (users.history.list startHistoryId for the next sync). Stored/compared as text — never parsed as a JS number. NULL = never bootstrapped, next sync performs a bounded bootstrap.';
comment on column public.integrations.gmail_history_id_account_email is
  'provider_account_email the stored gmail_history_id was established for. A mismatch against the connection''s current provider_account_email invalidates the cursor (prevents reusing one Google account''s cursor after reconnecting as a different account).';

-- Verify after applying:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'integrations'
--      and column_name in ('gmail_history_id', 'gmail_history_id_account_email');
--
--   -- Every existing Gmail connection should show NULL/NULL right after
--   -- applying (expected — the next sync for each org bootstraps once and
--   -- fills them in):
--   select org_id, provider_account_email, gmail_history_id, gmail_history_id_account_email
--     from public.integrations where provider = 'gmail';

-- ROLLBACK (only if needed; loses only the cursor, which the next sync
-- re-establishes via a bounded bootstrap — no message data is lost):
--   alter table public.integrations
--     drop column if exists gmail_history_id,
--     drop column if exists gmail_history_id_account_email;
