import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import {
  WEBHOOK_URL,
  patchVapiPhoneNumberToWebhook,
  fetchVapiPhoneNumber,
} from './lib/vapi-phone-routing';

const VAPI_BASE = 'https://api.vapi.ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface AssignRequestBody {
  phoneNumberId: string; // Vapi phone number id
  agentId: string;       // CRM voice_agents.id
  setActive?: boolean;
}

async function authenticate(
  authHeader: string | undefined
): Promise<{ userId: string; tenantId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: membership } = await supabase
    .from('org_memberships').select('org_id').eq('member_id', user.id).single();
  if (!membership?.org_id) return null;
  return { userId: user.id, tenantId: membership.org_id };
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = await authenticate(event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { tenantId } = auth;

  let body: AssignRequestBody;
  try { body = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phoneNumberId, agentId, setActive = true } = body;

  if (!phoneNumberId || !agentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'phoneNumberId and agentId are required' }) };
  }

  // Verify phone number belongs to this tenant
  const { data: phoneRow, error: phoneErr } = await supabase
    .from('voice_phone_numbers')
    .select('id, tenant_id, vapi_number_id, number')
    .eq('vapi_number_id', phoneNumberId)
    .eq('tenant_id', tenantId)
    .single();

  if (phoneErr || !phoneRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Phone number not found for this tenant' }) };
  }

  // Verify agent belongs to this tenant and is not archived. Falls back to
  // an unfiltered lookup if archived_at doesn't exist yet in this
  // environment (AI-H1.1 Part 3 migration proposed, not yet applied).
  let { data: agentRow, error: agentErr } = await supabase
    .from('voice_agents')
    .select('id, tenant_id, vapi_assistant_id, name')
    .eq('id', agentId)
    .eq('tenant_id', tenantId)
    .is('archived_at', null)
    .single();

  if (agentErr?.code === '42703') {
    ({ data: agentRow, error: agentErr } = await supabase
      .from('voice_agents')
      .select('id, tenant_id, vapi_assistant_id, name')
      .eq('id', agentId)
      .eq('tenant_id', tenantId)
      .single());
  }

  if (agentErr || !agentRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Agent not found for this tenant' }) };
  }

  if (!agentRow.vapi_assistant_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Selected agent has no Vapi assistant ID' }) };
  }

  // Patch Vapi: clear assistantId, set serverUrl
  let patchPayload: any;
  let verifiedPhone: any;

  try {
    patchPayload = await patchVapiPhoneNumberToWebhook(phoneNumberId);
    verifiedPhone = await fetchVapiPhoneNumber(phoneNumberId);
  } catch (err) {
    console.error('[assign-voice-number] Vapi update failed:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to update Vapi phone number' }),
    };
  }

  const verifiedServerUrl  = verifiedPhone?.serverUrl  ?? patchPayload?.serverUrl  ?? null;
  const verifiedAssistantId = verifiedPhone?.assistantId ?? patchPayload?.assistantId ?? null;

  console.log('[assign-voice-number] Vapi state after patch', {
    serverUrl:   verifiedServerUrl,
    assistantId: verifiedAssistantId,
    phoneNumberId,
  });

  // serverUrl must be set; assistantId must be cleared
  if (verifiedServerUrl !== WEBHOOK_URL) {
    console.error('[assign-voice-number] serverUrl verification mismatch', {
      expected: WEBHOOK_URL,
      actual:   verifiedServerUrl,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Phone number did not switch to webhook routing mode in Vapi',
        details: { expectedServerUrl: WEBHOOK_URL, actualServerUrl: verifiedServerUrl },
      }),
    };
  }

  if (verifiedAssistantId) {
    // Vapi didn't clear the assistantId — log a warning but don't fail.
    // Some Vapi versions require a second PATCH with just assistantId: null.
    console.warn('[assign-voice-number] assistantId still set after patch — sending dedicated clear', {
      assistantId: verifiedAssistantId,
    });

    try {
      await fetch(`${VAPI_BASE}/phone-number/${phoneNumberId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assistantId: null }),
      });
    } catch (clearErr) {
      console.error('[assign-voice-number] assistantId clear failed:', clearErr);
    }
  }

  // Update Supabase: point phone number at this agent
  const { error: updatePhoneErr } = await supabase
    .from('voice_phone_numbers')
    .update({ agent_id: agentRow.id, updated_at: new Date().toISOString() })
    .eq('vapi_number_id', phoneNumberId)
    .eq('tenant_id', tenantId);

  if (updatePhoneErr) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Vapi updated, but failed to persist phone number mapping' }),
    };
  }

  // Optionally set this agent active and deactivate others
  if (setActive) {
    await supabase
      .from('voice_agents')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .neq('id', agentRow.id);

    await supabase
      .from('voice_agents')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('id', agentRow.id);
  }

  console.log('[assign-voice-number] success', {
    phoneNumberId,
    number:          phoneRow.number,
    agentId:         agentRow.id,
    agentName:       agentRow.name,
    vapiAssistantId: agentRow.vapi_assistant_id,
    verifiedServerUrl,
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:         true,
      phoneNumberId,
      agentId:         agentRow.id,
      agentName:       agentRow.name,
      vapiAssistantId: agentRow.vapi_assistant_id,
      routingMode:     'serverUrl',
      verifiedServerUrl,
      vapiPhoneNumber: verifiedPhone,
    }),
  };
};