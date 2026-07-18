-- Stores per-org integration credentials (Twilio, Stripe keys, etc.)
-- Safe to run multiple times.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS integration_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
