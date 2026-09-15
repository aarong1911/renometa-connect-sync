/**
 * voice-call-delete.ts
 * Netlify Function — admin/owner-only deletion of a single voice_calls row
 * (RenoMeta-local log cleanup only; AI-H1.1 admin utility).
 *
 * This is exact-ID deletion of one Call Log row, for cleaning up broken
 * historical test rows (duplicate/test calls, malformed 0:00/Ringing
 * records). It never touches the voice provider (no Vapi API call is made
 * here at all — no VAPI_API_KEY reference), and never deletes CRM records
 * created from the call (contacts, leads, deals, projects, appointments).
 *
 * Foreign keys referencing voice_calls.id (confirmed via the live schema's
 * PostgREST-exposed relationships — not guessed):
 *   - voice_call_tools.call_id  → voice_calls.id
 *   - appointments.voice_call_id → voice_calls.id
 * ON DELETE behavior for these constraints could not be introspected
 * directly (no accessible catalog/RPC), so this function does not rely on
 * it: it explicitly deletes voice_call_tools rows for this call (they are
 * call-scoped audit data with no independent value once the call is gone)
 * and explicitly nulls appointments.voice_call_id for this call (the
 * appointment itself must never be deleted) BEFORE deleting the voice_calls
 * row — guaranteeing the required outcome regardless of what the
 * underlying constraints actually do.
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage from the client:
 *   POST /.netlify/functions/voice-call-delete
 *   Body: { callId: string }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { resolveOrgAndAuthority } from './lib/resolve-org';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// AI-1M security completion pass: this used to carry its own inline
// resolveOrgAndAuthority() that treated "profile.organization_id is set"
// as proof of owner/admin authority. Live data proved that assumption
// unsafe — profiles.organization_id is populated for every org member
// (viewer, project_manager, etc.), not just the owner/creator — so that
// shortcut granted call-log-deletion authority to any org member. Now
// uses the canonical resolveOrgAndAuthority() from lib/resolve-org.ts,
// which resolves authority from org_memberships.role exclusively
// (falling back to profiles.role === "owner" only when no membership row
// exists at all). See that file's header for the full rationale.

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const authHeader = event.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabase, user.id);
  if (!orgId) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Could not resolve your organization.' }) };
  }
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only an organization owner or admin may delete call logs.' }) };
  }

  let body: { callId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { callId } = body;
  if (!callId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'callId is required' }) };
  }

  // Ownership check: the call must belong to the resolved org — callId
  // alone (without this filter) would let any authenticated admin delete
  // any org's call by guessing/enumerating ids.
  const { data: callRow, error: loadErr } = await supabase
    .from('voice_calls')
    .select('id')
    .eq('id', callId)
    .eq('tenant_id', orgId)
    .maybeSingle();

  if (loadErr) {
    console.error('[voice-call-delete] load failed', { callId, orgId, code: loadErr.code });
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load call log' }) };
  }

  if (!callRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Call log not found for this organization' }) };
  }

  // Detach dependent appointment references FIRST — an appointment must
  // never be deleted or orphaned-in-error just because its source call log
  // is deleted.
  const { error: detachErr } = await supabase
    .from('appointments')
    .update({ voice_call_id: null })
    .eq('voice_call_id', callId);

  if (detachErr) {
    console.error('[voice-call-delete] appointment detach failed', { callId, orgId, code: detachErr.code });
    return { statusCode: 409, body: JSON.stringify({ error: 'Could not safely detach a related appointment. Call log was not deleted.' }) };
  }

  // Delete call-scoped audit rows — these have no meaning independent of
  // the call itself.
  const { error: toolsErr } = await supabase
    .from('voice_call_tools')
    .delete()
    .eq('call_id', callId);

  if (toolsErr) {
    console.error('[voice-call-delete] voice_call_tools cleanup failed', { callId, orgId, code: toolsErr.code });
    return { statusCode: 409, body: JSON.stringify({ error: 'Could not clean up related call activity. Call log was not deleted.' }) };
  }

  const { error: deleteErr } = await supabase
    .from('voice_calls')
    .delete()
    .eq('id', callId)
    .eq('tenant_id', orgId);

  if (deleteErr) {
    console.error('[voice-call-delete] delete failed', { callId, orgId, code: deleteErr.code, message: deleteErr.message });
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to delete call log' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, callId }),
  };
};
