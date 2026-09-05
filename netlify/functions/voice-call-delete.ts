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

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Same org+authority resolution pattern already established in
// agent-approve-action.ts — a user whose profile directly carries
// organization_id is the account's own owner/creator; otherwise fall back
// to org_memberships.role. Reused here rather than reinvented.
async function resolveOrgAndAuthority(userId: string): Promise<{ orgId: string | null; isOwnerOrAdmin: boolean }> {
  const { data: profile } = await supabase.from('profiles').select('organization_id').eq('id', userId).maybeSingle();
  if (profile?.organization_id) {
    return { orgId: profile.organization_id, isOwnerOrAdmin: true };
  }
  const { data: membership } = await supabase.from('org_memberships').select('org_id, role').eq('member_id', userId).maybeSingle();
  if (!membership) return { orgId: null, isOwnerOrAdmin: false };
  return { orgId: membership.org_id, isOwnerOrAdmin: membership.role === 'owner' || membership.role === 'admin' };
}

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

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(user.id);
  if (!orgId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
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
