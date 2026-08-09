-- 20260821_public_invoice_payments.sql
--
-- Phase 13.7 — secure public invoice/payment access. A raw invoice UUID is
-- NOT an acceptable authorization mechanism on its own (guessable/enumerable
-- once one is known, and every invoice UUID already flows through browser
-- network tabs in the authenticated app). This introduces a dedicated
-- high-entropy public token, stored ONLY as a SHA-256 hash — the raw token
-- exists transiently (generated in invoice-send.ts, embedded in the emailed
-- URL) and is never written to the database or logs.
--
-- Deliberately a separate table from `invoices` rather than a `public_token`
-- column (contrast: estimates.public_token stores the raw token in plain
-- text — a fine pattern for that lower-stakes read-only proposal view, but
-- not appropriate here since this token also gates a real payment action)
-- so the hash-only, revocable, expirable, audit-friendly model is explicit
-- and can't be casually read back out in cleartext.
--
-- No anon SELECT policy is granted — public token verification happens
-- exclusively through trusted server code (public-invoice.ts,
-- invoice-create-payment.ts) using the service-role client, which bypasses
-- RLS entirely. RLS here only governs authenticated in-app access (owner/
-- staff viewing which tokens exist for an invoice they already own).
--
-- Phase 13.7A hardening (still unapplied at the time of this edit — this
-- file is modified in place rather than superseded by a new migration,
-- per this repo's own rule: an unapplied migration is edited directly,
-- only an already-applied one gets a follow-up file):
--   - invoice_id has NO unique constraint, intentionally: the corrected
--     token lifecycle (netlify/lib/invoice-tokens.ts, mintPublicInvoiceToken)
--     mints a brand new row on every send/resend rather than trying to
--     "reuse" a raw token that was never recoverable from its hash in the
--     first place. Multiple active rows per invoice are expected.
--   - RLS SELECT policy now matches this repo's canonical org-membership
--     pattern (profiles.organization_id OR org_memberships.member_id),
--     not just profiles.organization_id.
--   - explicit REVOKE/GRANT block added, matching the accounting
--     migration's hardened style, instead of relying on Supabase's default
--     table privileges.
--   - all object/table references schema-qualified (public.*) rather than
--     relying on search_path, since this is a payment-sensitive migration.
--   - policy creation is drop-if-exists-then-create, so this file is safe
--     to run more than once by hand before it's been applied.

create table if not exists public.invoice_public_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  last_accessed_at timestamptz null
);

-- invoice_id is intentionally NOT unique — see Phase 13.7A note above.
create index if not exists idx_invoice_public_tokens_invoice_id on public.invoice_public_tokens(invoice_id);
create index if not exists idx_invoice_public_tokens_org_id on public.invoice_public_tokens(org_id);
-- token_hash already has a unique index via the UNIQUE constraint above,
-- which Postgres uses directly for the hash lookup in public-invoice.ts —
-- deliberately no second/redundant index on the same column.

alter table public.invoice_public_tokens enable row level security;

-- Authenticated staff can see (not create/revoke via this policy — that's a
-- service-role-only action from invoice-send.ts) which tokens exist for
-- invoices belonging to their own org, e.g. for a future "copy payment
-- link" / "revoke link" affordance in the Invoices UI. No anon policy at
-- all — an unauthenticated request has zero rows visible via PostgREST and
-- must go through the trusted Netlify functions instead.
--
-- Matches this repo's canonical org-membership check (see e.g.
-- invoice_payments_select in 20260818_invoice_payments_ledger.sql and the
-- accounting_* policies in 20260820_accounting_foundation.sql): a user's
-- org can come from either their own profiles.organization_id OR an
-- org_memberships row — checking profiles alone would incorrectly hide
-- these rows from a member added via org_memberships without their own
-- profiles.organization_id set.
drop policy if exists invoice_public_tokens_select_own_org on public.invoice_public_tokens;
create policy invoice_public_tokens_select_own_org
  on public.invoice_public_tokens for select
  to authenticated
  using (
    org_id in (select p.organization_id from public.profiles p where p.id = auth.uid())
    or
    org_id in (select om.org_id from public.org_memberships om where om.member_id = auth.uid())
  );

-- Explicit grants (Phase 13.7A Part 11) — do not rely purely on Supabase's
-- default table privileges. Only the service-role key (which bypasses RLS
-- entirely) may create, touch last_accessed_at on, or revoke a token; RLS
-- above still further restricts authenticated SELECT to the caller's own
-- org's rows. Matches the hardened accounting_* tables' posture
-- (supabase/migrations/20260820_accounting_foundation.sql).
revoke all on public.invoice_public_tokens from anon, authenticated;
grant select on public.invoice_public_tokens to authenticated;
grant select, insert, update, delete on public.invoice_public_tokens to service_role;

comment on table public.invoice_public_tokens is
  'Phase 13.7 — hashed high-entropy tokens for anonymous customer access to a single invoice via the emailed "View & Pay Invoice" link. Raw token is never stored; only its SHA-256 hash. A fresh token row is minted on every invoice send/resend (Phase 13.7A) — multiple active rows per invoice are expected and invoice_id has no unique constraint. Verified exclusively by service-role backend code (public-invoice.ts, invoice-create-payment.ts).';
