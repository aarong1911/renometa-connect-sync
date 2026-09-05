/**
 * voice-agent-save.ts
 * Netlify Function — Create/Edit a Voice Agent with no DB/Vapi drift
 * (AI-H1.1 correction pass).
 *
 * A RenoMeta customer's saved Voice Agent configuration must always match
 * what's actually running in Vapi. This endpoint is therefore
 * provider-first for every field the Vapi assistant is built from (name,
 * prompt, greeting, voice, model, CRM tools):
 *
 *   1. load the CURRENT row (kept in memory as the rollback target)
 *   2. PATCH/POST Vapi with the NEW configuration
 *   3. only after Vapi confirms success, persist the NEW configuration locally
 *   4. if the local write then fails, attempt a compensating Vapi operation
 *      to restore the OLD configuration (PATCH back to old config on an
 *      edit; DELETE the just-created assistant on a create, since the
 *      local row never learned its id) — and only report success if
 *      RenoMeta and Vapi end up agreeing, one way or the other
 *
 * No Vapi call happens from browser code — the client sends only its raw
 * form fields; this function builds the actual Vapi payload (including the
 * required webhook credential, which never leaves the server) and performs
 * every Vapi API call itself with VAPI_API_KEY.
 *
 * Env vars required:
 *   VAPI_API_KEY
 *   VAPI_WEBHOOK_CREDENTIAL_ID
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage from the client:
 *   POST /.netlify/functions/voice-agent-save
 *   Body: { agentId, name, systemPrompt, greeting, voice, llmModel, endCallPhrases, crmTools }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { resolveOrgFromBearerToken } from './lib/resolve-org';
import { buildVapiAssistantBody, DEFAULT_CRM_TOOLS, type CrmTools } from './lib/vapi-assistant-body';

const VAPI_BASE = 'https://api.vapi.ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface SaveRequestBody {
  agentId?: string;
  name?: string;
  systemPrompt?: string;
  greeting?: string;
  voice?: string;
  llmModel?: string;
  endCallPhrases?: string;
  crmTools?: CrmTools;
}

async function vapiFetch(path: string, method: string, body: unknown) {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, text };
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = await resolveOrgFromBearerToken(supabase, event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: SaveRequestBody;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { agentId, name, systemPrompt, greeting, voice, llmModel, endCallPhrases, crmTools } = body;

  if (!agentId || !name || !greeting || !voice || !llmModel) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agentId, name, greeting, voice, and llmModel are required' }) };
  }

  const credentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;
  if (!credentialId) {
    console.error('[voice-agent-save] VAPI_WEBHOOK_CREDENTIAL_ID not configured — refusing save');
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Voice Agent webhook credential is not configured on the server. Contact support.' }),
    };
  }

  const { data: currentRow, error: loadErr } = await supabase
    .from('voice_agents')
    .select('id, tenant_id, name, system_prompt, first_message, voice_id, llm_model, end_call_phrases, crm_tools, vapi_assistant_id')
    .eq('id', agentId)
    .eq('tenant_id', auth.orgId)
    .is('archived_at', null)
    .maybeSingle();

  if (loadErr || !currentRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Agent not found for this organization' }) };
  }

  const newCrmTools = crmTools ?? DEFAULT_CRM_TOOLS;
  // Vapi's assistant body wants a comma-separated string (buildVapiAssistantBody
  // splits it itself), but voice_agents.end_call_phrases is a native Postgres
  // array column — writing the raw string there fails with 22P02 "malformed
  // array literal". Keep both representations explicit rather than
  // reusing one value for two different shapes.
  const newEndPhrasesInput = endCallPhrases ?? 'goodbye, bye, thank you bye';
  const newEndPhrasesArray = newEndPhrasesInput
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const newVapiBody = buildVapiAssistantBody({
    name,
    greeting,
    llm: llmModel,
    systemPrompt: systemPrompt ?? '',
    voice,
    endPhrases: newEndPhrasesInput,
    crmTools: newCrmTools,
    credentialId,
    includeCreateOnlyFields: !currentRow.vapi_assistant_id,
  });

  const isCreate = !currentRow.vapi_assistant_id;

  // 1. Provider first.
  const providerRes = isCreate
    ? await vapiFetch('/assistant', 'POST', newVapiBody)
    : await vapiFetch(`/assistant/${currentRow.vapi_assistant_id}`, 'PATCH', newVapiBody);

  if (!providerRes.ok) {
    console.error('[voice-agent-save] Vapi write failed', { agentId, isCreate, status: providerRes.status });
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Could not save to the voice provider. No changes were made.' }),
    };
  }

  const newAssistantId: string | null = isCreate
    ? (providerRes.json?.id ?? providerRes.json?.assistantId ?? null)
    : currentRow.vapi_assistant_id;

  if (isCreate && !newAssistantId) {
    console.error('[voice-agent-save] Vapi create succeeded but returned no assistant id', { agentId });
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Voice provider did not confirm the new assistant. No changes were made.' }),
    };
  }

  // 2. Only now persist locally.
  const { error: dbErr } = await supabase
    .from('voice_agents')
    .update({
      name,
      system_prompt: systemPrompt ?? '',
      first_message: greeting,
      voice_id: voice,
      llm_model: llmModel,
      end_call_phrases: newEndPhrasesArray,
      crm_tools: newCrmTools,
      vapi_assistant_id: newAssistantId,
      updated_at: new Date().toISOString(),
    } as any)
    .eq('id', agentId)
    .eq('tenant_id', auth.orgId);

  if (!dbErr) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, vapiAssistantId: newAssistantId }),
    };
  }

  // 3. Local write failed after a successful provider write — compensate.
  // Sanitized diagnostic fields only: never log prompt/greeting/name/crmTools
  // content, credentials, or the request body.
  console.error('[voice-agent-save] local persist failed after Vapi succeeded, attempting rollback', {
    agentId,
    isCreate,
    code: dbErr.code,
    message: dbErr.message,
    details: dbErr.details,
    hint: dbErr.hint,
  });

  if (isCreate) {
    // Nothing local ever learned this assistant existed — delete it so no
    // orphan is left in Vapi.
    const cleanup = await vapiFetch(`/assistant/${newAssistantId}`, 'DELETE', undefined);
    if (cleanup.ok || cleanup.status === 404) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Save failed. No changes were made.' }),
      };
    }

    console.error('[voice-agent-save] rollback DELETE failed — reconciliation required', {
      agentId,
      vapiAssistantId: newAssistantId,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Save failed and automatic cleanup did not succeed. A voice provider assistant may exist with no matching RenoMeta agent — contact support to reconcile.',
      }),
    };
  }

  // Edit: restore the OLD configuration on Vapi. voice_agents.end_call_phrases
  // comes back from Postgres as an array (see note above) — buildVapiAssistantBody
  // wants the comma-separated string form, so re-join it.
  const oldEndPhrases = Array.isArray(currentRow.end_call_phrases)
    ? currentRow.end_call_phrases.join(', ')
    : (currentRow.end_call_phrases ?? 'goodbye, bye, thank you bye');

  const oldVapiBody = buildVapiAssistantBody({
    name: currentRow.name,
    greeting: currentRow.first_message,
    llm: currentRow.llm_model,
    systemPrompt: currentRow.system_prompt ?? '',
    voice: currentRow.voice_id,
    endPhrases: oldEndPhrases,
    crmTools: (currentRow.crm_tools as CrmTools) ?? DEFAULT_CRM_TOOLS,
    credentialId,
  });

  const rollback = await vapiFetch(`/assistant/${currentRow.vapi_assistant_id}`, 'PATCH', oldVapiBody);

  if (rollback.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Save failed. No changes were made.' }),
    };
  }

  console.error('[voice-agent-save] rollback PATCH failed — reconciliation required', {
    agentId,
    vapiAssistantId: currentRow.vapi_assistant_id,
  });
  return {
    statusCode: 500,
    body: JSON.stringify({
      error: 'Save failed, and the voice provider could not be restored to its previous configuration. Contact support to reconcile — RenoMeta and the voice provider may now disagree.',
    }),
  };
};
