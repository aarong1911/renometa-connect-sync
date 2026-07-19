-- Add edges column to workflows table for React Flow canvas state
alter table workflows
  add column if not exists edges jsonb not null default '[]'::jsonb;
