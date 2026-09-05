-- AI-H1.1 Part 3 — Voice Agent archive support
--
-- NOT YET APPLIED. Proposed migration only — review before running.
--
-- Enables "Archive" as the normal user-facing removal action for a Voice
-- Agent instead of a destructive hard delete. voice_calls.agent_id is the
-- only record of which agent handled a historical call; hard-deleting the
-- voice_agents row would either dangle that foreign key or (if a cascade
-- exists) silently destroy which agent a past call belongs to. Archiving
-- keeps the row — and therefore the historical name — resolvable forever.
--
-- Code in netlify/functions/voice-agent-archive.ts, assign-voice-number.ts,
-- and voice-agent-set-status.ts already reads/writes this column with a
-- runtime fallback (Postgres error code 42703, "column does not exist") to
-- unfiltered behavior when it's absent, so existing functionality keeps
-- working before this migration is applied — but the Archive action itself
-- (voice-agent-archive.ts) returns HTTP 501 until this column exists.

alter table public.voice_agents
  add column if not exists archived_at timestamptz null;

comment on column public.voice_agents.archived_at is
  'When set, this Voice Agent is archived: hidden from the default list, forced inactive, and its Vapi assistant has been deleted. The row itself is never deleted so historical voice_calls.agent_id references keep resolving to a real name — do not hard-delete or null out an archived row as part of normal archive flow.';

-- No index added: voice_agents is queried per-org (tenant_id) at very low
-- row counts (a handful of agents per org), so a plain `is (archived_at,
-- null)` filter on the existing tenant_id-scoped query needs no new index.
