// src/lib/marketing-campaign-client.ts
// Thin client for the trusted marketing-* Netlify functions — audience
// eligibility preview and campaign send/schedule. Both are authoritative
// (server re-resolves the audience and re-checks opt-outs); the frontend
// never computes what will actually be sent, only requests a preview of it.

import { supabase } from "@/lib/supabase";
import type { AudienceFilters } from "@/lib/marketing-audience";

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export type AudiencePreviewResult = {
  totalMatched: number;
  eligibleCount: number;
  excludedCount: number;
  exclusionBreakdown: Record<string, number>;
  eligiblePreview: { id: string; name: string; destination: string | null }[];
  excludedPreview: { id: string; name: string; destination: string | null; reason: string }[];
};

export async function previewAudience(input: { channel: "email" | "sms"; segmentId?: string; filters?: AudienceFilters }): Promise<AudiencePreviewResult> {
  const res = await fetch("/.netlify/functions/marketing-audience-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to preview audience");
  return data;
}

export type SendCampaignResult = { ok: true; campaign: any; recipientsQueued: number; recipientsExcluded: number };

export async function sendCampaign(input: { campaignId: string; mode: "now" | "schedule"; scheduledAt?: string }): Promise<SendCampaignResult> {
  const res = await fetch("/.netlify/functions/marketing-campaign-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to send campaign");
  return data;
}

// Cancel is now a trusted backend transition (Phase 14.1 hardening pass) —
// an ordinary client UPDATE can no longer move a campaign out of 'draft'
// at all, so this replaces the old direct-store cancelScheduledCampaign().
export type CancelCampaignResult = { ok: true; campaign: any };

export async function cancelCampaign(campaignId: string): Promise<CancelCampaignResult> {
  const res = await fetch("/.netlify/functions/marketing-campaign-cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ campaignId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to cancel campaign");
  return data;
}

// Pause/Resume — trusted backend transitions, same reasoning as Cancel
// above: an authenticated client can never move a campaign row out of
// 'draft' directly (RLS + enforce_campaigns_write_guard() both require
// old.status = new.status = 'draft'), so pausing/resuming a live campaign
// has to go through these service_role-backed functions. See
// supabase/migrations/20260831_campaign_pause_resume.sql and
// marketing-campaign-pause.ts / marketing-campaign-resume.ts for the
// exact server-side semantics (in particular: pausing a 'sending'
// campaign never resets an already-claimed recipient, and resuming never
// restores a persistent 'sending' status).
export type PauseCampaignResult = { ok: true; campaign: any };
export type ResumeCampaignResult = { ok: true; campaign: any };

export async function pauseCampaign(campaignId: string): Promise<PauseCampaignResult> {
  const res = await fetch("/.netlify/functions/marketing-campaign-pause", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ campaignId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to pause campaign");
  return data;
}

export async function resumeCampaign(campaignId: string): Promise<ResumeCampaignResult> {
  const res = await fetch("/.netlify/functions/marketing-campaign-resume", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ campaignId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to resume campaign");
  return data;
}

// Minimal trusted path to record SMS marketing eligibility for a contact
// (Phase 14.1 hardening pass — SMS eligibility fails closed, so this is
// the only legitimate way a contact ever moves out of 'unknown'). See
// marketing-contact-preferences-set.ts for the one-directional guard.
export async function setContactSmsEligible(contactId: string): Promise<{ ok: true; smsStatus: "eligible" }> {
  const res = await fetch("/.netlify/functions/marketing-contact-preferences-set", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ contactId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update SMS eligibility");
  return data;
}
