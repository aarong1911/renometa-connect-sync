/**
 * vapi-proxy.ts
 * Netlify Function — authenticated proxy for all Vapi API calls
 *
 * Deploy path: netlify/functions/vapi-proxy.ts
 *
 * Env vars required:
 *   VAPI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Env vars required for assistant create/update (POST /assistant, PATCH /assistant/{id}):
 *   VAPI_WEBHOOK_CREDENTIAL_ID  ← id of the pre-created Vapi Custom Credential
 *                                 ("RenoMeta Production Webhook (HMAC)") that
 *                                 holds the HMAC secret/algorithm/header config.
 *                                 Every assistant create/update is wired to it via
 *                                 server.credentialId so agents get working webhook
 *                                 auth with no manual Vapi-dashboard step. REQUIRED —
 *                                 if unset, assistant create/update is refused
 *                                 (503) rather than silently creating an assistant
 *                                 with no webhook authentication. Configure in the
 *                                 Netlify site's environment variables (same place
 *                                 as VAPI_API_KEY). See AI-H1.1 report.
 *
 * Usage from the client:
 *   POST /.netlify/functions/vapi-proxy
 *   Body: { path: '/assistant', method: 'POST', body: { ... } }
 *   Headers: { Authorization: 'Bearer <supabase_jwt>' }
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const VAPI_BASE = 'https://api.vapi.ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface ProxyRequest {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

const ALLOWED_PATH_PATTERNS = [
  /^\/assistant(\/[a-zA-Z0-9-]+)?$/,
  /^\/phone-number(\/[a-zA-Z0-9-]+)?$/,
  /^\/call(\/[a-zA-Z0-9-]+)?$/,
  /^\/call\/[a-zA-Z0-9-]+\/listen$/,
];

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(path));
}

async function authenticate(
  authHeader: string | undefined
): Promise<{ userId: string; tenantId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  console.log('[vapi-proxy] auth check:', { userId: user?.id, error: error?.message });

  if (error || !user) return null;

  const { data: membership } = await supabase
    .from('org_memberships')
    .select('org_id')
    .eq('member_id', user.id)
    .single();

  console.log('[vapi-proxy] membership:', membership);

  if (!membership?.org_id) return null;

  return { userId: user.id, tenantId: membership.org_id };
}

async function verifyOwnership(
  path: string,
  tenantId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const assistantMatch = path.match(/^\/assistant\/([a-zA-Z0-9-]+)$/);
  const phoneNumberMatch = path.match(/^\/phone-number\/([a-zA-Z0-9-]+)$/);
  const callMatch = path.match(/^\/call\/([a-zA-Z0-9-]+)/);

  if (assistantMatch) {
    const vapiId = assistantMatch[1];
    const { data } = await supabase
      .from('voice_agents')
      .select('id')
      .eq('vapi_assistant_id', vapiId)
      .eq('tenant_id', tenantId)
      .single();

    if (!data) return { allowed: false, reason: 'Assistant not found for this tenant' };
  }

  if (phoneNumberMatch) {
    const vapiId = phoneNumberMatch[1];
    const { data } = await supabase
      .from('voice_phone_numbers')
      .select('id')
      .eq('vapi_number_id', vapiId)
      .eq('tenant_id', tenantId)
      .single();

    if (!data) return { allowed: false, reason: 'Phone number not found for this tenant' };
  }

  if (callMatch) {
    const vapiId = callMatch[1];
    const { data } = await supabase
      .from('voice_calls')
      .select('id')
      .eq('vapi_call_id', vapiId)
      .eq('tenant_id', tenantId)
      .single();

    if (!data) return { allowed: false, reason: 'Call not found for this tenant' };
  }

  return { allowed: true };
}

async function syncToSupabase(
  path: string,
  method: string,
  tenantId: string,
  vapiResponse: Record<string, unknown>
): Promise<void> {
  try {
    // When a new Vapi assistant is created, link it to the existing CRM row.
    // The frontend already created the voice_agents row via handleAddAgent —
    // find the unlinked row and set its vapi_assistant_id.
    if (path === '/assistant' && method === 'POST') {
      const vapiAssistantId = vapiResponse.id as string;
      const agentName = vapiResponse.name as string;

      // Find the existing row: match by tenant + name + no vapi_assistant_id
      const { data: existing } = await supabase
        .from('voice_agents')
        .select('id')
        .eq('tenant_id', tenantId)
        .is('vapi_assistant_id', null)
        .eq('name', agentName)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        // Update the existing row — don't insert a new one
        await supabase
          .from('voice_agents')
          .update({
            vapi_assistant_id: vapiAssistantId,
            voice_id: ((vapiResponse.voice as Record<string, unknown>)?.voiceId as string) ?? '',
            voice_provider:
              ((vapiResponse.voice as Record<string, unknown>)?.provider as string) ?? '11labs',
            llm_model: ((vapiResponse.model as Record<string, unknown>)?.model as string) ?? '',
            llm_provider:
              ((vapiResponse.model as Record<string, unknown>)?.provider as string) ?? 'anthropic',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        console.log('[vapi-proxy] Linked Vapi assistant to existing row:', {
          agentId: existing.id,
          vapiAssistantId,
        });
      } else {
        // Fallback: no unlinked row found (edge case — agent created directly
        // via API without the CRM UI). Insert a new row.
        console.warn('[vapi-proxy] No unlinked agent row found, inserting new row');

        const { count } = await supabase
          .from('voice_agents')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('is_active', true);

        const isFirstAgent = (count ?? 0) === 0;

        await supabase.from('voice_agents').insert({
          tenant_id: tenantId,
          vapi_assistant_id: vapiAssistantId,
          name: agentName,
          system_prompt:
            ((vapiResponse.model as Record<string, unknown>)?.systemPrompt as string) ?? '',
          first_message: (vapiResponse.firstMessage as string) ?? '',
          voice_id: ((vapiResponse.voice as Record<string, unknown>)?.voiceId as string) ?? '',
          voice_provider:
            ((vapiResponse.voice as Record<string, unknown>)?.provider as string) ?? '11labs',
          llm_model: ((vapiResponse.model as Record<string, unknown>)?.model as string) ?? '',
          llm_provider:
            ((vapiResponse.model as Record<string, unknown>)?.provider as string) ?? 'anthropic',
          is_active: isFirstAgent,
        });
      }
    }

    if (path.startsWith('/assistant/') && method === 'PATCH') {
      const vapiId = path.split('/')[2];
      const patchVoiceId = (vapiResponse.voice as Record<string, unknown>)?.voiceId as
        | string
        | undefined;

      await supabase
        .from('voice_agents')
        .update({
          name: vapiResponse.name as string,
          system_prompt:
            ((vapiResponse.model as Record<string, unknown>)?.systemPrompt as string) ?? '',
          first_message: (vapiResponse.firstMessage as string) ?? '',
          ...(patchVoiceId && { voice_id: patchVoiceId }),
          updated_at: new Date().toISOString(),
        })
        .eq('vapi_assistant_id', vapiId)
        .eq('tenant_id', tenantId);
    }

    if (path.startsWith('/assistant/') && method === 'DELETE') {
      const vapiId = path.split('/')[2];

      await supabase
        .from('voice_agents')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('vapi_assistant_id', vapiId)
        .eq('tenant_id', tenantId);
    }

    if (path === '/phone-number' && method === 'POST') {
      await supabase.from('voice_phone_numbers').insert({
        tenant_id: tenantId,
        vapi_number_id: vapiResponse.id as string,
        number: vapiResponse.number as string,
        label: (vapiResponse.name as string) ?? null,
      });
    }

    // NOTE:
    // In webhook/serverUrl mode, Vapi often does NOT return assistantId here.
    // That means CRM routing cannot depend on this PATCH response to persist
    // voice_phone_numbers.agent_id.
    //
    // Direct CRM routing persistence now happens in assign-voice-number.ts.
    if (path.startsWith('/phone-number/') && method === 'PATCH') {
      const vapiId = path.split('/')[2];
      const assistantId = vapiResponse.assistantId as string | undefined;

      if (assistantId) {
        const { data: agent } = await supabase
          .from('voice_agents')
          .select('id')
          .eq('vapi_assistant_id', assistantId)
          .eq('tenant_id', tenantId)
          .single();

        if (agent) {
          await supabase
            .from('voice_phone_numbers')
            .update({ agent_id: agent.id, updated_at: new Date().toISOString() })
            .eq('vapi_number_id', vapiId)
            .eq('tenant_id', tenantId);
        }
      }
    }
  } catch (err) {
    console.error('[vapi-proxy] Supabase sync error:', err);
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = await authenticate(event.headers['authorization']);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { tenantId } = auth;

  let req: ProxyRequest;
  try {
    req = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { path, method = 'GET', body, query } = req;

  if (!path || !isAllowedPath(path)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Path not allowed' }) };
  }

  const isResourcePath = /\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+/.test(path);
  if (isResourcePath && method !== 'POST') {
    const { allowed, reason } = await verifyOwnership(path, tenantId);
    if (!allowed) {
      return { statusCode: 403, body: JSON.stringify({ error: reason }) };
    }
  }

  let vapiUrl = `${VAPI_BASE}${path}`;
  if (query && Object.keys(query).length > 0) {
    vapiUrl += `?${new URLSearchParams(query).toString()}`;
  }

  // AI-H1.1 Part 1 — every assistant create/update from RenoMeta configures
  // the RenoMeta webhook (serverUrl is always set by voice-agent-tab.tsx), so
  // it MUST also attach RenoMeta's HMAC webhook credential — a customer must
  // never end up with a Voice Agent that requires a later manual Vapi
  // dashboard step to receive authenticated webhook traffic. This is now a
  // hard requirement, not an opt-in: if VAPI_WEBHOOK_CREDENTIAL_ID is missing,
  // the write is refused before any Vapi API call is made — never silently
  // create/update an assistant with no working webhook auth.
  const isAssistantWrite =
    (path === '/assistant' && method === 'POST') ||
    (/^\/assistant\/[a-zA-Z0-9-]+$/.test(path) && method === 'PATCH');

  const credentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;

  if (isAssistantWrite && !credentialId) {
    console.error('[vapi-proxy] VAPI_WEBHOOK_CREDENTIAL_ID not configured — refusing assistant write');
    return {
      statusCode: 503,
      body: JSON.stringify({
        error: 'Voice Agent webhook credential is not configured on the server. Contact support.',
      }),
    };
  }

  const forwardBody: Record<string, unknown> | undefined =
    isAssistantWrite && body
      ? {
          ...body,
          server: {
            url: (body as Record<string, unknown>).serverUrl,
            credentialId,
          },
        }
      : body;

  let vapiRes: Response;
  try {
    vapiRes = await fetch(vapiUrl, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: forwardBody ? JSON.stringify(forwardBody) : undefined,
    });
  } catch (err) {
    console.error('[vapi-proxy] Vapi fetch error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Upstream error' }) };
  }

  const responseText = await vapiRes.text();

  if (!vapiRes.ok) {
    console.log('[vapi-proxy] Vapi error response:', vapiRes.status, responseText);
  }

  if (vapiRes.ok && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    try {
      const vapiData = JSON.parse(responseText);
      await syncToSupabase(path, method, tenantId, vapiData);
    } catch {
      // Fine for empty DELETE bodies, etc.
    }
  }

  return {
    statusCode: vapiRes.status,
    headers: { 'Content-Type': 'application/json' },
    body: responseText,
  };
};