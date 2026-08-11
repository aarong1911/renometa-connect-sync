---
name: database-migrations
description: >
  Safe Supabase/Postgres schema evolution rules for RenoMeta Connect —
  applied-vs-unapplied migration handling, never trusting local migration
  history as the live schema, SECURITY DEFINER function hardening, and the
  audit/report format required before handing SQL to the user. Use whenever
  creating or editing a file in supabase/migrations/, adding/altering a
  table, column, RPC, trigger, or RLS policy, or when the user asks you to
  touch the database schema in any way.
---

# Database Migrations — RenoMeta Connect

## The database is never applied automatically

- Never run `supabase db push`.
- Never apply a migration yourself, in any way.
- The user manually applies migrations through the Supabase SQL Editor, after reviewing them.
- Before you finish a migration task, always state explicitly: **is this migration applied or unapplied right now?**

## Local migration history is not the live schema

`supabase/migrations/` is incomplete evidence, not ground truth. Several real, live tables (`companies`, `contacts`, the pre-existing `vendors` table with `company_id`/`contact_id`/`vendor_type`/`is_active`) were **never captured by any migration file in this repo** — they predate the migrations folder or were created outside it.

- Before modifying an existing table, audit its actual current schema from repository evidence (store files with "confirmed live" doc comments, e.g. `companies-store.ts`, `contacts-store.ts`) and/or user-provided live schema output (`information_schema.columns`).
- Never assume a table is missing just because there's no `CREATE TABLE` for it in `supabase/migrations/`.
- Never recreate a table that already exists live — `create table if not exists` **silently no-ops** against a real table with a different shape than you assumed, and every downstream statement that references columns you invented will then be wrong. This happened for real: an early migration assumed `vendors` needed `name`/`status`/`email`/`created_by` when the live table actually had `company_id`/`contact_id`/`vendor_type`/`is_active` — it had to be rewritten from scratch.
- Never invent columns on an existing table. If you don't know the live shape, ask, or write the migration to be verified against `information_schema.columns` before being applied.

## Applied vs. unapplied migrations

- Never modify an already-applied migration file. Applied migrations are historical, immutable records — treat the `.sql` file the same way the ledger treats a posted journal entry.
- To change something an applied migration created (a table, a function, a trigger, an RLS policy), write a **new** migration. `create or replace function ...` in the new file is the correct way to evolve a function's behavior without touching the old file.
- The one exception: if the CURRENT migration under discussion is explicitly confirmed still unapplied (ask if unsure), it may be edited in place during the same review/hardening pass instead of creating another new file for every round of fixes.
- Naming convention observed in this repo: `supabase/migrations/YYYYMMDD_description.sql`, one file per date, incrementing description passes on the same date edit that file in place while it's unapplied.

## SECURITY DEFINER functions

For any DB function that performs a financially-sensitive or cross-row write:

```sql
create or replace function public.some_function(...)
returns ... language plpgsql security definer
set search_path = public, pg_temp
as $$ ... $$;

revoke all on function public.some_function(...) from public, anon, authenticated;
grant execute on function public.some_function(...) to service_role;
```

- Always set `search_path = public, pg_temp` on `SECURITY DEFINER` functions.
- Revoke from `public`/`anon`/`authenticated` and grant only to `service_role` when the function must only ever be called from a trusted Netlify function.
- Validate every cross-table reference belongs to the same org before trusting it.
- Preserve RLS — it's the tenant boundary for direct client reads; RPCs are the boundary for writes.
- No service-role client or key ever reaches browser code (see `secure-backend` skill).

## Prefer database enforcement for financial/business invariants

Don't rely on application code alone for:

- foreign keys and `on delete restrict` for anything with financial history
- `CHECK` constraints (status enums, `amount > 0`, currency)
- unique / partial unique indexes for duplicate protection and idempotency (e.g. `uq_vendor_bills_org_vendor_number`, `uq_vendor_payments_reverses_payment`)
- immutable-history triggers (block edits/deletes on posted/succeeded rows)
- same-org validation triggers on every FK a table carries
- row locks (`select ... for update`) with **consistent lock ordering** across every function that touches the same parent row, to avoid both races and deadlocks

## Migration safety checklist

Every migration should:

- be additive where possible — new tables/columns/functions, not destructive rewrites
- preserve historical rows — never backfill fake financial data, never retroactively mark real history as something it wasn't
- include a comment for every non-obvious accounting/business rule (the "why", not the "what" — future-you needs to know why a trigger blocks a transition, not that it blocks it)
- include verification SQL at the bottom (`information_schema` checks, `pg_policies`, `pg_proc`/`role_routine_grants` checks) that the user can run right after applying, before trusting the change
- use idempotent SQL so a partial/interrupted apply can be safely re-run — but see the next section: idempotency must never substitute for actually verifying the live schema

### `CREATE TABLE IF NOT EXISTS` is not a substitute for auditing the live schema

`CREATE TABLE IF NOT EXISTS` is only appropriate for a table **explicitly verified as new** — confirmed absent from the live database, not just absent from `supabase/migrations/` (see "Local migration history is not the live schema" above). Used on a table that already exists live with a different shape, it **silently no-ops**: Postgres skips the whole statement, your assumed columns never get created, and every downstream statement that references them is now wrong — with no error to tell you so. This is exactly what happened with `vendors`: a migration assumed it needed creating with `name`/`status`/`email`/`created_by`, `IF NOT EXISTS` silently no-op'd against the real live table (`company_id`/`contact_id`/`vendor_type`/`is_active`), and the migration had to be rewritten from scratch after the mismatch surfaced.

- Never reach for `CREATE TABLE IF NOT EXISTS` as a way to avoid auditing whether a table already exists — audit first (repo evidence and/or user-provided `information_schema.columns` output), then decide.
- For a table confirmed to already exist, use targeted additive changes instead of any form of `CREATE TABLE`:
  - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
  - `CREATE OR REPLACE FUNCTION ...` to evolve trigger/RPC behavior
  - `DROP TRIGGER IF EXISTS ...` + `CREATE TRIGGER ...` to reattach a changed trigger
  - constraints replaced carefully and deliberately (e.g. `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` with the exact intended definition), never assumed safe just because the syntax is idempotent
- If an object (table, type, policy) may pre-exist with an unknown shape, that uncertainty itself is the signal to audit — don't resolve it by leaning on `IF NOT EXISTS` and hoping.

## What to report before handing over SQL

Before telling the user to apply a migration, report:

1. what existing live schema was audited (and how — repo evidence vs. user-provided output)
2. what will change
3. what will explicitly NOT change (e.g. "does not touch 20260820, already applied")
4. which functions are being replaced (`create or replace`) and why
5. tables/columns added
6. constraints/indexes added
7. RLS policy and grant changes
8. whether the migration remains unapplied right now
9. the exact verification queries to run after applying

## Related skills

- `accounting-integrity` — the financial architecture these migrations most often serve
- `secure-backend` — trust-boundary rules for the Netlify functions that call these RPCs
