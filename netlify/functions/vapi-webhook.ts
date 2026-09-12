/**
 * vapi-webhook.ts
 * Netlify Function — receives all Vapi webhook events
 *
 * Deploy path: netlify/functions/vapi-webhook.ts
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  ← service role, NOT anon key
 *   VAPI_WEBHOOK_SECRET        ← from Vapi dashboard > webhooks
 *   ENCRYPTION_KEY             ← used for Google Calendar token decryption
 *   MAKE_CALL_ENDED_WEBHOOK    ← Make.com scenario URL (optional)
 *   MAKE_TOOL_CALL_WEBHOOK     ← Make.com scenario URL (optional)
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import nodeCrypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runPostCallAutomation } from './lib/post-call-automation';
import { runAppointmentPostBookingLifecycle } from './lib/appointment-post-booking';
import {
  handleCheckAvailability,
  handleBookAppointment,
  handleRescheduleAppointment,
  persistLeadLinkage,
  type SchedulingDeps,
  type BookArgs,
  type RescheduleArgs,
} from './lib/voice-scheduling';
import {
  resolveVoiceCallId,
  recordToolInvocations,
  reconcileCallContactIdentity,
  resolveAuthoritativeOutcome,
  type ToolAuditEntry,
} from './lib/voice-call-audit';
import { normalizeServiceTitle } from './lib/voice-crm';
import { getAppConfig } from './lib/app-config-store';

// ─────────────────────────────────────────────
// Supabase client — service role bypasses RLS
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─────────────────────────────────────────────
// Post-booking side effects — OFF by default
// ─────────────────────────────────────────────
// The synchronous booking path (book_appointment tool call) is deliberately
// minimal: load persisted slot -> revalidate -> insert appointment -> mark
// state -> return. It NEVER sends email/SMTP, calls the post-booking
// lifecycle, sets reminders, syncs Google Calendar, or triggers post-call
// automation — those helpers do not exist on that path at all.
//
// The remaining post-call extras (confirmation email, owner notification,
// Google Calendar sync, delayed transcript automation, CRM enrichment) live
// only in the SEPARATE end-of-call-report webhook. They are gated here so
// booking reliability can be proven in isolation first. Re-enable later with
// VOICE_POST_BOOKING_ENABLED=true.
const POST_BOOKING_SIDE_EFFECTS_ENABLED = process.env.VOICE_POST_BOOKING_ENABLED === 'true';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
type VapiEventType =
  | 'assistant-request'
  | 'assistantRequest'
  | 'assistant.request'
  | 'call.assistant-request'
  | 'call-started'
  | 'call.started'
  | 'assistant.started'
  | 'call-ended'
  | 'call.ended'
  | 'end-of-call-report'
  | 'call.ended.report'
  | 'transcript'
  | 'status-update'
  | 'call.status-update'
  | 'tool-calls'
  | 'tool.calls'
  | 'hang'
  | string;

type CostBreakdown = Record<string, unknown>;

interface VapiWebhookBody {
  message: {
    type: VapiEventType;
    call?: VapiCall;
    artifact?: VapiArtifact;
    status?: string;
    transcript?: string;
    role?: string;
    toolCallList?: VapiToolCall[];
    timestamp?: string;
    startedAt?: string;
    endedAt?: string;
    endedReason?: string;
    cost?: number;
    costBreakdown?: CostBreakdown;
    analysis?: {
      summary?: string;
      structuredData?: Record<string, unknown>;
      successEvaluation?: string;
    };
    summary?: string;
    durationSeconds?: number;
    phoneNumber?: { id?: string };
    phoneNumberId?: string;
    customer?: { number?: string; name?: string };
  };
}

interface VapiCall {
  id: string;
  orgId: string;
  type: 'inboundPhoneCall' | 'outboundPhoneCall' | 'webCall' | string;
  status: string;
  assistantId: string;
  phoneNumberId?: string;
  customer?: { number?: string; name?: string };
  phoneCallProvider?: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  cost?: number;
  costBreakdown?: CostBreakdown;
  analysis?: {
    summary?: string;
    structuredData?: Record<string, unknown>;
    successEvaluation?: string;
  };
}

interface VapiArtifact {
  transcript?: string;
  messages?: VapiMessage[];
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  summary?: string;
}

interface VapiMessage {
  role: 'assistant' | 'user' | 'tool' | 'system';
  message?: string;
  time?: number;
  endTime?: number;
  duration?: number;
  secondsFromStart?: number;
}

interface VapiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────
function log(tag: string, msg: string, data?: unknown) {
  const payload = data !== undefined ? JSON.stringify(data, null, 2) : '';
  console.log(`[vapi-webhook][${tag}] ${msg}${payload ? '\n' + payload : ''}`);
}

function logError(tag: string, msg: string, err: unknown) {
  console.error(`[vapi-webhook][${tag}] ERROR — ${msg}`, err);
}

// Natural-language date/time parsing, slot resolution and business-hours
// logic now live in ./lib/voice-scheduling.ts (the one authoritative copy,
// shared by the tool handlers). This file keeps only Google-Calendar-side
// helpers (getUTCOffsetString / utcIsoToWallClock, below).

// ─────────────────────────────────────────────
// Budget parser
// ─────────────────────────────────────────────
function parseBudget(raw: string): number | null {
  if (!raw) return null;

  const cleaned = raw
    .replace(/[$,\s]/g, '')
    .replace(/k$/i, '000')
    .replace(/[^0-9.]/g, '');

  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// ─────────────────────────────────────────────
// Vapi cost extraction
// ─────────────────────────────────────────────
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractVapiCost(message: VapiWebhookBody['message'], call: VapiCall): number | null {
  const directCandidates = [
    call.cost,
    message.cost,
    (call as any).costUsd,
    (message as any).costUsd,
    (call as any).cost_usd,
    (message as any).cost_usd,
  ];

  for (const candidate of directCandidates) {
    const n = asNumber(candidate);
    if (n !== null) return n;
  }

  const breakdownCandidates = [
    call.costBreakdown,
    message.costBreakdown,
    (call as any).costs,
    (message as any).costs,
  ].filter(Boolean) as CostBreakdown[];

  for (const breakdown of breakdownCandidates) {
    const totalKeys = ['total', 'totalCost', 'cost', 'overall', 'combined', 'sum'];

    for (const key of totalKeys) {
      const n = asNumber(breakdown[key]);
      if (n !== null) return n;
    }

    const summed = Object.entries(breakdown).reduce((sum, [key, value]) => {
      const lower = key.toLowerCase();
      if (lower.includes('duration') || lower.includes('seconds') || lower.includes('minutes')) {
        return sum;
      }

      const n = asNumber(value);
      return n !== null ? sum + n : sum;
    }, 0);

    if (summed > 0) return Number(summed.toFixed(6));
  }

  return null;
}

// ─────────────────────────────────────────────
// State → timezone
// ─────────────────────────────────────────────
const STATE_TIMEZONES: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  GU: 'Pacific/Guam',
  HI: 'Pacific/Honolulu',
  ID: 'America/Denver',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/New_York',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  PR: 'America/Puerto_Rico',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  VI: 'America/St_Thomas',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
};

function extractStateFromAddress(address: string): string | null {
  if (!address) return null;

  const abbrMatch = address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?(?:\s*$|,)/);
  if (abbrMatch && STATE_TIMEZONES[abbrMatch[1]]) return abbrMatch[1];

  const stateNames: Record<string, string> = {
    alabama: 'AL',
    alaska: 'AK',
    arizona: 'AZ',
    arkansas: 'AR',
    california: 'CA',
    colorado: 'CO',
    connecticut: 'CT',
    delaware: 'DE',
    florida: 'FL',
    georgia: 'GA',
    hawaii: 'HI',
    idaho: 'ID',
    illinois: 'IL',
    indiana: 'IN',
    iowa: 'IA',
    kansas: 'KS',
    kentucky: 'KY',
    louisiana: 'LA',
    maine: 'ME',
    maryland: 'MD',
    massachusetts: 'MA',
    michigan: 'MI',
    minnesota: 'MN',
    mississippi: 'MS',
    missouri: 'MO',
    montana: 'MT',
    nebraska: 'NE',
    nevada: 'NV',
    'new hampshire': 'NH',
    'new jersey': 'NJ',
    'new mexico': 'NM',
    'new york': 'NY',
    'north carolina': 'NC',
    'north dakota': 'ND',
    ohio: 'OH',
    oklahoma: 'OK',
    oregon: 'OR',
    pennsylvania: 'PA',
    'rhode island': 'RI',
    'south carolina': 'SC',
    'south dakota': 'SD',
    tennessee: 'TN',
    texas: 'TX',
    utah: 'UT',
    vermont: 'VT',
    virginia: 'VA',
    washington: 'WA',
    'west virginia': 'WV',
    wisconsin: 'WI',
    wyoming: 'WY',
    'district of columbia': 'DC',
  };

  const lower = address.toLowerCase();
  for (const [name, abbr] of Object.entries(stateNames)) {
    if (lower.includes(name)) return abbr;
  }

  return null;
}

async function getOrgTimezone(tenantId: string): Promise<string> {
  const { data, error } = await supabase
    .from('organizations')
    .select('timezone, address, business_address')
    .eq('id', tenantId)
    .single();

  if (error) logError('getOrgTimezone', 'org lookup failed', error);

  if (data?.timezone) {
    log('getOrgTimezone', `explicit timezone=${data.timezone}`);
    return data.timezone;
  }

  const fullAddress = data?.business_address || data?.address || '';
  if (fullAddress) {
    const stateCode = extractStateFromAddress(fullAddress);
    if (stateCode) {
      const tz = STATE_TIMEZONES[stateCode];
      log('getOrgTimezone', `address "${fullAddress}" → state=${stateCode} → ${tz}`);
      return tz;
    }
  }

  console.warn(`[vapi-webhook] Could not determine timezone for org ${tenantId}, defaulting to UTC`);
  return 'UTC';
}

// ─────────────────────────────────────────────
// Classifiers
// ─────────────────────────────────────────────
function classifyLeadStatus(timeline: string, budget: string): 'new' | 'qualified' {
  const t = timeline.toLowerCase();
  const b = budget.toLowerCase();

  const hasBudget = (parseBudget(b) ?? 0) > 0;

  const hotTimeline = [
    'asap',
    'as soon as possible',
    'immediately',
    'right away',
    'this week',
    'this month',
    'next week',
    'next month',
    'ready',
    'ready to start',
    'now',
    '1 month',
    '2 month',
    '3 month',
    'within a month',
    'within 2',
    'within 3',
    'within 30',
    'within 60',
    'within 90',
  ];

  const isHot = hotTimeline.some(kw => t.includes(kw));
  if (isHot || hasBudget) return 'qualified';

  const coldTimeline = [
    'not sure',
    "don't know",
    'maybe',
    'sometime',
    'eventually',
    'thinking about',
    'just looking',
    'no rush',
    'few months',
    'next year',
    'someday',
  ];

  if (coldTimeline.some(kw => t.includes(kw))) return 'new';
  if (!t || t.length < 3) return 'new';

  return 'qualified';
}

function classifyOutcome(summary = ''): string {
  const s = summary.toLowerCase();

  const bookedSignals = ['booked', 'scheduled', 'confirmed', 'set up', 'arranged'];
  const apptSignals = [
    'appointment',
    'estimate',
    'on-site',
    'site visit',
    'visit',
    'inspection',
    'consultation',
  ];

  const hasBooked = bookedSignals.some(w => s.includes(w));
  const hasAppt = apptSignals.some(w => s.includes(w));

  if (hasBooked && hasAppt) return 'appointment_booked';
  if (s.includes('lead') || s.includes('contact info') || s.includes('submitted')) return 'lead_captured';
  if (s.includes('call back') || s.includes('callback') || s.includes('call me back')) return 'callback_requested';
  if (s.includes('not interested') || s.includes('no thank') || s.includes('remove')) return 'not_interested';
  if (s.includes('voicemail') || s.includes('left a message')) return 'voicemail';
  if (s.includes('wrong number') || s.includes('wrong person')) return 'wrong_number';
  if (hasBooked || hasAppt) return 'lead_captured';

  return 'unknown';
}

function classifySentiment(summary = ''): string {
  const s = summary.toLowerCase();
  const pos = ['great', 'perfect', 'happy', 'excited', 'interested', 'love'].filter(w =>
    s.includes(w)
  ).length;
  const neg = ['angry', 'frustrated', 'upset', 'annoyed', 'terrible', 'bad'].filter(w =>
    s.includes(w)
  ).length;

  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function mapCallStatus(vapiStatus: string, endedReason?: string): string {
  if (endedReason === 'customer-ended-call') return 'completed';
  if (endedReason === 'assistant-ended-call') return 'completed';
  if (endedReason === 'silence' || endedReason === 'Silence') return 'completed';
  if (endedReason === 'voicemail') return 'no_answer';
  if (endedReason === 'customer-did-not-answer') return 'no_answer';
  if (endedReason === 'customer-busy') return 'busy';
  if (endedReason?.toLowerCase().includes('error') || endedReason?.toLowerCase().includes('failed')) return 'failed';

  const m: Record<string, string> = {
    ringing: 'ringing',
    'in-progress': 'in_progress',
    ended: 'completed',
    forwarded: 'completed',
  };

  return m[vapiStatus] ?? 'completed';
}

// ─────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = nodeCrypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (signatureBuffer.length !== expectedBuffer.length) return false;
    return nodeCrypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Make.com forwarder
// ─────────────────────────────────────────────
function fireMakeWebhook(url: string | undefined, payload: Record<string, unknown>): void {
  if (!url) return;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err: unknown) => logError('fireMakeWebhook', 'post failed', err));
}

// ─────────────────────────────────────────────
// Tenant resolution
// ─────────────────────────────────────────────
async function resolveTenant(
  call: VapiCall
): Promise<{ tenantId: string; agentId: string | null } | null> {
  if (call.assistantId) {
    const { data, error } = await supabase
      .from('voice_agents')
      .select('id, tenant_id')
      .eq('vapi_assistant_id', call.assistantId)
      .maybeSingle();

    if (error) logError('resolveTenant', 'voice_agents lookup', error);

    if (data) {
      log('resolveTenant', `via assistantId → tenantId=${data.tenant_id} agentId=${data.id}`);
      return { tenantId: data.tenant_id, agentId: data.id };
    }
  }

  if (call.phoneNumberId) {
    const { data, error } = await supabase
      .from('voice_phone_numbers')
      .select('tenant_id, agent_id')
      .eq('vapi_number_id', call.phoneNumberId)
      .single();

    if (error) logError('resolveTenant', 'voice_phone_numbers lookup', error);

    if (data) {
      let agentId = data.agent_id;

      if (agentId) {
        const { data: agentCheck } = await supabase
          .from('voice_agents')
          .select('id')
          .eq('id', agentId)
          .maybeSingle();

        if (!agentCheck) {
          log('resolveTenant', `agent_id ${agentId} no longer exists, falling back to active agent`);
          agentId = null;
        }
      }

      if (!agentId) {
        const { data: activeAgent } = await supabase
          .from('voice_agents')
          .select('id')
          .eq('tenant_id', data.tenant_id)
          .eq('is_active', true)
          .not('vapi_assistant_id', 'is', null)
          .maybeSingle();

        if (activeAgent) {
          agentId = activeAgent.id;
          log('resolveTenant', `healed agent_id → ${agentId}`);

          await supabase
            .from('voice_phone_numbers')
            .update({ agent_id: agentId })
            .eq('vapi_number_id', call.phoneNumberId);
        }
      }

      log('resolveTenant', `via phoneNumberId → tenantId=${data.tenant_id} agentId=${agentId}`);
      return { tenantId: data.tenant_id, agentId };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Contact upsert helper
// ─────────────────────────────────────────────
async function upsertContact(params: {
  tenantId: string;
  name: string;
  phone: string;
  email: string;
  address: string;
}): Promise<string | null> {
  const { tenantId, name, phone, email, address } = params;

  const row = {
    org_id: tenantId,
    full_name: name || 'Unknown Caller',
    phone: phone || null,
    email: email || null,
    address: address || null,
    source: 'voice_agent',
    labels: ['New Lead'],
  };

  const { data, error } = await supabase
    .from('contacts')
    .upsert(row, { onConflict: 'org_id,phone', ignoreDuplicates: false })
    .select('id')
    .single();

  if (!error) return data?.id ?? null;

  logError('upsertContact', 'upsert failed, falling back', error);

  if (phone) {
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .eq('org_id', tenantId)
      .eq('phone', phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('contacts')
        .update({
          full_name: row.full_name,
          email: row.email,
          address: row.address,
          labels: ['New Lead'],
        })
        .eq('id', existing.id);

      return existing.id;
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('contacts')
    .insert(row)
    .select('id')
    .single();

  if (insertErr) logError('upsertContact', 'insert fallback failed', insertErr);
  return inserted?.id ?? null;
}

// ─────────────────────────────────────────────
// Lead upsert helper
// ─────────────────────────────────────────────
async function upsertLead(params: {
  tenantId: string;
  contactId: string;
  name: string;
  service: string;
  budget: string;
  timeline: string;
  notes: string;
  address: string;
  calledFrom: string | null;
  status: 'new' | 'qualified';
}): Promise<string | null> {
  const { tenantId, contactId, name, service, budget, timeline, notes, address, calledFrom, status } = params;

  const noteParts = [
    service && `Service: ${service}`,
    budget && `Budget: ${budget}`,
    timeline && `Timeline: ${timeline}`,
    notes && notes,
  ].filter(Boolean);

  const estimatedValue = parseBudget(budget) ?? 0;
  const customFields = { service, budget, timeline, address, called_from: calledFrom };

  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('org_id', tenantId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) {
    log('upsertLead', `updating existing id=${existing.id}`);
    await supabase
      .from('leads')
      .update({
        // Phase 3, CRM Schema Improvement — kept in sync with whatever
        // name upsertContact() just wrote for this same call.
        name: name || undefined,
        status,
        notes: noteParts.join(' | ') || null,
        estimated_value: estimatedValue || undefined,
        custom_fields: customFields,
      })
      .eq('id', existing.id);

    return existing.id;
  }

  log('upsertLead', 'inserting new lead');

  const { data: newLead, error } = await supabase
    .from('leads')
    .insert({
      org_id: tenantId,
      contact_id: contactId,
      name: name || null,
      // Lead-source normalization pass — canonical machine value, not the
      // display string "Voice AI" (that literal is still correct for
      // appointments.source below, a separate column/enum with its own
      // grandfathered "Voice AI" literal — this change is leads.source only).
      source: 'voice_ai',
      status,
      estimated_value: estimatedValue,
      notes: noteParts.join(' | ') || null,
      custom_fields: customFields,
    })
    .select('id')
    .single();

  if (error) logError('upsertLead', 'insert failed', error);
  return newLead?.id ?? null;
}

// ─────────────────────────────────────────────
// Pipeline deal creator
// ─────────────────────────────────────────────
async function createPipelineDeal(params: {
  tenantId: string;
  contactId: string | null;
  leadId: string | null;
  title: string;
  value: number | null;
  notes: string | null;
  service: string;
  isAppointment: boolean;
  stagePosition?: number;
}): Promise<string | null> {
  const {
    tenantId,
    contactId,
    leadId,
    title,
    value,
    notes,
    service,
    isAppointment,
    stagePosition = 0,
  } = params;

  if (leadId) {
    const { data: existing } = await supabase
      .from('deals')
      .select('id, stage_id, value')
      .eq('org_id', tenantId)
      .eq('lead_id', leadId)
      .maybeSingle();

    if (existing) {
      log('createPipelineDeal', `deal exists id=${existing.id}, checking for upgrade`);

      const upgradePayload: Record<string, unknown> = {};

      if (stagePosition > 0) {
        const { data: pipeline } = await supabase
          .from('pipelines')
          .select('id')
          .eq('org_id', tenantId)
          .eq('is_default', true)
          .eq('is_active', true)
          .single();

        if (pipeline) {
          const { data: targetStage } = await supabase
            .from('pipeline_stages')
            .select('id, name, probability')
            .eq('pipeline_id', pipeline.id)
            .eq('position', stagePosition)
            .single();

          if (targetStage) {
            upgradePayload.stage_id = targetStage.id;
            upgradePayload.probability = targetStage.probability ?? 50;
            log('createPipelineDeal', `upgrading stage to ${targetStage.name}`);
          }
        }
      }

      if (value && value > 0 && (!existing.value || Number(existing.value) === 0)) {
        upgradePayload.value = value;
        log('createPipelineDeal', `upgrading value to ${value}`);
      }

      if (Object.keys(upgradePayload).length > 0) {
        await supabase.from('deals').update(upgradePayload).eq('id', existing.id);
      }

      return existing.id;
    }
  }

  const { data: pipeline, error: pipelineErr } = await supabase
    .from('pipelines')
    .select('id')
    .eq('org_id', tenantId)
    .eq('is_default', true)
    .eq('is_active', true)
    .single();

  if (pipelineErr || !pipeline) {
    logError('createPipelineDeal', 'pipeline lookup failed', pipelineErr);
    return null;
  }

  let stageData = await supabase
    .from('pipeline_stages')
    .select('id, name, probability')
    .eq('pipeline_id', pipeline.id)
    .eq('position', stagePosition)
    .single();

  if (!stageData.data) {
    log('createPipelineDeal', `position ${stagePosition} not found, falling back to position 0`);
    stageData = await supabase
      .from('pipeline_stages')
      .select('id, name, probability')
      .eq('pipeline_id', pipeline.id)
      .order('position', { ascending: true })
      .limit(1)
      .single();
  }

  const stage = stageData.data;
  const stageErr = stageData.error;

  if (stageErr || !stage) {
    logError('createPipelineDeal', 'stage lookup failed', stageErr);
    return null;
  }

  log('createPipelineDeal', `pipeline=${pipeline.id} stage=${stage.id} (${stage.name})`);

  const closeDate = new Date();
  closeDate.setDate(closeDate.getDate() + (isAppointment ? 30 : 60));

  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .insert({
      org_id: tenantId,
      lead_id: leadId,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      title,
      description: notes || null,
      value: value ?? 0,
      probability: stage.probability ?? 10,
      status: 'open',
      expected_close_date: closeDate.toISOString().split('T')[0],
      stage_order: 0,
      custom_fields: { service, source: 'Voice AI', booked: isAppointment },
    })
    .select('id')
    .single();

  if (dealErr) {
    logError('createPipelineDeal', 'insert failed', dealErr);
    return null;
  }

  log('createPipelineDeal', `deal created id=${deal.id}`);

  if (leadId && deal.id) {
    await supabase.from('leads').update({ converted_to_deal_id: deal.id }).eq('id', leadId);
  }

  return deal.id;
}

// ─────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────
async function handleCallStarted(call: VapiCall, tenantId: string, agentId: string | null) {
  const direction = call.type === 'inboundPhoneCall' ? 'inbound' : 'outbound';
  log('call-started', `callId=${call.id} direction=${direction}`);

  const { error } = await supabase.from('voice_calls').upsert(
    {
      vapi_call_id: call.id,
      tenant_id: tenantId,
      agent_id: agentId,
      direction,
      status: 'in_progress',
      caller_number: call.customer?.number ?? null,
      called_number: null,
      started_at: call.startedAt ?? new Date().toISOString(),
    },
    { onConflict: 'vapi_call_id' }
  );

  if (error) logError('call-started', 'upsert voice_calls', error);
}

async function handleStatusUpdate(call: VapiCall) {
  const status = mapCallStatus(call.status);
  log('status-update', `callId=${call.id} status=${status}`);

  const { error } = await supabase.from('voice_calls').update({ status }).eq('vapi_call_id', call.id);
  if (error) logError('status-update', 'update', error);
}

async function handleEndOfCallReport(
  message: VapiWebhookBody['message'],
  call: VapiCall,
  artifact: VapiArtifact,
  tenantId: string,
  agentId: string | null
) {
  log('end-of-call-report', `callId=${call.id} endedReason=${call.endedReason}`);

  const summary = artifact.summary ?? call.analysis?.summary ?? message.analysis?.summary ?? '';
  const sentiment = classifySentiment(summary);

  // Outcome is derived from AUTHORITATIVE transaction state first — if this
  // call actually created or moved an appointment, the outcome is
  // 'appointment_booked' no matter how the summary text is phrased. The
  // keyword classifier is only the fallback.
  const { data: eocCallRow } = await supabase
    .from('voice_calls')
    .select('id')
    .eq('vapi_call_id', call.id)
    .maybeSingle();
  const eocVoiceCallId = eocCallRow?.id ?? null;
  const outcome = await resolveAuthoritativeOutcome(
    { supabase },
    { voiceCallId: eocVoiceCallId, vapiCallId: call.id, tenantId, summaryOutcome: classifyOutcome(summary) },
  );
  const costUsd = extractVapiCost(message, call);

  let durationSec: number | null = null;
  if (call.startedAt && call.endedAt) {
    durationSec = Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000);
  }

  if (!durationSec && message.durationSeconds) {
    durationSec = message.durationSeconds;
  }

  log('end-of-call-report', 'resolved fields', {
    outcome,
    sentiment,
    durationSec,
    costUsd,
    callCost: call.cost,
    messageCost: message.cost,
    callCostBreakdown: call.costBreakdown,
    messageCostBreakdown: message.costBreakdown,
    summaryLength: summary.length,
  });

  const updatePayload = {
    status: mapCallStatus(call.status, call.endedReason),
    ended_at: call.endedAt ?? new Date().toISOString(),
    duration_sec: durationSec,
    transcript: artifact.messages ?? null,
    summary,
    recording_url: artifact.recordingUrl ?? null,
    stereo_recording_url: artifact.stereoRecordingUrl ?? null,
    outcome,
    sentiment,
    cost_usd: costUsd,
    raw_end_of_call: { message, call, artifact },
  };

  const existing = eocCallRow;
  let callRowId = existing?.id ?? null;

  if (existing) {
    const { error } = await supabase
      .from('voice_calls')
      .update(updatePayload)
      .eq('vapi_call_id', call.id);

    if (error) logError('end-of-call-report', 'update', error);
  } else {
    const { data: inserted, error } = await supabase
      .from('voice_calls')
      .insert({
        vapi_call_id: call.id,
        tenant_id: tenantId,
        agent_id: agentId,
        direction: call.type === 'inboundPhoneCall' ? 'inbound' : 'outbound',
        caller_number: call.customer?.number ?? null,
        started_at: call.startedAt ?? null,
        ...updatePayload,
      })
      .select('id')
      .single();

    if (error) {
      logError('end-of-call-report', 'insert fallback', error);
    } else {
      callRowId = inserted?.id ?? null;
    }
  }

  fireMakeWebhook(process.env.MAKE_CALL_ENDED_WEBHOOK, {
    event: 'call_ended',
    tenant_id: tenantId,
    agent_id: agentId,
    vapi_call_id: call.id,
    caller_number: call.customer?.number,
    duration_sec: durationSec,
    cost_usd: costUsd,
    outcome,
    sentiment,
    summary,
    recording_url: artifact.recordingUrl,
  });

  if (!callRowId) {
    const { data } = await supabase
      .from('voice_calls')
      .select('id')
      .eq('vapi_call_id', call.id)
      .maybeSingle();
    callRowId = data?.id ?? null;
  }

  if (callRowId) {
    // ── AWAITED finalization — must complete before this webhook returns,
    // or Netlify freezes the container and the writes are lost. Ordered so
    // the appointment↔call link and the contact-identity reconciliation
    // happen BEFORE any gated post-call automation (so runPostCallAutomation
    // sees the reconciled voice_calls.contact_id and early-returns) and
    // BEFORE the scheduling-state row is deleted.
    const { data: st } = await supabase
      .from('voice_call_scheduling_state')
      .select('resulting_appointment_id, contact_id')
      .eq('vapi_call_id', call.id)
      .eq('org_id', tenantId)
      .maybeSingle();

    log('end-of-call-report', 'finalize start', {
      callRowId,
      hadCallRow: !!existing,
      stResultingAppt: st?.resulting_appointment_id ?? null,
      stContact: st?.contact_id ?? null,
    });

    // Resolve THE appointment for this call — from the scheduling-state
    // result, else the most recent Voice appointment for the authoritative
    // contact (covers a booking whose linkage did not land).
    let apptForCall = (st?.resulting_appointment_id as string | undefined) ?? null;
    if (!apptForCall && st?.contact_id) {
      const { data: recentAppt } = await supabase
        .from('appointments')
        .select('id')
        .eq('org_id', tenantId)
        .eq('contact_id', st.contact_id)
        .eq('source', 'Voice AI')
        .neq('status', 'cancelled')
        .gte('created_at', new Date(Date.now() - 6 * 3600 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      apptForCall = (recentAppt?.id as string | undefined) ?? null;
    }
    if (apptForCall) {
      const { error: linkErr } = await supabase
        .from('appointments')
        .update({ voice_call_id: callRowId })
        .eq('id', apptForCall)
        .eq('org_id', tenantId)
        .is('voice_call_id', null);
      if (linkErr) logError('end-of-call-report', 'voice_call_id backfill failed', { appointmentId: apptForCall });

      // Clean the appointment's service/title label. handleBookAppointment
      // stores the raw model string (e.g. "roof replacement estimate"); we
      // normalize it POST-creation here, without touching the booking
      // transaction. The appointment TYPE (appointment_type) is untouched —
      // only the display NAME is cleaned ("Roof replacement").
      const { data: aRow } = await supabase
        .from('appointments')
        .select('service, title')
        .eq('id', apptForCall)
        .eq('org_id', tenantId)
        .maybeSingle();
      if (aRow) {
        const cleanService = normalizeServiceTitle(aRow.service as string | null);
        const cleanTitle = normalizeServiceTitle(aRow.title as string | null);
        const labelPatch: Record<string, unknown> = {};
        if (cleanService && cleanService !== aRow.service) labelPatch.service = cleanService;
        if (cleanTitle && cleanTitle !== aRow.title) labelPatch.title = cleanTitle;
        if (Object.keys(labelPatch).length > 0) {
          const { error: nErr } = await supabase
            .from('appointments')
            .update(labelPatch)
            .eq('id', apptForCall)
            .eq('org_id', tenantId);
          if (nErr) logError('end-of-call-report', 'appointment label normalize failed', { appointmentId: apptForCall });
          else log('end-of-call-report', 'appointment label normalized', { appointmentId: apptForCall });
        }
      }
    }

    // Point voice_calls.contact_id (and any voice conversation_states row)
    // at the save_lead-resolved contact instead of the provisional caller ID.
    // NOTE: the Voice lifecycle ends at Contact → Lead → Deal → Appointment;
    // a Project is created later only via the existing manual conversion flow.
    await reconcileCallContactIdentity(
      { supabase },
      { vapiCallId: call.id, voiceCallId: callRowId, tenantId, callerNumber: call.customer?.number ?? null },
    );

    // Finalize the outcome from authoritative state now that the links are set.
    const finalOutcome = await resolveAuthoritativeOutcome(
      { supabase },
      {
        voiceCallId: callRowId,
        vapiCallId: call.id,
        tenantId,
        summaryOutcome: classifyOutcome(summary),
        contactId: (st?.contact_id as string | undefined) ?? null,
      },
    );
    if (finalOutcome !== outcome) {
      const { error: oErr } = await supabase.from('voice_calls').update({ outcome: finalOutcome }).eq('id', callRowId);
      if (oErr) logError('end-of-call-report', 'outcome finalize failed', { callRowId });
      else log('end-of-call-report', 'outcome finalized', { callRowId, from: outcome, to: finalOutcome });
    }

    // ── Gated post-booking side effects (email / lifecycle / gcal / post-call
    // automation). Now run AFTER reconciliation, so runPostCallAutomation
    // sees the reconciled contact_id and skips its transcript-extraction
    // rebuild. Fire-and-forget by design when enabled.
    if (POST_BOOKING_SIDE_EFFECTS_ENABLED) {
      runPostCallAutomation({
        callId: callRowId,
        vapiCallId: call.id,
        tenantId,
        transcript: artifact.messages ?? artifact.transcript ?? null,
        callerNumber: call.customer?.number ?? null,
      }).catch((err: unknown) => logError('post-call', 'automation failed', err));

      (async () => {
        if (!apptForCall) return;
        await finalizeVoiceBookedAppointment(tenantId, apptForCall).catch((err) => {
          logError('voice-finalize', 'failed', { appointmentId: apptForCall, message: err instanceof Error ? err.message : String(err) });
        });
        await runAppointmentPostBookingLifecycle(supabase, { appointmentId: apptForCall, orgId: tenantId }).catch((err) => {
          logError('post-booking', 'lifecycle failed', { appointmentId: apptForCall, message: err instanceof Error ? err.message : String(err) });
        });
      })();
    } else {
      log('end-of-call-report', 'post-booking side effects disabled (VOICE_POST_BOOKING_ENABLED!=true) — skipping email / lifecycle / gcal / post-call automation');
    }

    // ── AWAITED — remove the short-lived scheduling-state row LAST.
    const { error: delErr } = await supabase
      .from('voice_call_scheduling_state')
      .delete()
      .eq('vapi_call_id', call.id)
      .eq('org_id', tenantId);
    if (delErr) logError('end-of-call-report', 'scheduling state cleanup failed', { vapiCallId: call.id });
  }
}

// ─────────────────────────────────────────────
// Tool call handler
// ─────────────────────────────────────────────
async function handleToolCalls(
  toolCallList: VapiToolCall[],
  call: VapiCall,
  tenantId: string
): Promise<Array<{ toolCallId: string; result: string }>> {
  const results: Array<{ toolCallId: string; result: string }> = [];
  const auditEntries: ToolAuditEntry[] = [];

  // Resolve the internal voice_calls.id ONCE, synchronously, up front — the
  // call-started webhook has normally already written this row, but create a
  // minimal one if not so tool audit + contact linkage always have an id.
  const voiceCallId = await resolveVoiceCallId(
    { supabase },
    {
      vapiCallId: call.id,
      tenantId,
      callerNumber: call.customer?.number ?? null,
      direction: call.type === 'inboundPhoneCall' ? 'inbound' : 'outbound',
    },
  );

  for (const toolCall of toolCallList) {
    const { id: toolCallId, function: fn } = toolCall;
    log('tool-calls', `dispatching tool=${fn.name} callId=${call.id}`);

    let args: Record<string, unknown> = {};
    try {
      args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    } catch {
      logError('tool-calls', 'parse args failed', { argsType: typeof fn.arguments });
    }

    log('tool-calls', 'args received', { keys: Object.keys(args) });

    let result = 'Action completed successfully.';
    let errorMsg: string | undefined;

    try {
      result = await dispatchTool(fn.name, args, tenantId, call);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      result = `Sorry, I encountered an error. Let me have someone follow up with you.`;
      logError('tool-calls', `tool ${fn.name} threw`, err);
    }

    log('tool-calls', `result: ${result}`);
    results.push({ toolCallId, result });
    auditEntries.push({ toolName: fn.name, args, resultText: result, errorMsg: errorMsg ?? null });

    fireMakeWebhook(process.env.MAKE_TOOL_CALL_WEBHOOK, {
      event: 'tool_call',
      tenant_id: tenantId,
      vapi_call_id: call.id,
      tool_name: fn.name,
      arguments: args,
      result,
    });
  }

  // Identity reconciliation is correctness-critical and cheap (a few indexed
  // round-trips) — ALWAYS fully awaited. It runs on every tool batch (not
  // just the one containing save_lead) so a later webhook still heals the
  // identity if save_lead's own batch did not. Never throws; only logs.
  await reconcileCallContactIdentity(
    { supabase },
    { vapiCallId: call.id, voiceCallId, tenantId, callerNumber: call.customer?.number ?? null },
  ).catch((err) => logError('tool-calls', 'reconcile failed', err));

  // Audit write — capped so a slow voice_call_tools insert can never delay
  // the tool response (Vapi's tool timeout is what causes the "one moment"
  // loop). Continues best-effort if the cap is hit.
  const audit = recordToolInvocations({ supabase }, { voiceCallId, tenantId, entries: auditEntries })
    .catch((err) => {
      logError('tool-calls', 'audit failed', err);
      return { written: 0 };
    });
  await Promise.race([audit, new Promise((resolve) => setTimeout(resolve, 3000))]);

  return results;
}

// ─────────────────────────────────────────────
// Tool dispatcher
// ─────────────────────────────────────────────
async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  switch (name) {
    case 'save_lead':
      return toolSaveLead(args, tenantId, call);
    case 'book_appointment':
      return toolBookAppointment(args, tenantId, call);
    case 'reschedule_appointment':
      return toolRescheduleAppointment(args, tenantId, call);
    case 'check_availability':
      return toolCheckAvailability(args, tenantId, call);
    case 'get_service_info':
      return toolGetServiceInfo(args, tenantId);
    default:
      console.warn('[vapi-webhook] Unknown tool:', name);
      return "I'm not sure how to handle that right now. I'll make a note and have someone follow up.";
  }
}

// ─────────────────────────────────────────────
// save_lead
// ─────────────────────────────────────────────
async function toolSaveLead(
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  const name = String(args.name ?? '');
  const phone = String(args.phone ?? call.customer?.number ?? '');
  const email = String(args.email ?? '');
  const address = String(args.address ?? '');
  // Clean the service/project label at the source so every downstream CRM
  // record (lead custom_fields, deal title, Project name) gets the same
  // normalized value — no "estimate"/"appointment" scheduling suffix, clean
  // casing. The raw model text is not stored anywhere else.
  const service = normalizeServiceTitle(String(args.service ?? ''));
  const budget = String(args.budget ?? '');
  const timeline = String(args.timeline ?? '');
  const notes = String(args.notes ?? '');

  log('save_lead', `hasName=${!!name} hasPhone=${!!phone}`);

  if (!name && !phone) {
    return 'I need at least a name or phone number to save your details.';
  }

  const contactId = await upsertContact({ tenantId, name, phone, email, address });
  log('save_lead', `contactId=${contactId}`);

  if (!contactId) {
    return "I had trouble saving your information, but I'll make a note for our team.";
  }

  {
    const { data: vcUpd, error: vcErr } = await supabase
      .from('voice_calls')
      .update({ contact_id: contactId })
      .eq('vapi_call_id', call.id)
      .select('id');
    log('save_lead', 'voice_calls.contact_id write', {
      matched: vcUpd?.length ?? 0,
      err: vcErr?.code ?? null,
    });
  }

  const leadStatus = classifyLeadStatus(timeline, budget);
  log('save_lead', `leadStatus=${leadStatus} timeline="${timeline}" budget="${budget}"`);

  const leadId = await upsertLead({
    tenantId,
    contactId,
    name,
    service,
    budget,
    timeline,
    notes,
    address,
    calledFrom: call.customer?.number ?? null,
    status: leadStatus,
  });

  log('save_lead', `leadId=${leadId}`);

  // Persist CRM linkage into the authoritative per-call scheduling state so
  // book_appointment / reschedule_appointment reuse these ids instead of
  // depending on the model re-sending contact details.
  await persistLeadLinkage(schedulingDeps(), {
    vapiCallId: call.id,
    orgId: tenantId,
    contactId,
    leadId,
  });

  if (leadId) {
    const noteParts = [
      service && `Service: ${service}`,
      budget && `Budget: ${budget}`,
      timeline && `Timeline: ${timeline}`,
      notes && notes,
    ].filter(Boolean);

    let dealValue = parseBudget(budget);

    if (!dealValue) {
      const { data: leadRow } = await supabase
        .from('leads')
        .select('estimated_value')
        .eq('id', leadId)
        .single();

      dealValue = leadRow?.estimated_value ? parseFloat(String(leadRow.estimated_value)) : null;
      if (dealValue) log('save_lead', `dealValue from lead row: ${dealValue}`);
    }

    log('save_lead', `dealValue=${dealValue} rawBudget=${budget}`);

    await createPipelineDeal({
      tenantId,
      contactId,
      leadId,
      // `service` is already normalized (normalizeServiceTitle above) —
      // do NOT re-title-case it; the CRM display value is "Full house
      // renovation", not "Full House Renovation".
      title: service || 'New Lead',
      value: dealValue,
      notes: noteParts.join(' | ') || null,
      service: service || 'General',
      isAppointment: false,
    });
  }

  return `Got it${name ? ', ' + name.split(' ')[0] : ''}! I've saved your details and our team will follow up with you soon.`;
}

// ─────────────────────────────────────────────
// Scheduling subsystem wiring
//
// The whole appointment scheduling transaction model — one authoritative
// per-call state row (public.voice_call_scheduling_state), atomic
// idempotency, and collision revalidation immediately before every DB
// write — lives in ./lib/voice-scheduling.ts. These wrappers only adapt
// the Vapi tool-call shape to that module and return its `.speech` string.
// No SMTP / SMS / owner notification / Google Calendar / pipeline-deal
// work happens on this live path; that is the end-of-call lifecycle's job
// (see finalizeVoiceBookedAppointment + handleEndOfCallReport).
// ─────────────────────────────────────────────
function schedulingDeps(): SchedulingDeps {
  return { supabase, getOrgTimezone, upsertContact };
}

async function toolCheckAvailability(
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  const res = await handleCheckAvailability(schedulingDeps(), {
    vapiCallId: call.id,
    orgId: tenantId,
    date: String(args.date ?? ''),
    time: String(args.time ?? ''),
  });
  return res.speech;
}

async function toolBookAppointment(
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  const res = await handleBookAppointment(schedulingDeps(), {
    vapiCallId: call.id,
    orgId: tenantId,
    args: args as BookArgs,
    callerPhone: call.customer?.number ?? null,
  });
  return res.speech;
}

async function toolRescheduleAppointment(
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  const res = await handleRescheduleAppointment(schedulingDeps(), {
    vapiCallId: call.id,
    orgId: tenantId,
    args: args as RescheduleArgs,
    callerPhone: call.customer?.number ?? null,
  });
  return res.speech;
}

// ─────────────────────────────────────────────
// finalizeVoiceBookedAppointment
//
// Post-call (NOT live-path) CRM + calendar finalize for an appointment a
// Voice call booked or rescheduled. Runs once from handleEndOfCallReport.
// Idempotent via appointments.metadata.voice_crm_finalized.
// ─────────────────────────────────────────────
async function finalizeVoiceBookedAppointment(tenantId: string, apptId: string): Promise<void> {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('id, org_id, contact_id, contact_name, contact_phone, contact_email, address, service, budget, notes, scheduled_at, time_zone, gcal_event_id, metadata')
    .eq('id', apptId)
    .eq('org_id', tenantId)
    .maybeSingle();

  if (error || !appt) {
    logError('voice-finalize', 'appointment load failed', { apptId });
    return;
  }

  const metadata: Record<string, unknown> = { ...((appt.metadata as Record<string, unknown> | null) ?? {}) };
  if (metadata.voice_crm_finalized === true) {
    log('voice-finalize', 'already finalized, skipping', { apptId });
    return;
  }

  const service = String(appt.service ?? 'Consultation');
  const budget = appt.budget ? String(appt.budget) : '';

  try {
    if (appt.contact_id) {
      const leadId = await upsertLead({
        tenantId,
        contactId: appt.contact_id as string,
        name: String(appt.contact_name ?? ''),
        service,
        budget,
        timeline: '',
        notes: String(appt.notes ?? ''),
        address: String(appt.address ?? ''),
        calledFrom: appt.contact_phone ? String(appt.contact_phone) : null,
        status: 'qualified',
      });

      if (leadId) {
        let dealValue = parseBudget(budget);
        if (!dealValue) {
          const { data: leadRow } = await supabase
            .from('leads')
            .select('estimated_value')
            .eq('id', leadId)
            .single();
          dealValue = leadRow?.estimated_value ? parseFloat(String(leadRow.estimated_value)) : null;
        }

        await createPipelineDeal({
          tenantId,
          contactId: appt.contact_id as string,
          leadId,
          title: normalizeServiceTitle(service) || 'Consultation',
          value: dealValue,
          notes: budget ? `Budget: ${budget}` : null,
          service: normalizeServiceTitle(service) || 'Consultation',
          isAppointment: true,
          stagePosition: 1,
        });
      }
    }

    if (!appt.gcal_event_id) {
      const iso = String(appt.scheduled_at);
      const tz = String(appt.time_zone ?? 'UTC') || 'UTC';
      const wallClockISO = utcIsoToWallClock(iso, tz);

      await pushToGoogleCalendar(tenantId, {
        summary: `${service} — ${appt.contact_name || 'Caller'}`,
        description: [
          appt.contact_phone && `Phone: ${appt.contact_phone}`,
          appt.contact_email && `Email: ${appt.contact_email}`,
          budget && `Budget: ${budget}`,
          appt.notes && `Notes: ${appt.notes}`,
          'Booked via Voice AI',
        ]
          .filter(Boolean)
          .join('\n'),
        location: appt.address ? String(appt.address) : undefined,
        wallClockISO,
        timezone: tz,
        durationMin: 60,
        attendeeEmail: appt.contact_email ? String(appt.contact_email) : undefined,
        apptId: appt.id as string,
      });
    }
  } catch (err) {
    logError('voice-finalize', 'finalize failed', { apptId, message: err instanceof Error ? err.message : String(err) });
  }

  metadata.voice_crm_finalized = true;
  const { error: metaErr } = await supabase.from('appointments').update({ metadata }).eq('id', apptId);
  if (metaErr) logError('voice-finalize', 'metadata persist failed', { apptId });
  log('voice-finalize', 'done', { apptId });
}

// Wall-clock ISO (no zone) for a UTC instant observed in `timezone`.
function utcIsoToWallClock(iso: string, timezone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  let hh = get('hour');
  if (hh === '24') hh = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}`;
}

// ─────────────────────────────────────────────
// get_service_info
// ─────────────────────────────────────────────
async function toolGetServiceInfo(
  args: Record<string, unknown>,
  _tenantId: string
): Promise<string> {
  const service = String(args.service ?? '').toLowerCase();

  return `We offer ${service || 'a full range of home improvement and renovation services'} for residential and commercial properties. For accurate pricing, we do a free on-site estimate — I can book one for you right now if you'd like.`;
}

// ─────────────────────────────────────────────
// Google Calendar helpers
// ─────────────────────────────────────────────
function getUTCOffsetString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

    const localAsUTC = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );

    const diffMins = Math.round((localAsUTC - date.getTime()) / 60000);
    const sign = diffMins >= 0 ? '+' : '-';
    const abs = Math.abs(diffMins);
    const pad = (n: number) => String(n).padStart(2, '0');

    const result = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    log('gcal', `UTC offset for ${timezone}: ${result}`);
    return result;
  } catch (err) {
    logError('gcal', 'getUTCOffsetString failed', err);
    return '-04:00';
  }
}

function gcalDecryptBuffer(buf: Buffer): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) {
    throw new Error(
      'ENCRYPTION_KEY env var is not set in Netlify — cannot decrypt GCal token. Set it in Netlify > Site > Environment variables.'
    );
  }

  const key = nodeCrypto.createHash('sha256').update(encKey).digest();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);

  const dec = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);

  try {
    return Buffer.concat([dec.update(data), dec.final()]).toString('utf8');
  } catch {
    throw new Error(
      'GCal token decryption failed — ENCRYPTION_KEY may have changed since the token was stored. Fix: reconnect Google Calendar in RenoMeta Settings to re-encrypt with the current key.'
    );
  }
}

async function pushToGoogleCalendar(
  tenantId: string,
  event: {
    summary: string;
    description: string;
    location?: string;
    wallClockISO: string;
    timezone: string;
    durationMin: number;
    attendeeEmail?: string;
    apptId: string | null;
  }
): Promise<void> {
  const { data: integration, error: intErr } = await supabase
    .from('integrations')
    .select('access_token_encrypted, status')
    .eq('org_id', tenantId)
    .eq('provider', 'gcal')
    .single();

  if (intErr) logError('gcal', 'integrations lookup', intErr);

  if (!integration || integration.status !== 'connected' || !integration.access_token_encrypted) {
    log('gcal', 'no connected gcal integration, skipping');
    return;
  }

  let accessToken: string;
  try {
    const payload = JSON.parse(
      gcalDecryptBuffer(Buffer.from(integration.access_token_encrypted, 'base64'))
    );
    accessToken = payload.access_token;

    if (!accessToken) {
      log('gcal', 'no access_token in payload');
      return;
    }
  } catch (err) {
    logError('gcal', 'decrypt failed', err);
    return;
  }

  const [datePart, timePart] = event.wallClockISO.split('T');
  const [h, m] = timePart.split(':').map(Number);
  const totalM = h * 60 + m + event.durationMin;
  const pad = (n: number) => String(n).padStart(2, '0');
  const endISO = `${datePart}T${pad(Math.floor(totalM / 60) % 24)}:${pad(totalM % 60)}:00`;

  const refDate = new Date(event.wallClockISO + 'Z');
  const offset = getUTCOffsetString(refDate, event.timezone);
  const startDT = event.wallClockISO + offset;
  const endDT = endISO + offset;

  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: startDT, timeZone: event.timezone },
    end: { dateTime: endDT, timeZone: event.timezone },
  };

  if (event.location) body.location = event.location;
  if (event.attendeeEmail) body.attendees = [{ email: event.attendeeEmail }];

  log('gcal', 'creating event', {
    start: startDT,
    tz: event.timezone,
    offset,
  });

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error?: { message?: string } };
    logError('gcal', `event creation failed: ${err?.error?.message}`, err);
    return;
  }

  const created = (await res.json()) as { id: string };
  log('gcal', `event created id=${created.id}`);

  if (created.id && event.apptId) {
    await supabase.from('appointments').update({ gcal_event_id: created.id }).eq('id', event.apptId);
  }
}

// ─────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────
export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody = event.body ?? '';
  const signature = event.headers['x-vapi-signature'] ?? '';

  const webhookSecret = await getAppConfig(supabase, 'VAPI_WEBHOOK_SECRET');
  if (!webhookSecret) {
    logError('handler', 'VAPI_WEBHOOK_SECRET not configured', {});
    return { statusCode: 503, body: 'Service unavailable' };
  }

  if (!signature || !verifySignature(rawBody, signature, webhookSecret)) {
    logError('handler', 'Signature verification failed', {});
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body: VapiWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    logError('handler', 'Invalid JSON', { bodyLength: rawBody.length });
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { message } = body;
  const eventType = message?.type;
  const call = message?.call;

  log('handler', 'incoming event', {
    eventType,
    callId: call?.id ?? null,
    assistantId: call?.assistantId ?? null,
    phoneNumberId: call?.phoneNumberId ?? null,
    topLevelMessageKeys: Object.keys(message ?? {}),
  });

  if (eventType === 'end-of-call-report' || eventType === 'call.ended.report') {
    log('handler', 'end-of-call message top-level values', {
      startedAt: message.startedAt,
      endedAt: message.endedAt,
      endedReason: message.endedReason,
      cost: message.cost,
      costBreakdown: message.costBreakdown,
      durationSeconds: message.durationSeconds,
      summaryLength: message.summary?.length ?? 0,
      analysisSummaryLength: message.analysis?.summary?.length ?? 0,
    });
  }

  // ── assistant-request: phone call initiated, Vapi needs the assistant config ──
  if (
    eventType === 'assistant-request' ||
    eventType === 'assistantRequest' ||
    eventType === 'assistant.request' ||
    eventType === 'call.assistant-request'
  ) {
    const rawMessage = message as any;

    const phoneNumberId =
      rawMessage?.phoneNumber?.id ??
      rawMessage?.phoneNumberId ??
      rawMessage?.call?.phoneNumberId ??
      rawMessage?.call?.phoneNumber?.id ??
      null;

    log('assistant-request', 'payload snapshot', {
      topLevelKeys: Object.keys(rawMessage ?? {}),
      phoneNumberId,
    });

    if (!phoneNumberId) {
      logError('assistant-request', 'missing phoneNumberId', { topLevelKeys: Object.keys(rawMessage ?? {}) });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing phone number id' }),
      };
    }

    const { data: phoneRow, error: phoneErr } = await supabase
      .from('voice_phone_numbers')
      .select('agent_id, tenant_id')
      .eq('vapi_number_id', phoneNumberId)
      .single();

    if (phoneErr || !phoneRow) {
      logError('assistant-request', 'phone number lookup failed', { phoneErr, phoneNumberId });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Phone number not mapped in CRM' }),
      };
    }

    if (phoneRow.agent_id) {
      const { data: mappedAgent, error: mappedErr } = await supabase
        .from('voice_agents')
        .select('id, name, vapi_assistant_id, is_active')
        .eq('id', phoneRow.agent_id)
        .eq('tenant_id', phoneRow.tenant_id)
        .maybeSingle();

      if (mappedErr) logError('assistant-request', 'mapped agent lookup failed', mappedErr);

      // AI-H1.1 Part 2 — a phone number's mapped agent_id can go stale
      // relative to activation state (e.g. the mapped agent was later
      // paused without this number being reassigned). Only honor the
      // mapping while that agent is actually active; otherwise fall
      // through to the active-agent lookup below so a paused agent can
      // never keep receiving calls just because a number still points at
      // its row.
      if (mappedAgent?.vapi_assistant_id && mappedAgent.is_active) {
        log('assistant-request', 'returning mapped assistant', {
          crmAgentId: mappedAgent.id,
          agentName: mappedAgent.name,
          assistantId: mappedAgent.vapi_assistant_id,
        });

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assistantId: mappedAgent.vapi_assistant_id }),
        };
      }

      if (mappedAgent && !mappedAgent.is_active) {
        log('assistant-request', 'mapped agent is paused, falling back to active agent', {
          crmAgentId: mappedAgent.id,
          agentName: mappedAgent.name,
        });
      }
    }

    const { data: activeAgents, error: activeErr } = await supabase
      .from('voice_agents')
      .select('id, name, vapi_assistant_id, updated_at')
      .eq('tenant_id', phoneRow.tenant_id)
      .eq('is_active', true)
      .not('vapi_assistant_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (activeErr) logError('assistant-request', 'active agent lookup failed', activeErr);

    const activeAgent = activeAgents?.[0];

    if (activeAgent?.vapi_assistant_id) {
      log('assistant-request', 'fallback active assistant', {
        crmAgentId: activeAgent.id,
        agentName: activeAgent.name,
        assistantId: activeAgent.vapi_assistant_id,
      });

      await supabase
        .from('voice_phone_numbers')
        .update({ agent_id: activeAgent.id, updated_at: new Date().toISOString() })
        .eq('vapi_number_id', phoneNumberId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantId: activeAgent.vapi_assistant_id }),
      };
    }

    logError('assistant-request', 'no valid assistant found', {
      phoneNumberId,
      tenantId: phoneRow.tenant_id,
      mappedAgentId: phoneRow.agent_id,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No active agent configured for this number' }),
    };
  }

  // ── tool-calls: must respond synchronously ──
  if (eventType === 'tool-calls' || eventType === 'tool.calls') {
    const toolCallsStartedAt = Date.now();
    if (!call || !message.toolCallList?.length) {
      return { statusCode: 200, body: JSON.stringify({ results: [] }) };
    }

    const tenantInfo = await resolveTenant(call);
    if (!tenantInfo) {
      logError('handler', `tenant not found callId=${call.id}`, { assistantId: call.assistantId });
      return {
        statusCode: 200,
        body: JSON.stringify({
          results: message.toolCallList.map(t => ({
            toolCallId: t.id,
            result: "Sorry, I'm having a technical issue. Please hold.",
          })),
        }),
      };
    }

    const results = await handleToolCalls(message.toolCallList, call, tenantInfo.tenantId);
    log('handler', 'tool-calls response ready', { callId: call.id, durationMs: Date.now() - toolCallsStartedAt });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results }),
    };
  }

  // ── All other events ──
  if (!call) {
    log('handler', 'no call object, ignoring');
    return { statusCode: 200, body: 'OK' };
  }

  const tenantInfo = await resolveTenant(call);
  if (!tenantInfo) {
    console.warn(`[vapi-webhook] Unknown tenant — callId=${call.id} assistantId=${call.assistantId}`);
    return { statusCode: 200, body: 'OK' };
  }

  const { tenantId, agentId } = tenantInfo;

  switch (eventType) {
    case 'call-started':
    case 'call.started':
    case 'assistant.started':
      await handleCallStarted(call, tenantId, agentId);
      break;

    case 'status-update':
    case 'call.status-update':
      await handleStatusUpdate(call);
      break;

    case 'end-of-call-report':
    case 'call.ended.report': {
      const mergedCall: VapiCall = {
        ...call,
        startedAt: call.startedAt ?? message.startedAt,
        endedAt: call.endedAt ?? message.endedAt,
        endedReason: call.endedReason ?? message.endedReason,
        cost: call.cost ?? message.cost,
        costBreakdown: call.costBreakdown ?? message.costBreakdown,
        analysis: call.analysis ?? message.analysis,
      };

      const mergedArtifact: VapiArtifact = {
        ...(message.artifact ?? {}),
        summary:
          message.artifact?.summary ??
          message.summary ??
          message.analysis?.summary ??
          call.analysis?.summary ??
          '',
      };

      log('end-of-call-report', 'merged fields', {
        startedAt: mergedCall.startedAt,
        endedAt: mergedCall.endedAt,
        cost: mergedCall.cost,
        costBreakdown: mergedCall.costBreakdown,
        summaryLength: mergedArtifact.summary?.length ?? 0,
      });

      await handleEndOfCallReport(message, mergedCall, mergedArtifact, tenantId, agentId);

      // Fire missed_call workflow trigger when call was not answered
      if (mergedCall.endedReason === 'voicemail' || mergedCall.endedReason === 'customer-did-not-answer') {
        const callerNumber = mergedCall.customer?.number ?? null;
        if (tenantId && callerNumber) {
          fetch(`${process.env.URL ?? 'http://localhost:9999'}/.netlify/functions/execute-workflow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orgId: tenantId,
              triggerType: 'missed_call',
              triggerData: {
                callerNumber,
                callerName: mergedCall.customer?.name ?? null,
                vapiCallId: mergedCall.id,
              },
            }),
          }).catch((err) => log('missed_call trigger', 'failed', err));
        }
      }
      break;
    }

    case 'call-ended':
    case 'call.ended':
      await supabase
        .from('voice_calls')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('vapi_call_id', call.id)
        .eq('status', 'in_progress');
      log('call-ended', `callId=${call.id} marked completed`);
      break;

    case 'transcript':
      break;

    case 'hang':
      console.warn(`[vapi-webhook] Hang event callId=${call.id}`);
      break;

    default:
      log('handler', `unhandled event: ${eventType} callId=${call?.id ?? 'n/a'}`);
  }

  return { statusCode: 200, body: 'OK' };
};
