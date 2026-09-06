// netlify/functions/lib/voice-call-audit.ts
//
// Plumbing for the Voice webhook's per-call bookkeeping:
//   * resolve (or create) the internal voice_calls.id for a Vapi call id
//   * persist voice_call_tools audit rows  — AWAITED, never fire-and-forget
//   * backfill voice_calls.contact_id from authoritative scheduling state
//   * derive voice_calls.outcome from authoritative transaction state
//
// WHY THIS EXISTS: the webhook previously wrote voice_call_tools from an
// un-awaited `(async () => { … })()` IIFE. On Netlify (Lambda) the execution
// context is frozen the instant the HTTP response is returned, so that
// pending insert (a voice_calls lookup + a voice_call_tools insert — two
// round-trips) frequently never completed. Awaited call-started writes
// survived; the fire-and-forget audit did not. Same root cause left
// contact/outcome linkage unreliable. Everything here is awaited by the
// caller.
//
// CONTRACT: a failed audit write MUST NOT block or fail the tool
// transaction — these helpers never throw; they log and return.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditDeps {
  supabase: SupabaseClient;
  now?: () => Date;
}

const isoNow = (d: AuditDeps) => (d.now ? d.now() : new Date()).toISOString();

function alog(msg: string, f?: Record<string, unknown>) {
  console.log(`[voice-call-audit] ${msg}`, f ? JSON.stringify(f) : '');
}
function aerr(msg: string, f?: Record<string, unknown>) {
  console.error(`[voice-call-audit] ERROR ${msg}`, f ? JSON.stringify(f) : '');
}

/**
 * Internal voice_calls.id for a Vapi call id. If the call-started webhook
 * has not landed yet, create a minimal row so tool audit + contact linkage
 * always have a real id to hang off (the row is later completed by
 * handleCallStarted / handleEndOfCallReport via the same onConflict key).
 */
export async function resolveVoiceCallId(
  deps: AuditDeps,
  params: {
    vapiCallId: string;
    tenantId: string;
    agentId?: string | null;
    callerNumber?: string | null;
    direction?: string;
  },
): Promise<string | null> {
  const { vapiCallId, tenantId } = params;

  const { data, error } = await deps.supabase
    .from('voice_calls')
    .select('id')
    .eq('vapi_call_id', vapiCallId)
    .maybeSingle();
  if (error) aerr('voice_calls lookup failed', { vapiCallId });
  if (data?.id) return data.id as string;

  const { data: ins, error: insErr } = await deps.supabase
    .from('voice_calls')
    .upsert(
      {
        vapi_call_id: vapiCallId,
        tenant_id: tenantId,
        agent_id: params.agentId ?? null,
        direction: params.direction ?? 'inbound',
        status: 'in_progress',
        caller_number: params.callerNumber ?? null,
        started_at: isoNow(deps),
      },
      { onConflict: 'vapi_call_id' },
    )
    .select('id')
    .single();

  if (insErr || !ins?.id) {
    aerr('voice_calls upsert failed — tool audit will be skipped', { vapiCallId });
    return null;
  }
  alog('created missing voice_calls row for tool call', { vapiCallId, voiceCallId: ins.id });
  return ins.id as string;
}

export interface ToolAuditEntry {
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  errorMsg?: string | null;
}

/**
 * Persist one voice_call_tools row per tool invocation. Awaited by the
 * caller. Never throws; a failure is logged and swallowed so it cannot
 * block the tool response.
 */
export async function recordToolInvocations(
  deps: AuditDeps,
  params: { voiceCallId: string | null; tenantId: string; entries: ToolAuditEntry[] },
): Promise<{ written: number }> {
  const { voiceCallId, tenantId, entries } = params;
  if (entries.length === 0) return { written: 0 };
  if (!voiceCallId) {
    aerr('no voice_calls.id resolved — tool audit skipped', { toolCount: entries.length });
    return { written: 0 };
  }

  const rows = entries.map((e) => ({
    call_id: voiceCallId,
    tenant_id: tenantId,
    tool_name: e.toolName,
    arguments: e.args,
    result: { text: e.resultText },
    error: e.errorMsg ?? null,
  }));

  try {
    const { error } = await deps.supabase.from('voice_call_tools').insert(rows);
    if (error) {
      aerr('voice_call_tools insert failed', { count: rows.length, code: (error as { code?: string }).code });
      return { written: 0 };
    }
    alog('voice_call_tools written', { count: rows.length, voiceCallId });
    return { written: rows.length };
  } catch (err) {
    aerr('voice_call_tools insert threw', { message: err instanceof Error ? err.message : String(err) });
    return { written: 0 };
  }
}

/**
 * Ensure voice_calls.contact_id reflects the contact the scheduling state
 * recorded (save_lead writes it into voice_call_scheduling_state via
 * persistLeadLinkage). This backfills the case where save_lead's own
 * voice_calls update did not persist.
 */
export async function backfillCallContact(
  deps: AuditDeps,
  params: { vapiCallId: string; voiceCallId: string | null; tenantId: string },
): Promise<void> {
  const { vapiCallId, voiceCallId, tenantId } = params;
  if (!voiceCallId) return;

  const { data: st } = await deps.supabase
    .from('voice_call_scheduling_state')
    .select('contact_id')
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', tenantId)
    .maybeSingle();

  const contactId = st?.contact_id as string | undefined;
  if (!contactId) return;

  const { data: vc } = await deps.supabase
    .from('voice_calls')
    .select('contact_id')
    .eq('id', voiceCallId)
    .maybeSingle();
  if (vc?.contact_id) return; // already linked

  const { error } = await deps.supabase
    .from('voice_calls')
    .update({ contact_id: contactId })
    .eq('id', voiceCallId);
  if (error) aerr('contact_id backfill failed', { voiceCallId });
  else alog('contact_id backfilled onto voice_calls', { voiceCallId });
}

/**
 * Authoritative call outcome. If this call actually produced or moved an
 * appointment, the outcome is 'appointment_booked' regardless of what the
 * fuzzy summary text says. Otherwise fall back to the summary-derived
 * classification.
 */
export async function resolveAuthoritativeOutcome(
  deps: AuditDeps,
  params: { voiceCallId: string | null; vapiCallId: string; tenantId: string; summaryOutcome: string },
): Promise<string> {
  const { voiceCallId, vapiCallId, tenantId, summaryOutcome } = params;

  if (voiceCallId) {
    const { data: appt } = await deps.supabase
      .from('appointments')
      .select('id')
      .eq('org_id', tenantId)
      .eq('voice_call_id', voiceCallId)
      .neq('status', 'cancelled')
      .limit(1)
      .maybeSingle();
    if (appt?.id) return 'appointment_booked';
  }

  const { data: st } = await deps.supabase
    .from('voice_call_scheduling_state')
    .select('resulting_appointment_id')
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', tenantId)
    .maybeSingle();
  if (st?.resulting_appointment_id) return 'appointment_booked';

  return summaryOutcome;
}
