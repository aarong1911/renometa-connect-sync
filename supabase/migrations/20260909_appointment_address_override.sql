-- 20260909_appointment_address_override.sql
--
-- Appointment address: inherit-from-Contact vs. appointment-specific override.
--
-- PROBLEM: appointments.address is a single free-text snapshot. When the
-- linked Contact's address later changes, there is currently no way to know
-- whether a given appointment's stored address was:
--   (a) just a copy of the Contact's address at creation time (should now
--       follow the Contact), or
--   (b) an intentional appointment-specific location (must stay put).
--
-- SCHEMA DECISION — TRI-STATE NULLABLE BOOLEAN (no DEFAULT):
--   This database is the live production database. Existing appointment rows
--   already carry addresses whose historical intent (copy vs. deliberate
--   override) cannot be reconstructed. A `DEFAULT false` would silently
--   reclassify every one of those legacy rows as "inherit from Contact",
--   which could change the displayed address of real past/future
--   appointments the moment a Contact address is edited. That is not safe.
--
--   Therefore the column is nullable with NO default:
--     NULL  -> legacy / unknown intent. appointments.address stays
--              authoritative and is shown as-is. No inheritance.
--     FALSE -> explicitly inherit: show the linked Contact's current
--              address; appointments.address is only a fallback snapshot.
--     TRUE  -> explicit override: appointments.address is authoritative.
--
--   Every appointment created or edited by the app AFTER this ships writes
--   an explicit TRUE or FALSE (never NULL). NULL only ever means "written
--   before this feature existed".
--
--   Semantics apply only when the appointment's meeting location type is
--   "property_address". Office / other location modes are unaffected.
--
-- The app never writes an appointment address back onto contacts.address.
--
-- DO NOT APPLY automatically. Apply manually in the Supabase SQL Editor.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS address_is_override boolean NULL;

COMMENT ON COLUMN public.appointments.address_is_override IS
  'Property-address mode only. NULL = legacy, appointments.address authoritative. FALSE = inherit linked Contact current address (appointments.address is fallback snapshot). TRUE = appointments.address is an explicit appointment-specific override.';
