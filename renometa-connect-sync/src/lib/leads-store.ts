// src/lib/leads-store.ts
// Supabase-backed leads store — maintains the same hook interface.

import { useState, useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Lead, LeadStatus, LeadScore } from "@/lib/mock-data";
import { triggerWorkflow } from "@/lib/trigger-workflow";

// ── Org helper ──
async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return membership?.org_id ?? null;
}

// ── Score classifier (budget / timeline → hot/warm/cold) ──
function classifyScore(budget: number | null, status: string): LeadScore {
  if (status === "qualified" || (budget && budget >= 50000)) return "hot";
  if (budget && budget >= 20000) return "warm";
  return "cold";
}

// ── Map Supabase row → Lead type ──
function mapRow(row: any, contactMap: Record<string, any>): Lead {
  const contact = row.contact_id ? contactMap[row.contact_id] : null;
  const cf = row.custom_fields ?? {};
  const budget = row.estimated_value ? parseFloat(String(row.estimated_value)) : 0;

  // Map Supabase status to frontend status
  let status: LeadStatus = "new";
  if (row.status === "qualified") status = "qualified";
  else if (row.status === "contacted") status = "contacted";
  else if (row.status === "converted") status = "converted";
  else if (row.status === "lost") status = "lost";
  else if (row.status === "new") status = "new";

  return {
    id: row.id,
    name: contact?.full_name ?? cf.name ?? "Unknown",
    email: contact?.email ?? cf.email ?? "",
    phone: contact?.phone ?? cf.phone ?? "",
    address: contact?.address ?? cf.address ?? "",
    source: row.source ?? "Website",
    status,
    score: classifyScore(budget, row.status),
    projectType: cf.service ?? "",
    estimatedBudget: budget,
    notes: row.notes ?? "",
    owner: "—",
    ownerInitials: "—",
    createdAt: row.created_at ?? new Date().toISOString(),
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    convertedDealId: row.converted_to_deal_id ?? undefined,
  };
}

// ── Reactive store ──
let leads: Lead[] = [];
let loaded = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

async function fetchLeads(): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) return;

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[leads-store] fetch failed:", error);
    return;
  }

  // Batch-fetch contacts for name/email/phone
  const contactIds = (data ?? [])
    .map((r: any) => r.contact_id)
    .filter(Boolean) as string[];

  let contactMap: Record<string, any> = {};
  if (contactIds.length > 0) {
    const unique = [...new Set(contactIds)];
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, full_name, email, phone, address")
      .in("id", unique);

    if (contacts) {
      contactMap = Object.fromEntries(contacts.map((c: any) => [c.id, c]));
    }
  }

  leads = (data ?? []).map((r: any) => mapRow(r, contactMap));
  loaded = true;
  emit();
}

// Initial fetch
fetchLeads();

// ── Public API ──

export function getLeads(): Lead[] {
  return leads;
}

export function useLeads(): Lead[] {
  useEffect(() => { if (!loaded) fetchLeads(); }, []);

  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => leads,
    () => [],
  );
}

export async function addLead(lead: Omit<Lead, "id">): Promise<Lead> {
  const orgId = await getOrgId();
  const tempId = `lead-${Date.now()}`;

  if (orgId) {
    // Create contact first if we have name/phone
    let contactId: string | null = null;
    if (lead.name || lead.phone) {
      const { data: contact } = await supabase
        .from("contacts")
        .upsert(
          {
            org_id: orgId,
            full_name: lead.name || "Unknown",
            phone: lead.phone || null,
            email: lead.email || null,
            address: lead.address || null,
            source: "manual",
            labels: ["Lead"],
          },
          { onConflict: "org_id,phone", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      contactId = contact?.id ?? null;
    }

    const { data, error } = await supabase
      .from("leads")
      .insert({
        org_id: orgId,
        contact_id: contactId,
        source: lead.source || "Website",
        status: lead.status || "new",
        estimated_value: lead.estimatedBudget || 0,
        notes: lead.notes || null,
        custom_fields: {
          service: lead.projectType || null,
          budget: lead.estimatedBudget?.toString() || null,
        },
      })
      .select()
      .single();

    if (!error && data) {
      const mapped: Lead = { ...lead, id: data.id };
      leads = [mapped, ...leads];
      emit();
      triggerWorkflow("new_lead", { lead: mapped }, contactId ?? undefined);
      return mapped;
    }
  }

  // Fallback: add locally
  const next: Lead = { ...lead, id: tempId };
  leads = [next, ...leads];
  emit();
  return next;
}

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) console.error("[leads-store] status update failed:", error);

  leads = leads.map((l) =>
    l.id === id ? { ...l, status, lastActivity: new Date().toISOString() } : l
  );
  emit();
}

export async function updateLeadScore(id: string, score: LeadScore): Promise<void> {
  // Score is computed client-side, not stored in Supabase
  leads = leads.map((l) => (l.id === id ? { ...l, score } : l));
  emit();
}

export async function convertLead(id: string): Promise<string> {
  const dealId = `d_converted_${id}`;

  const { error } = await supabase
    .from("leads")
    .update({
      status: "converted",
      converted_to_deal_id: dealId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) console.error("[leads-store] convert failed:", error);

  leads = leads.map((l) =>
    l.id === id
      ? { ...l, status: "converted" as LeadStatus, convertedDealId: dealId, lastActivity: new Date().toISOString() }
      : l
  );
  emit();
  return dealId;
}

export function importLeads(newLeads: Omit<Lead, "id">[]): number {
  // Bulk import — async Supabase insert in background
  const added = newLeads.map((l, i) => ({ ...l, id: `lead-import-${Date.now()}-${i}` } as Lead));
  leads = [...added, ...leads];
  emit();

  // Fire-and-forget Supabase inserts
  (async () => {
    const orgId = await getOrgId();
    if (!orgId) return;
    for (const lead of newLeads) {
      await addLead(lead);
    }
    await fetchLeads(); // Refresh to get real IDs
  })();

  return added.length;
}

export async function refreshLeads(): Promise<void> {
  await fetchLeads();
}

// ── Lead Notes (kept in localStorage for now — fast, no schema change) ──

export type LeadNote = { id: string; text: string; createdAt: string };

const NOTES_KEY = "renometa.leadnotes.v1";

function loadNotes(): Record<string, LeadNote[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let notesMap: Record<string, LeadNote[]> = loadNotes();
const noteListeners = new Set<() => void>();
function emitNotes() { for (const l of noteListeners) l(); }
function persistNotes() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(NOTES_KEY, JSON.stringify(notesMap)); } catch { /* */ }
}

export function useLeadNotes(leadId: string): LeadNote[] {
  const all = useSyncExternalStore(
    (cb) => { noteListeners.add(cb); return () => noteListeners.delete(cb); },
    () => notesMap,
    () => ({} as Record<string, LeadNote[]>),
  );
  return all[leadId] ?? [];
}

export function addLeadNote(leadId: string, text: string): LeadNote {
  const note: LeadNote = { id: `note-${Date.now()}`, text, createdAt: new Date().toISOString() };
  notesMap = { ...notesMap, [leadId]: [note, ...(notesMap[leadId] ?? [])] };
  persistNotes();
  emitNotes();
  return note;
}

export function updateLeadNote(leadId: string, noteId: string, text: string) {
  const list = notesMap[leadId];
  if (!list) return;
  notesMap = { ...notesMap, [leadId]: list.map((n) => (n.id === noteId ? { ...n, text } : n)) };
  persistNotes();
  emitNotes();
}