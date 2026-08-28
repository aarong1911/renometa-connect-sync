-- Prevent the same Meta Page from being connected to Lead Ads
-- in more than one RenoMeta organization.
--
-- Safe to apply after confirming there are currently no duplicate
-- page_id values for product = 'lead_ads'.

create unique index if not exists idx_meta_connections_unique_lead_ads_page
on public.meta_connections(page_id)
where product = 'lead_ads'
  and page_id is not null;

-- Verification:
--
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'meta_connections'
--   and indexname = 'idx_meta_connections_unique_lead_ads_page';