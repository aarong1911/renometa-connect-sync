-- Gmail OAuth connection — RLS hardening for `integrations` and
-- `oauth_states`.
--
-- Both tables already exist and are populated by a process outside this
-- repo (no CREATE TABLE migration for either exists in this repo's
-- history) — this migration does not assume anything about their current
-- RLS state; it only enforces the posture this app requires going
-- forward, and is safe to re-run.
--
-- IMPORTANT CAVEAT: this environment has no pg_catalog/pg_policies
-- introspection available (REST-only access via the service-role key), so
-- any pre-existing policy on these tables with a name other than the one
-- this migration creates could not be inspected before writing this file.
-- A live anon-key behavioral test (SELECT with a known-existing row id)
-- was run before writing this and returned zero rows for both tables,
-- which is consistent with (but not conclusive proof of) there being no
-- wide-open anon policy today.
--
-- Access model:
--   - integrations: holds AES-256-GCM encrypted OAuth tokens per
--     (org_id, provider). Every read/write from this app goes through
--     service-role Netlify functions (gmail-sync.ts, gmail-oauth-start.ts,
--     gmail-oauth-callback.ts, gmail-connection-status.ts,
--     gmail-disconnect.ts) — service_role bypasses RLS entirely, so these
--     policies only govern direct client access via the anon/authenticated
--     keys, which no client code in this repo uses for this table today
--     (verified via grep). A read-only, org-scoped SELECT policy is added
--     anyway for defense in depth — the token columns are encrypted at
--     rest and the decryption key (ENCRYPTION_KEY) never leaves the
--     server, so an org member reading this table directly would only
--     ever see ciphertext. No INSERT/UPDATE/DELETE policy is added for
--     anon/authenticated — those must stay server-only.
--   - oauth_states: short-lived, single-use CSRF state rows tied to
--     (org_id, user_id, provider, expires_at). Opaque, single-use (see
--     gmail-oauth-callback.ts — consumption is enforced by deleting the
--     row on first use, not a separate flag column), and only meaningful
--     during the few minutes of an OAuth handshake. No legitimate reason
--     for client code to read or write this table directly — fully locked
--     down, no policies for anon/authenticated at all.

alter table public.integrations enable row level security;
alter table public.oauth_states enable row level security;

drop policy if exists "org members or creator can select integrations" on public.integrations;
create policy "org members or creator can select integrations"
on public.integrations
for select
to authenticated
using (
  exists (
    select 1 from public.org_memberships om
    where om.member_id = auth.uid() and om.org_id = integrations.org_id
  )
  or exists (
    select 1 from public.organizations o
    where o.id = integrations.org_id and o.created_by = auth.uid()
  )
);

revoke all on public.integrations from public, anon;
grant select on public.integrations to authenticated;

revoke all on public.oauth_states from public, anon, authenticated;
