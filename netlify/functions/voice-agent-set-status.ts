/**
 * voice-agent-set-status.ts
 * Netlify Function — Activate/Pause a Voice Agent, keeping Vapi phone-number
 * routing consistent with local state (AI-H1.1 Part 2).
 *
 * Routing reality (confirmed from vapi-webhook.ts + Vapi's own API docs):
 * Vapi phone numbers in this product are always kept in "serverUrl mode"
 * (assistantId cleared, serverUrl set to vapi-webhook.ts) — the actual
 * assistant used for each inbound call is decided live, per call, by
 * vapi-webhook.ts's assistant-request handler, not by a static field on the
 * Vapi phone-number resource. That handler now (AI-H1.1 Part 2 fix) only
 * honors a phone number's mapped agent_id while that agent is is_active —
 * a paused agent can never be returned. That means:
 *
 *   ACTIVATE: no Vapi mutation is strictly required for correctness (the
 *   webhook already resolves to whichever agent is_active), but this
 *   endpoint proactively re-points every org phone number at the newly
 *   active agent and re-verifies each one is still in serverUrl mode
 *   before flipping local is_active — so voice_phone_numbers.agent_id
 *   reflects reality immediately rather than only after the next inbound
 *   call self-heals it.
 *
 *   PAUSE: likewise no Vapi mutation is required — the assistant-request
 *   fix guarantees a paused agent is never returned regardless of what
 *   voice_phone_numbers.agent_id says. This endpoint still clears any
 *   number's agent_id that pointed at the now-paused agent, as
 *   defense-in-depth so local state doesn't display a stale mapping.
 *
 * Env vars required:
 *   VAPI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage from the client:
 *   POST /.netlify/functions/voice-agent-set-status
 *   Body: { agentId: string, active: boolean }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { resolveOrgFromBearerToken } from './lib/resolve-org';
import { verifyPhoneNumberInWebhookMode } from './lib/vapi-phone-routing';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface SetStatusBody {
  agentId?: string;
  active?: boolean;
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = await resolveOrgFromBearerToken(supabase, event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: SetStatusBody;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { agentId, active } = body;
  if (!agentId || typeof active !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'agentId and active are required' }) };
  }

  // Excludes archived agents. Falls back to an unfiltered lookup if
  // archived_at doesn't exist yet in this environment (AI-H1.1 Part 3
  // migration proposed, not yet applied).
  let { data: agentRow, error: agentErr } = await supabase
    .from('voice_agents')
    .select('id, tenant_id, name, vapi_assistant_id')
    .eq('id', agentId)
    .eq('tenant_id', auth.orgId)
    .is('archived_at', null)
    .maybeSingle();

  if (agentErr?.code === '42703') {
    ({ data: agentRow, error: agentErr } = await supabase
      .from('voice_agents')
      .select('id, tenant_id, name, vapi_assistant_id')
      .eq('id', agentId)
      .eq('tenant_id', auth.orgId)
      .maybeSingle());
  }

  if (agentErr || !agentRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Agent not found for this organization' }) };
  }

  if (active) {
    if (!agentRow.vapi_assistant_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Save this agent before activating it' }),
      };
    }

    const { data: orgNumbers, error: numbersErr } = await supabase
      .from('voice_phone_numbers')
      .select('id, vapi_number_id, agent_id')
      .eq('tenant_id', auth.orgId);

    if (numbersErr) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load phone numbers' }) };
    }

    const numbersToRepoint = (orgNumbers ?? []).filter(
      (n) => n.agent_id !== agentRow.id && !!n.vapi_number_id
    );

    // Provider-first: verify EVERY number that needs repointing before any
    // local write — a partial repoint (some numbers verified, others not)
    // must not be reported as success.
    for (const pn of numbersToRepoint) {
      try {
        await verifyPhoneNumberInWebhookMode(pn.vapi_number_id!);
      } catch (err) {
        console.error('[voice-agent-set-status] Vapi verification failed during activate', {
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          statusCode: 502,
          body: JSON.stringify({
            error: 'Could not confirm phone routing with the voice provider. Agent was not activated.',
          }),
        };
      }
    }

    for (const pn of numbersToRepoint) {
      await supabase
        .from('voice_phone_numbers')
        .update({ agent_id: agentRow.id, updated_at: new Date().toISOString() })
        .eq('id', pn.id);
    }

    await supabase
      .from('voice_agents')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', auth.orgId)
      .neq('id', agentRow.id);

    await supabase
      .from('voice_agents')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', agentRow.id);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, agentId: agentRow.id, active: true, repointedNumbers: numbersToRepoint.length }),
    };
  }

  // Pause: no Vapi mutation needed (see file header) — local state only.
  await supabase
    .from('voice_agents')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', agentRow.id);

  await supabase
    .from('voice_phone_numbers')
    .update({ agent_id: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', auth.orgId)
    .eq('agent_id', agentRow.id);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, agentId: agentRow.id, active: false }),
  };
};
