/**
 * voice-agent-archive.ts
 * Netlify Function — Archive a Voice Agent, atomic from the user's
 * perspective (AI-H1.1 correction pass).
 *
 * Normal user-facing removal is Archive, not destructive hard-delete:
 * voice_calls.agent_id is historical identity for real past calls, and a
 * hard delete would either dangle that reference or (with a cascading FK)
 * silently erase which agent handled a historical call. Archiving instead
 * keeps the row, only ever marking it archived_at + is_active:false.
 *
 * Ordering (no irreversible local mutation before the provider operation
 * succeeds — this is the fix over the first AI-H1.1 pass, which detached
 * phone numbers locally BEFORE attempting the Vapi delete):
 *
 *   1. load the current agent row AND its current phone mappings (read-only)
 *   2. delete the Vapi assistant (404 = already gone = treated as success)
 *      — if this fails, return an error; NOTHING local has been touched
 *   3. only now mark voice_agents.archived_at / is_active locally
 *   4. if that local write fails, attempt to recreate the Vapi assistant
 *      from the config captured in step 1 (a real rollback: the assistant
 *      keeps working, under a new Vapi id) and report a plain failure; if
 *      recreation itself fails, return an explicit reconciliation error —
 *      never report success when RenoMeta and Vapi disagree
 *   5. only after the agent is confirmed archived, best-effort detach any
 *      phone numbers that pointed at it — non-critical, since
 *      vapi-webhook.ts's assistant-request handler already refuses to
 *      route calls to a non-active agent regardless of a stale mapping
 *
 * Depends on the archived_at column added in
 * supabase/migrations/20260905_voice_agents_archive.sql.
 *
 * Env vars required:
 *   VAPI_API_KEY
 *   VAPI_WEBHOOK_CREDENTIAL_ID (only needed for the recreate-on-rollback path)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage from the client:
 *   POST /.netlify/functions/voice-agent-archive
 *   Body: { agentId: string }
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

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = await resolveOrgFromBearerToken(supabase, event.headers.authorization);
  if (!auth) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: { agentId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { agentId } = body;
  if (!agentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agentId is required' }) };
  }

  // 1. Read-only: capture the agent's current config and phone mappings —
  // nothing is mutated yet.
  const { data: agentRow, error: agentErr } = await supabase
    .from('voice_agents')
    .select('id, tenant_id, name, system_prompt, first_message, voice_id, llm_model, end_call_phrases, crm_tools, vapi_assistant_id, archived_at')
    .eq('id', agentId)
    .eq('tenant_id', auth.orgId)
    .maybeSingle();

  if (agentErr?.code === '42703') {
    return {
      statusCode: 501,
      body: JSON.stringify({ error: 'Archive is not yet enabled on this environment (pending database migration).' }),
    };
  }

  if (agentErr || !agentRow) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Agent not found for this organization' }) };
  }

  if (agentRow.archived_at) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, alreadyArchived: true }) };
  }

  // 2. Provider first: delete the Vapi assistant. No local mutation happens
  // before this succeeds (or is confirmed already gone).
  let assistantAlreadyGone = false;
  if (agentRow.vapi_assistant_id) {
    try {
      const res = await fetch(`${VAPI_BASE}/assistant/${agentRow.vapi_assistant_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      });

      if (!res.ok) {
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

        // Confirmed from a live call: Vapi does NOT return 404/410 for a
        // delete on an already-gone assistant — it returns 400 with
        // { message: "Assistant not found", error: "Bad Request",
        // statusCode: 400 }. Treat only that specific, confirmed shape (plus
        // literal 404/410, in case Vapi's behavior differs by resource
        // state or changes in the future) as "already gone" — every other
        // 4xx/5xx still fails closed below. Deliberately narrow: do not
        // swallow 4xx errors in general.
        const isAlreadyGone =
          res.status === 404 ||
          res.status === 410 ||
          (res.status === 400 && typeof json?.message === 'string' && /assistant not found/i.test(json.message));

        if (!isAlreadyGone) {
          console.error('[voice-agent-archive] Vapi assistant delete failed', {
            agentId,
            status: res.status,
            providerError: json?.error,
            providerMessage: json?.message,
          });
          return {
            statusCode: 502,
            body: JSON.stringify({ error: 'Could not remove the voice provider assistant. Agent was not archived.' }),
          };
        }

        assistantAlreadyGone = true;
        console.warn('[voice-agent-archive] Vapi assistant already gone — continuing archive locally', {
          agentId,
          status: res.status,
        });
      }
    } catch (err) {
      console.error('[voice-agent-archive] Vapi assistant delete threw', {
        agentId,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not reach the voice provider. Agent was not archived.' }),
      };
    }
  }

  // 3. Only now mark it archived and inactive locally. The row itself is
  // kept so historical voice_calls.agent_id references keep resolving.
  const { error: archiveErr } = await supabase
    .from('voice_agents')
    .update({ archived_at: new Date().toISOString(), is_active: false, updated_at: new Date().toISOString() })
    .eq('id', agentRow.id);

  if (archiveErr) {
    console.error('[voice-agent-archive] local archive write failed after Vapi delete succeeded — attempting rollback', {
      agentId,
      assistantAlreadyGone,
    });

    // 4. Vapi assistant is gone but the local row still thinks it isn't
    // archived — recreate the assistant from the config we captured in
    // step 1 so the agent keeps working under a new Vapi id, rather than
    // leaving RenoMeta and Vapi disagreeing.
    //
    // EXCEPT when the assistant was already gone before this request ever
    // ran (e.g. someone manually deleted it in the Vapi dashboard) — in
    // that case Vapi's current state (no assistant) is already the
    // intended end state, and "restoring" it would recreate something a
    // human deliberately removed. Skip straight to the reconciliation
    // error instead.
    const credentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;
    if (!assistantAlreadyGone && agentRow.vapi_assistant_id && credentialId) {
      try {
        const recreateBody = buildVapiAssistantBody({
          name: agentRow.name,
          greeting: agentRow.first_message,
          llm: agentRow.llm_model,
          systemPrompt: agentRow.system_prompt ?? '',
          voice: agentRow.voice_id,
          endPhrases: agentRow.end_call_phrases ?? 'goodbye, bye, thank you bye',
          crmTools: (agentRow.crm_tools as CrmTools) ?? DEFAULT_CRM_TOOLS,
          credentialId,
          includeCreateOnlyFields: true,
        });

        const recreateRes = await fetch(`${VAPI_BASE}/assistant`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(recreateBody),
        });

        if (recreateRes.ok) {
          const recreated = await recreateRes.json();
          const newAssistantId = recreated?.id ?? recreated?.assistantId ?? null;

          if (newAssistantId) {
            await supabase
              .from('voice_agents')
              .update({ vapi_assistant_id: newAssistantId, updated_at: new Date().toISOString() })
              .eq('id', agentRow.id);
          }

          return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Archive failed. The agent was restored and is still active.' }),
          };
        }

        console.error('[voice-agent-archive] rollback recreate failed — reconciliation required', { agentId });
      } catch (err) {
        console.error('[voice-agent-archive] rollback recreate threw — reconciliation required', {
          agentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: assistantAlreadyGone
          ? 'Archive failed to save. The voice provider assistant was already removed (outside RenoMeta) — contact support to reconcile this agent\'s status.'
          : 'Archive failed, and the voice provider assistant could not be safely restored. Contact support to reconcile — RenoMeta and the voice provider may now disagree.',
      }),
    };
  }

  // 5. Best-effort, non-critical: detach any phone number that pointed at
  // this now-archived agent. Not required for correctness — an archived
  // agent is is_active:false, and vapi-webhook.ts's assistant-request
  // handler already refuses to route calls to a non-active agent — but
  // this keeps voice_phone_numbers.agent_id from displaying a stale
  // mapping in the UI.
  const { error: detachErr } = await supabase
    .from('voice_phone_numbers')
    .update({ agent_id: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', auth.orgId)
    .eq('agent_id', agentRow.id);

  if (detachErr) {
    console.error('[voice-agent-archive] phone detach failed after successful archive (non-critical)', { agentId });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, agentId: agentRow.id }),
  };
};
