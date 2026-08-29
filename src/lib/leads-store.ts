// src/lib/leads-store.ts
// Supabase-backed leads store — maintains the same hook interface.

import { useState, useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Lead, LeadStatus, LeadScore } from "@/lib/mock-data";
import { triggerWorkflow } from "@/lib/trigger-workflow";
import { normalizeLeadStatusForWrite } from "@/lib/lead-status";
import { normalizeLeadSource } from "@/lib/lead-source";

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

  // Coerced to one of the 5 canonical statuses for typing convenience —
  // rawStatus below preserves the literal stored value so an unrecognized
  // legacy value (leads.status has no CHECK constraint) can still be
  // rendered honestly rather than silently shown as "New". See
  // src/lib/lead-status.ts.
  const status: LeadStatus = normalizeLeadStatusForWrite(row.status);

  return {
    id: row.id,
    // Phase 3, CRM Schema Improvement — leads.name (a real column, the
    // lead's own stored snapshot) is now the primary source. The prior
    // read-time derivation (contact.full_name, then the legacy
    // custom_fields.name) remains as a fallback for any row the
    // 20260903_leads_add_name.sql backfill couldn't resolve (no linked
    // contact, and no custom_fields.name either) rather than showing a
    // blank name for pre-existing data.
    name: row.name ?? contact?.full_name ?? cf.name ?? "Unknown",
    email: contact?.email ?? cf.email ?? "",
    phone: contact?.phone ?? cf.phone ?? "",
    address: contact?.address ?? cf.address ?? "",
    // Lead-source normalization pass — normalized at read time so a stale/
    // legacy raw value ("Google Ads", "google ads") in any environment
    // still resolves to the same canonical value the rest of the app now
    // expects (filter equality, comparison keys), without requiring every
    // environment's data to already be perfectly clean.
    source: normalizeLeadSource(row.source) || "website_form",
    status,
    rawStatus: row.status ?? "new",
    score: classifyScore(budget, row.status),
    projectType: cf.service ?? "",
    estimatedBudget: budget,
    notes: row.notes ?? "",
    owner: cf.owner ?? "—",
    ownerInitials: (cf.owner ?? "—").split(" ").map((p: string) => p[0]).join(""),
    createdAt: row.created_at ?? new Date().toISOString(),
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    convertedDealId: row.converted_to_deal_id ?? undefined,
    assignedTo: row.assigned_to ?? null,
    contactId: row.contact_id ?? null,
    contactAvatarUrl: contact?.avatar_url ?? null,
    contactAvatarKey: contact?.avatar_key ?? null,
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
      .select("id, full_name, email, phone, address, avatar_url, avatar_key")
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
        // Phase 3, CRM Schema Improvement — leads.name is now a real
        // column (was previously only reconstructed at read time from the
        // linked contact's full_name). Same value written to the contact
        // above, so this lead's own snapshot starts in sync with it.
        name: lead.name || null,
        // Lead-source normalization pass — always writes the canonical
        // machine value ("google_ads", not "Google Ads"/"google ads"),
        // regardless of what casing/spacing the caller (manual Add Lead
        // form, CSV import batch via addLeadsBatch()) passed in.
        source: normalizeLeadSource(lead.source) || "website_form",
        status: lead.status || "new",
        estimated_value: lead.estimatedBudget || 0,
        notes: lead.notes || null,
        // Canonical owner reference, written directly on insert rather than
        // creating the lead unassigned and issuing a second updateLeadOwner()
        // call right after (Phase 9.2 consistency pass). `undefined`/missing
        // assignedTo means the caller didn't select an owner — never forced
        // to a value, and never written as a display name anywhere here.
        assigned_to: lead.assignedTo ?? null,
        custom_fields: {
          service: lead.projectType || null,
          budget: lead.estimatedBudget?.toString() || null,
        },
      })
      .select()
      .single();

    if (!error && data) {
      const mapped: Lead = { ...lead, id: data.id, assignedTo: data.assigned_to ?? null };
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

export async function updateLead(
  id: string,
  // `source` is widened to a plain string here — leads.source is free text
  // with no CHECK constraint (Phase 9 audit), and Lead["source"]'s
  // LeadSource union is only an approximation of the values the UI's own
  // creation form offers, not a real constraint on what can be edited to
  // or already exists in the database (see src/lib/lead-source.ts).
  updates: Partial<Pick<Lead, "name" | "email" | "phone" | "address" | "projectType" | "estimatedBudget" | "owner" | "notes">> & { source?: string },
): Promise<void> {
  const current = leads.find((lead) => lead.id === id);
  if (!current) return;

  // Lead-source normalization pass — normalize whatever the caller passed
  // (or the current in-memory value, if source isn't part of this update)
  // to the canonical machine value before it becomes part of `next`, the
  // single source of truth this function both writes to the DB and keeps
  // as the in-memory representation.
  const normalizedSource = normalizeLeadSource(updates.source ?? current.source) || "website_form";
  const next: Lead = { ...current, ...updates, source: normalizedSource, lastActivity: new Date().toISOString() };
  const { data: leadRow, error: readError } = await supabase
    .from("leads")
    .select("contact_id, custom_fields")
    .eq("id", id)
    .maybeSingle();

  if (readError) {
    console.error("[leads-store] lead read failed:", readError);
  }

  if (leadRow?.contact_id) {
    const { error: contactError } = await supabase
      .from("contacts")
      .update({
        full_name: next.name || "Unknown",
        email: next.email || null,
        phone: next.phone || null,
        address: next.address || null,
      })
      .eq("id", leadRow.contact_id);

    if (contactError) console.error("[leads-store] contact update failed:", contactError);
  }

  const customFields = {
    ...(leadRow?.custom_fields ?? {}),
    name: next.name || null,
    email: next.email || null,
    phone: next.phone || null,
    address: next.address || null,
    service: next.projectType || null,
    budget: next.estimatedBudget ? String(next.estimatedBudget) : null,
    owner: next.owner || null,
  };

  const { error } = await supabase
    .from("leads")
    .update({
      // Phase 3, CRM Schema Improvement — kept in sync with the contact
      // update above (same next.name value); custom_fields.name is left
      // in place too for now rather than removed, since other code may
      // still read it as a legacy fallback.
      name: next.name || null,
      source: normalizedSource,
      estimated_value: next.estimatedBudget || 0,
      notes: next.notes || null,
      custom_fields: customFields,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[leads-store] lead update failed:", error);
    throw error;
  }

  leads = leads.map((lead) => lead.id === id ? next : lead);
  emit();
}

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[leads-store] status update failed:", error);
    throw error;
  }

  leads = leads.map((l) =>
    l.id === id ? { ...l, status, rawStatus: status, lastActivity: new Date().toISOString() } : l
  );
  emit();
}

/**
 * Bulk status update — a single `.in("id", ids)` Supabase call instead of
 * one request per row. Returns the ids that failed (if any) so the caller
 * can report a partial failure rather than assuming all-or-nothing.
 */
export async function updateLeadsStatusBulk(ids: string[], status: LeadStatus): Promise<{ failedIds: string[] }> {
  if (ids.length === 0) return { failedIds: [] };
  const { error } = await supabase
    .from("leads")
    .update({ status, updated_at: new Date().toISOString() })
    .in("id", ids);

  if (error) {
    console.error("[leads-store] bulk status update failed:", error);
    return { failedIds: ids };
  }

  const idSet = new Set(ids);
  leads = leads.map((l) =>
    idSet.has(l.id) ? { ...l, status, rawStatus: status, lastActivity: new Date().toISOString() } : l
  );
  emit();
  return { failedIds: [] };
}

/**
 * Writes the canonical owner reference (leads.assigned_to — a real FK-
 * shaped UUID, confirmed live; see Phase 9.2 report). `memberId: null`
 * clears assignment ("Unassigned"). Deliberately does NOT touch the legacy
 * `custom_fields.owner` display-name text — new code should never write a
 * display name into assigned_to, and the local `owner`/`ownerInitials`
 * fields are left as whatever they were (the route resolves the current
 * display name from assignedTo + the live team list at render time instead
 * of trusting a possibly-stale cached name).
 */
export async function updateLeadOwner(id: string, memberId: string | null): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ assigned_to: memberId, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[leads-store] owner update failed:", error);
    throw error;
  }

  leads = leads.map((l) => (l.id === id ? { ...l, assignedTo: memberId, lastActivity: new Date().toISOString() } : l));
  emit();
}

export async function updateLeadsOwnerBulk(ids: string[], memberId: string | null): Promise<{ failedIds: string[] }> {
  if (ids.length === 0) return { failedIds: [] };
  const { error } = await supabase
    .from("leads")
    .update({ assigned_to: memberId, updated_at: new Date().toISOString() })
    .in("id", ids);

  if (error) {
    console.error("[leads-store] bulk owner update failed:", error);
    return { failedIds: ids };
  }

  const idSet = new Set(ids);
  leads = leads.map((l) => (idSet.has(l.id) ? { ...l, assignedTo: memberId, lastActivity: new Date().toISOString() } : l));
  emit();
  return { failedIds: [] };
}

export type DeleteLeadResult = { ok: true } | { ok: false; error: string; blocked?: true };

const CONVERTED_LEAD_MESSAGE = "Converted leads are retained to preserve the sales history associated with their deal.";

function isConvertedLead(lead: Pick<Lead, "status" | "convertedDealId">): boolean {
  return lead.status === "converted" || !!lead.convertedDealId;
}

/**
 * Hard-deletes a lead. No archive/soft-delete column exists on `leads`
 * today (confirmed via a live schema check — no `is_archived`/`archived`/
 * `archived_at`/`deleted_at` column) so this is the only option this pass
 * implements; a real archive field is deferred pending a migration
 * decision, not invented here.
 *
 * A converted lead is retained as a historical source record — this is a
 * hard, store-level guard (not just a UI-level one, per the Phase 9.2
 * consistency pass), checked against this function's own in-memory `leads`
 * state rather than trusting the caller to have already excluded it. If a
 * genuinely converted lead somehow isn't in local state yet (shouldn't
 * happen in practice), this fails open to the Supabase delete rather than
 * silently skipping — deleting a converted lead never cascades to its deal
 * either way (leads.converted_to_deal_id references deals(id) ON DELETE
 * SET NULL, the reverse direction; a lead row carries no ON DELETE CASCADE
 * onto deals). Use deleteLeadUnsafe() below only when a caller has already
 * made its own fully-informed decision to bypass this guard — nothing in
 * this codebase currently does.
 */
export async function deleteLead(id: string): Promise<DeleteLeadResult> {
  const current = leads.find((l) => l.id === id);
  if (current && isConvertedLead(current)) {
    return { ok: false, error: CONVERTED_LEAD_MESSAGE, blocked: true };
  }
  return deleteLeadUnsafe(id);
}

/**
 * The actual Supabase delete, with no converted-lead guard. Only exported
 * for deleteLead()/deleteLeadsBulk() to share — do not call this directly
 * from UI code; always go through deleteLead()/deleteLeadsBulk() so the
 * converted-lead protection can't be accidentally bypassed.
 */
async function deleteLeadUnsafe(id: string): Promise<DeleteLeadResult> {
  const { error } = await supabase.from("leads").delete().eq("id", id);

  if (error) {
    console.error("[leads-store] delete failed:", error);
    if (error.code === "23503") {
      return { ok: false, error: "This lead is linked to other records and can't be deleted." };
    }
    return { ok: false, error: "Failed to delete this lead. Please try again." };
  }

  leads = leads.filter((l) => l.id !== id);
  emit();
  return { ok: true };
}

export type BulkDeleteLeadsResult = { failedIds: string[]; skippedConvertedIds: string[] };

/**
 * Bulk delete. Re-derives the converted/eligible split from this store's
 * own in-memory state rather than trusting the caller's `ids` list to have
 * already excluded converted leads — the UI does its own filtering too
 * (so the two should normally agree), but this is the actual enforcement
 * point. Issues one `.in("id", ids)` request for the eligible subset
 * rather than one delete per row.
 */
export async function deleteLeadsBulk(ids: string[]): Promise<BulkDeleteLeadsResult> {
  if (ids.length === 0) return { failedIds: [], skippedConvertedIds: [] };

  const skippedConvertedIds: string[] = [];
  const eligibleIds: string[] = [];
  for (const id of ids) {
    const lead = leads.find((l) => l.id === id);
    if (lead && isConvertedLead(lead)) skippedConvertedIds.push(id);
    else eligibleIds.push(id);
  }

  if (eligibleIds.length === 0) return { failedIds: [], skippedConvertedIds };

  const { error } = await supabase.from("leads").delete().in("id", eligibleIds);

  if (error) {
    console.error("[leads-store] bulk delete failed:", error);
    return { failedIds: eligibleIds, skippedConvertedIds };
  }

  const idSet = new Set(eligibleIds);
  leads = leads.filter((l) => !idSet.has(l.id));
  emit();
  return { failedIds: [], skippedConvertedIds };
}

// ── Transactional conversion (convert_lead_to_deal RPC) ──

export type ConvertLeadPayload = {
  leadId: string;
  idempotencyKey: string;
  contactId?: string | null;
  newContact?: { full_name: string; email?: string | null; phone?: string | null; address?: string | null } | null;
  companyId?: string | null;
  newCompany?: { name: string } | null;
  companyContactRelationship?: { relationship_title?: string | null; department?: string | null; is_primary?: boolean } | null;
  pipelineId?: string | null;
  stageId?: string | null;
  title?: string | null;
  value?: number | null;
  ownerId?: string | null;
  expectedCloseDate?: string | null;
  serviceType?: string | null;
  projectAddress?: string | null;
  migratedNotes?: string | null;
  notesHash?: string | null;
};

export type ConvertLeadResult = {
  lead: any;
  contact: any;
  account: any;
  deal: any;
  stage: any;
  pipeline: any;
  ownerProfile: any;
  conversionState: {
    created: boolean;
    reusedExisting: boolean;
    notesMigrated: boolean;
  };
};

export async function convertLeadToDeal(payload: ConvertLeadPayload): Promise<ConvertLeadResult> {
  const { data, error } = await supabase.rpc("convert_lead_to_deal", {
    p_lead_id: payload.leadId,
    p_idempotency_key: payload.idempotencyKey,
    p_contact_id: payload.contactId ?? null,
    p_new_contact: payload.newContact ?? null,
    p_company_id: payload.companyId ?? null,
    p_new_company: payload.newCompany ?? null,
    p_company_contact_relationship: payload.companyContactRelationship ?? null,
    p_pipeline_id: payload.pipelineId ?? null,
    p_stage_id: payload.stageId ?? null,
    p_title: payload.title ?? null,
    p_value: payload.value ?? null,
    p_owner_id: payload.ownerId ?? null,
    p_expected_close_date: payload.expectedCloseDate ?? null,
    p_service_type: payload.serviceType ?? null,
    p_project_address: payload.projectAddress ?? null,
    p_migrated_notes: payload.migratedNotes ?? null,
    p_notes_hash: payload.notesHash ?? null,
  });

  if (error) throw error;

  const result = data as any;
  const leadRow = result.lead;

  // Reflect the canonical Lead state locally — no refetch needed.
  const contactMap = leadRow?.contact_id && result.contact ? { [leadRow.contact_id]: result.contact } : {};
  leads = leads.map((l) => (l.id === leadRow.id ? mapRow(leadRow, contactMap) : l));
  emit();

  return {
    lead: result.lead,
    contact: result.contact,
    account: result.account,
    deal: result.deal,
    stage: result.stage,
    pipeline: result.pipeline,
    ownerProfile: result.owner_profile,
    conversionState: {
      created: result.conversion_state.created,
      reusedExisting: result.conversion_state.reused_existing,
      notesMigrated: result.conversion_state.notes_migrated,
    },
  };
}

/**
 * Batched, awaited lead import (Stage 9.5) — unlike importLeads() below,
 * this awaits every insert and returns the real created rows (with real
 * ids) so the caller can log per-row import-job outcomes and support
 * rollback. Inserts run in small concurrent batches (not one huge
 * Promise.all over the whole file, not one request at a time either) to
 * bound load while still being meaningfully faster than fully sequential.
 */
export async function addLeadsBatch(newLeads: Omit<Lead, "id">[], batchSize = 25): Promise<{ created: Lead[]; failedIndexes: number[]; byIndex: (Lead | null)[] }> {
  const created: Lead[] = [];
  const failedIndexes: number[] = [];
  const byIndex: (Lead | null)[] = new Array(newLeads.length).fill(null);
  for (let i = 0; i < newLeads.length; i += batchSize) {
    const batch = newLeads.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((l) => addLead(l)));
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") { created.push(r.value); byIndex[i + idx] = r.value; }
      else failedIndexes.push(i + idx);
    });
  }
  return { created, failedIndexes, byIndex };
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

// Only call this after a conversion response confirms notes_migrated === true
// — never speculatively, and never before the RPC's response is in hand.
export function clearLeadNotes(leadId: string) {
  if (!(leadId in notesMap)) return;
  const next = { ...notesMap };
  delete next[leadId];
  notesMap = next;
  persistNotes();
  emitNotes();
}