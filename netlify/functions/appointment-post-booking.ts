/**
 * appointment-post-booking.ts
 * Netlify Function — HTTP entry point so BROWSER-side appointment creation
 * (Calendar UI, CRM entity panels — src/lib/appointments-store.ts) can
 * trigger the same shared post-booking lifecycle (confirmation email +
 * owner/assignee notification) that server-side creators call directly.
 *
 * The browser never sends email/phone/name here — only the appointment id.
 * Everything else is loaded authoritatively server-side by
 * runAppointmentPostBookingLifecycle from the appointment/contact/org rows
 * themselves (SMTP credentials never leave the server either).
 *
 * Usage from the client:
 *   POST /.netlify/functions/appointment-post-booking
 *   Body: { appointmentId: string }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { resolveOrgFromBearerToken } from './lib/resolve-org';
import { runAppointmentPostBookingLifecycle } from './lib/appointment-post-booking';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = await resolveOrgFromBearerToken(supabase, event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: { appointmentId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!body.appointmentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'appointmentId is required' }) };
  }

  // Ownership check happens inside runAppointmentPostBookingLifecycle itself
  // (it loads the appointment scoped to org_id = auth.orgId) — an
  // appointment belonging to a different org silently loads nothing and no
  // action is taken.
  await runAppointmentPostBookingLifecycle(supabase, { appointmentId: body.appointmentId, orgId: auth.orgId });

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
};
