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

// ─────────────────────────────────────────────
// Supabase client — service role bypasses RLS
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

// ─────────────────────────────────────────────
// Natural language date parser
// ─────────────────────────────────────────────
function parseNaturalDate(input: string): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (s === 'today') return new Date(today);
  if (s === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const weekdays = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];

  for (let i = 0; i < weekdays.length; i++) {
    if (s.includes(weekdays[i])) {
      const isNext = s.includes('next');
      const d = new Date(today);
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff + (isNext ? 7 : 0));
      return d;
    }
  }

  const inDays = s.match(/in\s+(\d+)\s+days?/);
  if (inDays) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(inDays[1], 10));
    return d;
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  }

  const dayOfMonth = s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (dayOfMonth) {
    const day = parseInt(dayOfMonth[1], 10);
    const d = new Date(today);
    d.setDate(day);
    if (d < today) d.setMonth(d.getMonth() + 1);
    return d;
  }

  return null;
}

// ─────────────────────────────────────────────
// Natural language time parser
// ─────────────────────────────────────────────
function parseTime(input: string): { hours: number; minutes: number } | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');

  const h24 = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (h24) {
    return { hours: parseInt(h24[1], 10), minutes: parseInt(h24[2], 10) };
  }

  const h12 = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (h12) {
    let hours = parseInt(h12[1], 10);
    const mins = parseInt(h12[2] ?? '0', 10);
    const period = h12[3];

    if (period === 'pm' && hours !== 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;

    return { hours, minutes: mins };
  }

  return null;
}

function buildWallClockISO(date: Date, hours: number, minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());

  return `${y}-${mo}-${d}T${pad(hours)}:${pad(minutes)}:00`;
}

function buildScheduledAt(dateStr: string, timeStr: string): { wallClock: string } | null {
  const date = parseNaturalDate(dateStr);
  const time = parseTime(timeStr);
  if (!date || !time) return null;
  return { wallClock: buildWallClockISO(date, time.hours, time.minutes) };
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

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

function capitalizeService(s: string): string {
  if (!s) return s;
  return s.replace(/\b\w/g, c => c.toUpperCase());
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
function verifySignature(rawBody: string, signature: string): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[vapi-webhook] VAPI_WEBHOOK_SECRET not set — skipping');
    return true;
  }

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
  service: string;
  budget: string;
  timeline: string;
  notes: string;
  address: string;
  calledFrom: string | null;
  status: 'new' | 'qualified';
}): Promise<string | null> {
  const { tenantId, contactId, service, budget, timeline, notes, address, calledFrom, status } = params;

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
      source: 'Voice AI',
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
  const outcome = classifyOutcome(summary);
  const sentiment = classifySentiment(summary);
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

  const { data: existing } = await supabase
    .from('voice_calls')
    .select('id')
    .eq('vapi_call_id', call.id)
    .maybeSingle();

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
    runPostCallAutomation({
      callId: callRowId,
      vapiCallId: call.id,
      tenantId,
      transcript: artifact.messages ?? artifact.transcript ?? null,
      callerNumber: call.customer?.number ?? null,
    }).catch((err: unknown) => logError('post-call', 'automation failed', err));
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

  for (const toolCall of toolCallList) {
    const { id: toolCallId, function: fn } = toolCall;
    log('tool-calls', `dispatching tool=${fn.name} callId=${call.id}`);

    let args: Record<string, unknown> = {};
    try {
      args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    } catch {
      logError('tool-calls', 'parse args failed', fn.arguments);
    }

    log('tool-calls', 'args', args);

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

    (async () => {
      const { data: callRow } = await supabase
        .from('voice_calls')
        .select('id')
        .eq('vapi_call_id', call.id)
        .maybeSingle();

      if (!callRow) {
        log('tool-calls', `skipping voice_call_tools — call row not found yet for ${call.id}`);
        return;
      }

      const { error: insertErr } = await supabase.from('voice_call_tools').insert({
        call_id: callRow.id,
        tenant_id: tenantId,
        tool_name: fn.name,
        arguments: args,
        result: { text: result },
        error: errorMsg ?? null,
      });

      if (insertErr) logError('tool-calls', 'voice_call_tools insert', insertErr);
    })();

    fireMakeWebhook(process.env.MAKE_TOOL_CALL_WEBHOOK, {
      event: 'tool_call',
      tenant_id: tenantId,
      vapi_call_id: call.id,
      tool_name: fn.name,
      arguments: args,
      result,
    });
  }

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
    case 'check_availability':
      return toolCheckAvailability(args, tenantId);
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
  const service = String(args.service ?? '');
  const budget = String(args.budget ?? '');
  const timeline = String(args.timeline ?? '');
  const notes = String(args.notes ?? '');

  log('save_lead', `name=${name} phone=${phone}`);

  if (!name && !phone) {
    return 'I need at least a name or phone number to save your details.';
  }

  const contactId = await upsertContact({ tenantId, name, phone, email, address });
  log('save_lead', `contactId=${contactId}`);

  if (!contactId) {
    return "I had trouble saving your information, but I'll make a note for our team.";
  }

  await supabase.from('voice_calls').update({ contact_id: contactId }).eq('vapi_call_id', call.id);

  const leadStatus = classifyLeadStatus(timeline, budget);
  log('save_lead', `leadStatus=${leadStatus} timeline="${timeline}" budget="${budget}"`);

  const leadId = await upsertLead({
    tenantId,
    contactId,
    service,
    budget,
    timeline,
    notes,
    address,
    calledFrom: call.customer?.number ?? null,
    status: leadStatus,
  });

  log('save_lead', `leadId=${leadId}`);

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
      title: capitalizeService(service) || 'New Lead',
      value: dealValue,
      notes: noteParts.join(' | ') || null,
      service: service || 'General',
      isAppointment: false,
    });
  }

  return `Got it${name ? ', ' + name.split(' ')[0] : ''}! I've saved your details and our team will follow up with you soon.`;
}

// ─────────────────────────────────────────────
// check_availability
// ─────────────────────────────────────────────
async function toolCheckAvailability(
  args: Record<string, unknown>,
  tenantId: string
): Promise<string> {
  const dateInput = String(args.date ?? '');
  const timeInput = String(args.time ?? '');
  const today = todayLabel();

  log('check_availability', `date="${dateInput}" time="${timeInput}" today=${today}`);

  if (!dateInput) {
    return `Today is ${today}. We schedule Monday through Saturday, 8am to 6pm. What day works best for you?`;
  }

  const targetDate = parseNaturalDate(dateInput);
  if (!targetDate) {
    return `Today is ${today}. I couldn't figure out that date — could you say something like "next Monday" or "April 15th"?`;
  }

  const avTz = await getOrgTimezone(tenantId);

  const dayStart = new Date(targetDate);
  const dayEnd = new Date(targetDate);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const { data: booked, error } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_min')
    .eq('org_id', tenantId)
    .neq('status', 'cancelled')
    .gte('scheduled_at', dayStart.toISOString())
    .lt('scheduled_at', dayEnd.toISOString());

  if (error) logError('check_availability', 'query', error);
  log('check_availability', `booked count: ${booked?.length ?? 0}`);

  const allSlots = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

  const bookedHours = (booked ?? []).map(b => {
    const d = new Date(b.scheduled_at);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: avTz,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(d);

    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    return h === 24 ? 0 : h;
  });

  log('check_availability', `bookedHours: ${JSON.stringify(bookedHours)}`);

  const freeSlots = allSlots.filter(h => !bookedHours.includes(h));
  const dayLabel = targetDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const formatHour = (h: number) => {
    if (h === 12) return '12pm';
    if (h === 0) return '12am';
    return h > 12 ? `${h - 12}pm` : `${h}am`;
  };

  const requestedTime = parseTime(timeInput);

  if (requestedTime) {
    const reqHour = requestedTime.hours;

    if (!bookedHours.includes(reqHour) && allSlots.includes(reqHour)) {
      return `${formatHour(reqHour)} on ${dayLabel} is available. Shall I book that for you?`;
    }

    const earlier = [reqHour - 1, reqHour - 2].find(h => freeSlots.includes(h));
    const later = [reqHour + 1, reqHour + 2].find(h => freeSlots.includes(h));
    const suggestions: string[] = [];

    if (earlier) suggestions.push(formatHour(earlier));
    if (later) suggestions.push(formatHour(later));

    if (suggestions.length > 0) {
      return `${formatHour(reqHour)} is not available on ${dayLabel}. The closest available ${
        suggestions.length === 1 ? 'slot is' : 'slots are'
      } ${suggestions.join(' or ')}. Would either of those work?`;
    }

    if (freeSlots.length === 0) {
      const next = new Date(targetDate);
      next.setUTCDate(next.getUTCDate() + 1);
      return `We're fully booked on ${dayLabel}. Would ${next.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })} work instead?`;
    }

    return `${formatHour(reqHour)} is not available on ${dayLabel}. We have openings at ${freeSlots
      .map(formatHour)
      .join(', ')}. Which works best?`;
  }

  if (freeSlots.length === 0) {
    const next = new Date(targetDate);
    next.setUTCDate(next.getUTCDate() + 1);
    return `We're fully booked on ${dayLabel}. Would ${next.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })} work instead?`;
  }

  const morning = freeSlots.filter(h => h < 12).map(formatHour);
  const afternoon = freeSlots.filter(h => h >= 12).map(formatHour);
  const parts: string[] = [];

  if (morning.length) parts.push(`morning: ${morning.join(', ')}`);
  if (afternoon.length) parts.push(`afternoon: ${afternoon.join(', ')}`);

  return `On ${dayLabel} we have openings — ${parts.join('; ')}. What time works best for you?`;
}

async function finalizeBookedAppointmentInBackground(params: {
  tenantId: string;
  call: VapiCall;
  contactId: string | null;
  apptId: string | null;
  name: string;
  phone: string;
  email: string;
  address: string;
  service: string;
  budget: string;
  timeline: string;
  notes: string;
  wallClock: string;
  orgTimezone: string;
}) {
  const {
    tenantId,
    call,
    contactId,
    apptId,
    name,
    phone,
    email,
    address,
    service,
    budget,
    timeline,
    notes,
    wallClock,
    orgTimezone,
  } = params;

  try {
    if (contactId) {
      const leadId = await upsertLead({
        tenantId,
        contactId,
        service,
        budget,
        timeline,
        notes,
        address,
        calledFrom: call.customer?.number ?? null,
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

          dealValue = leadRow?.estimated_value
            ? parseFloat(String(leadRow.estimated_value))
            : null;
        }

        await createPipelineDeal({
          tenantId,
          contactId,
          leadId,
          title: capitalizeService(service) || 'Consultation',
          value: dealValue,
          notes:
            [
              budget && `Budget: ${budget}`,
              timeline && `Timeline: ${timeline}`,
              notes && notes,
            ]
              .filter(Boolean)
              .join(' | ') || null,
          service,
          isAppointment: true,
          stagePosition: 1,
        });
      }
    }

    const { data: callRow } = await supabase
      .from('voice_calls')
      .select('id')
      .eq('vapi_call_id', call.id)
      .maybeSingle();

    if (callRow && apptId) {
      await supabase
        .from('appointments')
        .update({ voice_call_id: callRow.id })
        .eq('id', apptId);
    }

    await pushToGoogleCalendar(tenantId, {
      summary: `${service} — ${name || 'Caller'}`,
      description: [
        phone && `Phone: ${phone}`,
        email && `Email: ${email}`,
        budget && `Budget: ${budget}`,
        timeline && `Timeline: ${timeline}`,
        notes && `Notes: ${notes}`,
        'Booked via Voice AI',
      ]
        .filter(Boolean)
        .join('\n'),
      location: address || undefined,
      wallClockISO: wallClock,
      timezone: orgTimezone,
      durationMin: 60,
      attendeeEmail: email || undefined,
      apptId,
    });
  } catch (err) {
    logError('book_appointment', 'background finalize failed', err);
  }
}

// ─────────────────────────────────────────────
// book_appointment
// ─────────────────────────────────────────────
async function toolBookAppointment(
  args: Record<string, unknown>,
  tenantId: string,
  call: VapiCall
): Promise<string> {
  const dateStr = String(args.date ?? '');
  const timeStr = String(args.time ?? '');
  const name = String(args.name ?? '');
  const phone = String(args.phone ?? call.customer?.number ?? '');
  const email = String(args.email ?? '');
  const address = String(args.address ?? '');
  const service = String(args.service ?? 'Consultation');
  const budget = String(args.budget ?? '');
  const timeline = String(args.timeline ?? '');
  const notes = String(args.notes ?? '');

  log('book_appointment', `date="${dateStr}" time="${timeStr}" name="${name}" phone="${phone}"`);

  if (!dateStr || !timeStr) {
    return `To book the appointment I need both a day and a time. What day and time works best?`;
  }

  const scheduled = buildScheduledAt(dateStr, timeStr);
  if (!scheduled) {
    return `I couldn't understand that date or time. Could you say it like Tuesday at 10 AM?`;
  }

  const { wallClock } = scheduled;
  const orgTimezone = await getOrgTimezone(tenantId);
  const tzOffset = getUTCOffsetString(new Date(wallClock + 'Z'), orgTimezone);
  const dbScheduledAt = new Date(wallClock + tzOffset).toISOString();

  const contactId = await upsertContact({ tenantId, name, phone, email, address });

  if (contactId) {
    await supabase
      .from('voice_calls')
      .update({ contact_id: contactId })
      .eq('vapi_call_id', call.id);
  }

  const noteParts = [
    budget && `Budget: ${budget}`,
    timeline && `Timeline: ${timeline}`,
    notes && notes,
  ].filter(Boolean);

  const { data: apptData, error: apptErr } = await supabase
    .from('appointments')
    .insert({
      org_id: tenantId,
      contact_id: contactId,
      contact_name: name || null,
      contact_phone: phone || null,
      contact_email: email || null,
      address: address || null,
      service,
      budget: budget || null,
      notes: noteParts.join(' | ') || null,
      scheduled_at: dbScheduledAt,
      duration_min: 60,
      source: 'Voice AI',
      status: 'scheduled',
      voice_call_id: null,
    })
    .select('id')
    .single();

  if (apptErr) {
    logError('book_appointment', 'insert failed', apptErr);
    return `I saved your details, but I had trouble confirming the appointment. Our team will call you shortly to finalize it.`;
  }

  void finalizeBookedAppointmentInBackground({
    tenantId,
    call,
    contactId,
    apptId: apptData?.id ?? null,
    name,
    phone,
    email,
    address,
    service,
    budget,
    timeline,
    notes,
    wallClock,
    orgTimezone,
  });

  const parsedTime = parseTime(timeStr);
  const displayTime = parsedTime
    ? `${parsedTime.hours > 12 ? parsedTime.hours - 12 : parsedTime.hours}:${String(
        parsedTime.minutes
      ).padStart(2, '0')}${parsedTime.hours >= 12 ? 'pm' : 'am'}`
    : timeStr;

  const parsedDate = parseNaturalDate(dateStr);
  const displayDate =
    parsedDate?.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }) ?? dateStr;

  return `You're all set. I booked your free on-site estimate for ${displayDate} at ${displayTime}. Our estimator will call before arriving.`;
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
    summary: event.summary,
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

  if (signature && !verifySignature(rawBody, signature)) {
    logError('handler', 'Invalid signature', {});
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body: VapiWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    logError('handler', 'Invalid JSON', rawBody.slice(0, 200));
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
      summary: message.summary?.slice?.(0, 80),
      analysisSummary: message.analysis?.summary?.slice?.(0, 80),
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

    const callerNumber = rawMessage?.customer?.number ?? rawMessage?.call?.customer?.number ?? null;

    log('assistant-request', 'raw payload snapshot', {
      topLevelKeys: Object.keys(rawMessage ?? {}),
      phoneNumberId,
      callerNumber,
      phoneNumber: rawMessage?.phoneNumber ?? null,
      callPhoneNumberId: rawMessage?.call?.phoneNumberId ?? null,
      callPhoneNumber: rawMessage?.call?.phoneNumber ?? null,
    });

    if (!phoneNumberId) {
      logError('assistant-request', 'missing phoneNumberId', rawMessage);
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

      if (mappedAgent?.vapi_assistant_id) {
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
          fetch(`${process.env.URL ?? 'http://localhost:8888'}/.netlify/functions/execute-workflow`, {
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
