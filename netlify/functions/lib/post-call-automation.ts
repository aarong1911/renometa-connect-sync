// netlify/functions/lib/post-call-automation.ts
/**
 * post-call-automation.ts
 * Netlify Function helper — NOT a standalone function endpoint.
 *
 * Path: netlify/functions/lib/post-call-automation.ts
 *
 * Imported by vapi-webhook.ts. After a call ends, if save_lead wasn't
 * triggered during the call, this runs Claude on the transcript to extract
 * structured contact/lead data and creates CRM records automatically.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────

function log(msg: string, data?: unknown) {
  const payload = data !== undefined ? JSON.stringify(data, null, 2) : '';
  console.log(`[post-call] ${msg}${payload ? '\n' + payload : ''}`);
}

function logError(msg: string, err: unknown) {
  console.error(`[post-call] ERROR — ${msg}`, err);
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface ExtractedCallData {
  name: string;
  phone: string;
  email: string;
  address: string;
  service: string;
  budget: string;
  timeline: string;
  appointmentRequested: boolean;
  appointmentDate: string;
  appointmentTime: string;
  summary: string;
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
// Contact upsert
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

  logError('upsertContact failed, falling back', error);

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
        .update({ full_name: row.full_name, email: row.email, address: row.address, labels: ['New Lead'] })
        .eq('id', existing.id);
      return existing.id;
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('contacts')
    .insert(row)
    .select('id')
    .single();

  if (insertErr) logError('insert fallback failed', insertErr);
  return inserted?.id ?? null;
}

// ─────────────────────────────────────────────
// Lead upsert
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
  const { tenantId, contactId, service, budget, timeline, notes, calledFrom, status } = params;

  const noteParts = [
    service && `Service: ${service}`,
    budget && `Budget: ${budget}`,
    timeline && `Timeline: ${timeline}`,
    notes && notes,
  ].filter(Boolean);

  const estimatedValue = parseBudget(budget) ?? 0;
  const customFields = { service, budget, timeline, address: params.address, called_from: calledFrom };

  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('org_id', tenantId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) {
    log(`updating existing lead id=${existing.id}`);
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

  log('inserting new lead');
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

  if (error) logError('lead insert failed', error);
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
    tenantId, contactId, leadId, title, value, notes, service, isAppointment,
    stagePosition = 0,
  } = params;

  if (leadId) {
    const { data: existing } = await supabase
      .from('deals')
      .select('id')
      .eq('org_id', tenantId)
      .eq('lead_id', leadId)
      .maybeSingle();

    if (existing) {
      log(`deal already exists for lead ${leadId}, skipping`);
      return existing.id;
    }
  }

  const { data: pipeline } = await supabase
    .from('pipelines')
    .select('id')
    .eq('org_id', tenantId)
    .eq('is_default', true)
    .eq('is_active', true)
    .maybeSingle();

  if (!pipeline) {
    logError('pipeline lookup failed', 'no default pipeline');
    return null;
  }

  let stageData = await supabase
    .from('pipeline_stages')
    .select('id, name, probability')
    .eq('pipeline_id', pipeline.id)
    .eq('position', stagePosition)
    .single();

  if (!stageData.data) {
    stageData = await supabase
      .from('pipeline_stages')
      .select('id, name, probability')
      .eq('pipeline_id', pipeline.id)
      .order('position', { ascending: true })
      .limit(1)
      .single();
  }

  const stage = stageData.data;
  if (!stage) {
    logError('stage lookup failed', stageData.error);
    return null;
  }

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
      custom_fields: { service, source: 'Voice AI (post-call)', booked: isAppointment },
    })
    .select('id')
    .single();

  if (dealErr) {
    logError('deal insert failed', dealErr);
    return null;
  }

  log(`deal created id=${deal.id}`);

  if (leadId && deal.id) {
    await supabase.from('leads').update({ converted_to_deal_id: deal.id }).eq('id', leadId);
  }

  return deal.id;
}

// ─────────────────────────────────────────────
// Transcript → Claude extraction
// ─────────────────────────────────────────────

async function extractDataFromTranscript(transcript: any): Promise<ExtractedCallData | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('ANTHROPIC_API_KEY not set, skipping transcript extraction');
    return null;
  }

  let transcriptText = '';
  if (typeof transcript === 'string') {
    transcriptText = transcript;
  } else if (Array.isArray(transcript)) {
    transcriptText = transcript
      .filter((m: any) => m.role && m.message)
      .map((m: any) => `${m.role === 'assistant' ? 'Agent' : 'Caller'}: ${m.message}`)
      .join('\n');
  }

  if (!transcriptText || transcriptText.length < 20) {
    log('transcript too short for extraction');
    return null;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: `Extract structured data from this phone call transcript between a home renovation company receptionist and a caller. Return ONLY valid JSON with these fields:
{
  "name": "caller's full name or empty string",
  "phone": "caller's phone number or empty string",
  "email": "caller's email or empty string",
  "address": "caller's address or empty string",
  "service": "type of service requested (e.g. Kitchen Remodel, Bathroom Renovation) or empty string",
  "budget": "mentioned budget or empty string",
  "timeline": "mentioned timeline or empty string",
  "appointmentRequested": false,
  "appointmentDate": "requested date or empty string",
  "appointmentTime": "requested time or empty string",
  "summary": "2-3 sentence summary of the call"
}
If information wasn't mentioned, use empty strings. Return ONLY the JSON object, no markdown fences.`,
        messages: [{ role: 'user', content: transcriptText }],
      }),
    });

    if (!res.ok) {
      logError(`Claude API error: ${res.status}`, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    const cleaned = text.replace(/```json\s*|```/g, '').trim();
    return JSON.parse(cleaned) as ExtractedCallData;
  } catch (err) {
    logError('extraction failed', err);
    return null;
  }
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export async function runPostCallAutomation(params: {
  callId: string;
  vapiCallId: string;
  tenantId: string;
  transcript: any;
  callerNumber: string | null;
}): Promise<void> {
  const { callId, vapiCallId, tenantId, transcript, callerNumber } = params;

  // Wait for any in-flight tool calls (save_lead, book_appointment) to finish writing
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Re-check if contact was saved during the call (via save_lead tool)
  const { data: callRow } = await supabase
    .from('voice_calls')
    .select('contact_id')
    .eq('id', callId)
    .single();

  if (callRow?.contact_id) {
    log(`call ${callId} already has contact_id=${callRow.contact_id}, skipping`);
    return;
  }

  log(`extracting data from transcript for call ${callId}`);

  const extracted = await extractDataFromTranscript(transcript);
  if (!extracted) {
    log('no data extracted from transcript');
    return;
  }

  log('extracted data', extracted);

  const phone = extracted.phone || callerNumber || '';
  const name = extracted.name || 'Unknown Caller';

  if (!phone && !extracted.name) {
    log('no identifiable caller info, skipping CRM creation');
    return;
  }

  // ── Create/update contact ──
  const contactId = await upsertContact({
    tenantId,
    name,
    phone,
    email: extracted.email,
    address: extracted.address,
  });

  if (!contactId) {
    logError('failed to create contact', { name, phone });
    return;
  }

  await supabase
    .from('voice_calls')
    .update({ contact_id: contactId })
    .eq('id', callId);

  log(`contact ${contactId} linked to call ${callId}`);

  // ── Create lead if service/budget/timeline was discussed ──
  if (extracted.service || extracted.budget || extracted.timeline) {
    const leadStatus = (extracted.budget || extracted.timeline) ? 'qualified' : 'new';

    const leadId = await upsertLead({
      tenantId,
      contactId,
      service: extracted.service,
      budget: extracted.budget,
      timeline: extracted.timeline,
      notes: extracted.summary,
      address: extracted.address,
      calledFrom: callerNumber,
      status: leadStatus as 'new' | 'qualified',
    });

    log(`lead created/updated: ${leadId}`);

    if (leadId) {
      const dealValue = parseBudget(extracted.budget);

      const dealId = await createPipelineDeal({
        tenantId,
        contactId,
        leadId,
        title: capitalizeService(
          (extracted.service || '')
            .replace(/\b(estimate|consultation|inspection)\b/gi, '')
            .trim()
        ) || 'Inbound Call Lead',
        value: dealValue,
        notes: extracted.summary,
        service: extracted.service || 'General',
        isAppointment: extracted.appointmentRequested,
        stagePosition: extracted.appointmentRequested ? 1 : 0,
      });

      log(`pipeline deal: ${dealId}`);
    }
  }

  // ── Create appointment if one was requested ──
  if (extracted.appointmentRequested && extracted.appointmentDate && extracted.appointmentTime) {
    // Build date string with current year
    const currentYear = new Date().getUTCFullYear();
    const scheduledStr = `${extracted.appointmentDate} ${currentYear} ${extracted.appointmentTime}`;
    const scheduled = new Date(scheduledStr);

    // Clean up service name: "kitchen remodel estimate" → "Kitchen Remodel"
    const cleanService = (extracted.service || 'Consultation')
      .replace(/\b(estimate|consultation|inspection)\b/gi, '')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\s+/g, ' ')
      .trim() || 'Consultation';

    if (!isNaN(scheduled.getTime()) && scheduled.getFullYear() >= 2025) {
      const { error: apptErr } = await supabase
        .from('appointments')
        .insert({
          org_id: tenantId,
          contact_id: contactId,
          contact_name: name,
          contact_phone: phone,
          contact_email: extracted.email || null,
          address: extracted.address || null,
          service: cleanService,
          budget: extracted.budget || null,
          notes: extracted.summary || null,
          scheduled_at: scheduled.toISOString(),
          duration_min: 60,
          source: 'Voice AI',
          status: 'scheduled',
        });

      if (apptErr) {
        logError('appointment insert failed', apptErr);
      } else {
        log('appointment created from post-call extraction');
      }
    } else {
      log(`could not parse appointment date: "${scheduledStr}" → ${scheduled}`);
    }
  }

  // ── Backfill summary if Vapi didn't provide one ──
  if (extracted.summary) {
    const { data: existingCall } = await supabase
      .from('voice_calls')
      .select('summary')
      .eq('id', callId)
      .single();

    if (!existingCall?.summary) {
      await supabase
        .from('voice_calls')
        .update({ summary: extracted.summary })
        .eq('id', callId);
      log('call summary updated from extraction');
    }
  }

  log(`automation complete for call ${callId}`);
}