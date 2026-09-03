-- 20260909_task_due_time.sql
--
-- Optional time-of-day for a Task's due date.
--
-- WHY: tasks.due_date is (and stays) a plain DATE. Some tasks want a
-- specific clock time ("call supplier at 10:30") so the Calendar can place
-- them on the time grid instead of the all-day row. This adds an OPTIONAL
-- companion column — NULL means "date-only", exactly today's behavior.
--
-- SCOPE / GUARANTEES:
--   * Nullable, no default -> every existing row stays NULL -> no existing
--     task changes meaning, no backfill.
--   * `time` (without time zone) = wall-clock time, interpreted in the
--     org/calendar timezone at render time together with due_date. It is
--     NOT a timestamptz and carries no date or offset of its own.
--   * Canonical overdue / due-soon / "Needs Attention" qualification is
--     deliberately NOT affected — that logic stays date-only on due_date.
--     due_time is presentation-only (Calendar placement + detail display).
--
-- DO NOT APPLY automatically. Apply manually in the Supabase SQL Editor.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS due_time time NULL;

COMMENT ON COLUMN public.tasks.due_time IS
  'Optional wall-clock time of day for due_date, interpreted in the org/calendar timezone. NULL = date-only. Presentation-only: does not affect overdue/due-soon qualification.';
