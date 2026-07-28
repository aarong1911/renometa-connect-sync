-- Phase 9.4 — enforce organization-scoped slug uniqueness for companies at
-- the database level, not just in application code (src/lib/companies-store.ts
-- already generates a unique slug per org with a numeric-suffix collision
-- loop, but nothing previously prevented a second concurrent request or a
-- manual DB edit from creating a real collision).
--
-- Confirmed safe before adding: a live data check of all existing companies
-- rows found zero (org_id, slug) collisions, so this can be added directly
-- without a backfill or cleanup step.
create unique index if not exists companies_org_slug_uq on public.companies (org_id, slug);
