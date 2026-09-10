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
  if (data?.id) {
    alog('resolveVoiceCallId: existing row', { vapiCallId, voiceCallId: data.id });
    return data.id as string;
  }

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

// Comparison-safe phone normalization + the small set of stored-string
// variants a 10-digit US number could appear as (E.164, formatted, etc.).
// Inlined (rather than imported from meta-lead-normalization) to keep the
// Voice audit path free of unrelated coupling.
function normalizePhoneDigits(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}
function phoneVariants(norm: string): string[] {
  if (norm.length !== 10) return norm ? [norm] : [];
  const p1 = norm.slice(0, 3), p2 = norm.slice(3, 6), p3 = norm.slice(6, 10);
  return [norm, `+1${norm}`, `1${norm}`, `(${p1}) ${p2}-${p3}`, `${p1}-${p2}-${p3}`];
}

/**
 * IDENTITY RECONCILIATION.
 *
 * The inbound caller ID is only a PROVISIONAL identity for a Voice call.
 * Once save_lead resolves the real CRM contact (persisted to
 * voice_call_scheduling_state.contact_id via persistLeadLinkage — which
 * matches on the phone number the caller SPOKE, not their caller ID), that
 * contact becomes authoritative and must replace the provisional one on
 * every Voice artifact:
 *   - voice_calls.contact_id  (drives the Inbox Voice conversation identity
 *     + call-log caller name + end-of-call outcome linkage)
 *   - conversation_states.contact_id for channel = 'voice' (archive/star
 *     state, only present if the conversation was archived while still
 *     showing under the caller-ID identity)
 *
 * Runs after every tool-calls batch and again at end-of-call. Idempotent,
 * never throws. Does nothing until save_lead has resolved a real contact.
 */
export async function reconcileCallContactIdentity(
  deps: AuditDeps,
  params: { vapiCallId: string; voiceCallId: string | null; tenantId: string; callerNumber: string | null },
): Promise<void> {
  const { vapiCallId, voiceCallId, tenantId, callerNumber } = params;
  if (!voiceCallId) {
    alog('reconcile: skipped — no voiceCallId', { vapiCallId });
    return;
  }

  const { data: st } = await deps.supabase
    .from('voice_call_scheduling_state')
    .select('contact_id')
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', tenantId)
    .maybeSingle();

  const authContactId = (st?.contact_id as string | undefined) ?? null;
  if (!authContactId) {
    alog('reconcile: no authoritative contact in scheduling state yet — keeping provisional identity', { vapiCallId, voiceCallId });
    return;
  }

  const { data: vc } = await deps.supabase
    .from('voice_calls')
    .select('contact_id')
    .eq('id', voiceCallId)
    .maybeSingle();
  const current = (vc?.contact_id as string | undefined) ?? null;
  if (current === authContactId) {
    alog('reconcile: voice_calls.contact_id already authoritative', { vapiCallId, voiceCallId });
    return;
  }

  const { error } = await deps.supabase
    .from('voice_calls')
    .update({ contact_id: authContactId })
    .eq('id', voiceCallId);
  if (error) {
    aerr('voice_calls.contact_id reconcile failed', { voiceCallId });
    return;
  }
  alog('voice_calls.contact_id set to the save_lead-resolved contact', { voiceCallId, hadProvisional: current != null });

  // Move any Voice archive/star state off the provisional caller-ID contact.
  const provisional = new Set<string>();
  if (current) provisional.add(current);
  const norm = normalizePhoneDigits(callerNumber);
  if (norm) {
    const { data: byPhone } = await deps.supabase
      .from('contacts')
      .select('id')
      .eq('org_id', tenantId)
      .in('phone', phoneVariants(norm));
    for (const c of byPhone ?? []) {
      if (c?.id && c.id !== authContactId) provisional.add(c.id as string);
    }
  }
  for (const pid of provisional) {
    const { error: mvErr } = await deps.supabase
      .from('conversation_states')
      .update({ contact_id: authContactId })
      .eq('org_id', tenantId)
      .eq('channel', 'voice')
      .eq('contact_id', pid);

    if (!mvErr) {
      alog('moved voice conversation_states off provisional contact', { from: pid });
      continue;
    }

    // 23505 == the authoritative contact already has its own voice
    // conversation_states row. Preserve that one, drop the now-orphaned
    // provisional row so nothing Voice-related is left attached to the
    // caller-ID identity. Never create a second row.
    if ((mvErr as { code?: string }).code === '23505') {
      const { error: delErr } = await deps.supabase
        .from('conversation_states')
        .delete()
        .eq('org_id', tenantId)
        .eq('channel', 'voice')
        .eq('contact_id', pid);
      if (delErr) aerr('conversation_states provisional cleanup failed', { from: pid });
      else alog('dropped provisional voice conversation_states (authoritative row already exists)', { from: pid });
    } else {
      aerr('conversation_states voice re-point failed', { from: pid });
    }
  }
}

/**
 * Authoritative call outcome. If this call actually produced or moved an
 * appointment, the outcome is 'appointment_booked' regardless of what the
 * fuzzy summary text says. Otherwise fall back to the summary-derived
 * classification.
 */
export async function resolveAuthoritativeOutcome(
  deps: AuditDeps,
  params: {
    voiceCallId: string | null;
    vapiCallId: string;
    tenantId: string;
    summaryOutcome: string;
    /** Authoritative contact for the call (from scheduling state), if known. */
    contactId?: string | null;
  },
): Promise<string> {
  const { voiceCallId, vapiCallId, tenantId, summaryOutcome } = params;

  // 1. Appointment already linked to this call row.
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

  // 2. book_appointment recorded the result on the scheduling-state row.
  const { data: st } = await deps.supabase
    .from('voice_call_scheduling_state')
    .select('resulting_appointment_id, contact_id')
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', tenantId)
    .maybeSingle();
  if (st?.resulting_appointment_id) return 'appointment_booked';

  // 3. Fallback — a recent Voice appointment for the authoritative contact
  //    (covers a booking whose voice_call_id / resulting_appointment_id
  //    linkage did not land, so the outcome is not derived from transcript).
  const contactId = params.contactId ?? (st?.contact_id as string | undefined) ?? null;
  if (contactId) {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data: recent } = await deps.supabase
      .from('appointments')
      .select('id')
      .eq('org_id', tenantId)
      .eq('contact_id', contactId)
      .eq('source', 'Voice AI')
      .neq('status', 'cancelled')
      .gte('created_at', sixHoursAgo)
      .limit(1)
      .maybeSingle();
    if (recent?.id) return 'appointment_booked';
  }

  return summaryOutcome;
}
