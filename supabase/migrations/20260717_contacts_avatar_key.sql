-- Manual avatar assignment for contacts. Nullable — when unset,
-- ContactAvatar falls back to its existing deterministic seed-based
-- selection, so this is purely additive.
-- Safe to run multiple times.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS avatar_key TEXT;
