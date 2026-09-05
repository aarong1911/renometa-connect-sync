/**
 * vapi-call-recording.ts
 * Netlify Function — secure server-side recording retrieval for a voice_calls row
 *
 * Deploy path: netlify/functions/vapi-call-recording.ts
 *
 * AI-H1.1 Part 20/21 — Vapi's call recording storage is now access-controlled
 * (see https://docs.vapi.ai/assistants/retrieve-call-artifacts): the
 * recording_url/stereo_recording_url values stored on voice_calls are no
 * longer guaranteed to be directly, publicly playable. The confirmed,
 * documented contract is:
 *
 *   GET https://api.vapi.ai/call/{id}/mono-recording
 *   Authorization: Bearer <VAPI_API_KEY>
 *   -> 302 redirect to a short-lived, authenticated signed URL
 *
 * This function holds VAPI_API_KEY server-side only, verifies the caller's
 * org owns the requested call, follows that redirect itself, and hands the
 * browser just the short-lived signed URL — never the private API key, and
 * never another org's call.
 *
 * Env vars required:
 *   VAPI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage from the client:
 *   POST /.netlify/functions/vapi-call-recording
 *   Body: { callId: '<voice_calls.id>', track?: 'mono' | 'stereo' | 'customer' | 'assistant' }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { resolveOrgFromBearerToken } from './lib/resolve-org';

const VAPI_BASE = 'https://api.vapi.ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TRACK_ENDPOINTS: Record<string, string> = {
  mono: 'mono-recording',
  stereo: 'stereo-recording',
  customer: 'customer-recording',
  assistant: 'assistant-recording',
};

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = await resolveOrgFromBearerToken(supabase, event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: { callId?: string; track?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { callId } = body;
  const track = TRACK_ENDPOINTS[body.track ?? 'mono'] ? (body.track ?? 'mono') : 'mono';

  if (!callId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'callId is required' }) };
  }

  // Org ownership check happens here, before any Vapi call is made — never
  // trust a client-supplied vapi_call_id directly.
  const { data: callRow, error: callErr } = await supabase
    .from('voice_calls')
    .select('id, vapi_call_id')
    .eq('id', callId)
    .eq('tenant_id', auth.orgId)
    .maybeSingle();

  if (callErr || !callRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Call not found' }) };
  }

  if (!callRow.vapi_call_id) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No recording available for this call' }) };
  }

  try {
    const vapiRes = await fetch(
      `${VAPI_BASE}/call/${callRow.vapi_call_id}/${TRACK_ENDPOINTS[track]}`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      }
    );

    // Documented contract: a 302 redirect to a short-lived signed URL.
    if (vapiRes.status >= 300 && vapiRes.status < 400) {
      const signedUrl = vapiRes.headers.get('location');
      if (!signedUrl) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Recording redirect missing a location' }) };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: signedUrl }),
      };
    }

    if (vapiRes.status === 404) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No recording available for this call' }) };
    }

    console.error('[vapi-call-recording] unexpected Vapi response', { status: vapiRes.status });
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to retrieve recording' }) };
  } catch (err) {
    console.error('[vapi-call-recording] fetch failed', { message: err instanceof Error ? err.message : String(err) });
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to retrieve recording' }) };
  }
};
