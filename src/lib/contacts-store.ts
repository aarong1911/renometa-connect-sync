// src/lib/contacts-store.ts
// Supabase-backed contacts store — maintains the same hook interface
// so existing page components work without changes.

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Contact } from "@/lib/mock-data";
import { ensureCompanyContactAssociation } from "@/lib/companies-store";

// ── Org helper ──
export async function getOrgId(): Promise<string | null> {
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

// ── Map Supabase row → Contact type ──
//
// Phase 9.1 canonicalization: contacts.company_id is now the canonical
// contact→company relationship. `company` (legacy free text) is kept only
// as a display fallback for rows created before company_id existed, or
// created through a path that still only collects free text. Nothing here
// fuzzy-matches `company` text to an existing companies row automatically —
// that would risk silently linking a contact to the wrong company; a
// historical backfill needs manual review or a dedicated migration later,
// not this store.
//
// companyName is NOT a stored column — see resolveCompanyNames() below,
// which batch-resolves it from companies.id for whichever contacts have a
// company_id, without a per-row query.
function mapRow(row: any): Contact {
  return {
    id: row.id,
    name: row.full_name ?? "Unknown",
    email: row.email ?? "",
    phone: row.phone ?? "",
    address: row.address ?? "",
    company: row.company ?? "",
    company_id: row.company_id ?? null,
    companyName: null,
    source: row.source ?? "",
    tags: row.labels ?? [],
    // `owner` is a plain display-name string, NOT a foreign key to
    // profiles/org_memberships (Phase 9 audit finding) — a renamed or
    // removed team member silently leaves stale text on old rows with no
    // cleanup path. Documented as legacy; the canonical future owner
    // reference should be a profile UUID (see Phase 9.1 report). New code
    // should not write anything into this field beyond what the existing
    // owner-select UI already does (a team member's current display name).
    owner: row.owner ?? "—",
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    createdAt: row.created_at ?? new Date().toISOString(),
    avatar_key: row.avatar_key ?? null,
    // Real column, confirmed to exist in the live schema, currently never
    // written by any code path in this codebase (always null today) — kept
    // read-only here rather than removed. See Contact type in mock-data.ts.
    avatar_url: row.avatar_url ?? null,
  };
}

// Batch-resolves companyName for every contact that has a company_id, in
// one query — avoids an N+1 per-row companies lookup. Contacts with no
// company_id are left with companyName: null (display falls back to the
// legacy `company` text, if any).
async function resolveCompanyNames(rows: Contact[]): Promise<Contact[]> {
  const companyIds = [...new Set(rows.map((c) => c.company_id).filter((id): id is string => !!id))];
  if (companyIds.length === 0) return rows;

  const { data, error } = await supabase.from("companies").select("id, name").in("id", companyIds);
  if (error) {
    console.error("[contacts-store] company name resolution failed:", error);
    return rows;
  }
  const nameById = new Map((data ?? []).map((c: any) => [c.id, c.name]));
  return rows.map((c) => (c.company_id ? { ...c, companyName: nameById.get(c.company_id) ?? null } : c));
}

// ── Reactive store ──
let contacts: Contact[] = [];
let loaded = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

async function fetchContacts(): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) return;

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[contacts-store] fetch failed:", error);
    return;
  }

  contacts = await resolveCompanyNames((data ?? []).map(mapRow));
  loaded = true;
  emit();
}

// Initial fetch on first import
fetchContacts();

// ── Public API — same interface as before ──

export function getContacts(): Contact[] {
  return contacts;
}

export function useContacts(): Contact[] {
  // Trigger fetch if not loaded yet
  useEffect(() => { if (!loaded) fetchContacts(); }, []);

  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => contacts,
    () => [],
  );
}

export function useContactsLoading(): boolean {
  return !loaded;
}

// Reflects a canonical Contact row (e.g. returned by the convert_lead_to_deal
// RPC) into the reactive store without a refetch — inserts if new, replaces
// if already known.
export function upsertContactFromRow(row: any): Contact {
  const mapped = mapRow(row);
  const idx = contacts.findIndex((c) => c.id === mapped.id);
  contacts = idx >= 0 ? contacts.map((c, i) => (i === idx ? mapped : c)) : [mapped, ...contacts];
  emit();
  return mapped;
}

export async function addContact(contact: Omit<Contact, "id">, opts?: { source?: string }): Promise<Contact | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;

  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      full_name: contact.name,
      email: contact.email || null,
      phone: contact.phone || null,
      // company_id is canonical when the caller supplies one (e.g. a future
      // company-picker UI); `company` free text is only written when no
      // company_id is given, per Phase 9.1's canonicalization rule — never
      // write both from new code.
      company_id: contact.company_id || null,
      company: contact.company_id ? null : (contact.company || null),
      address: contact.address || null,
      source: opts?.source ?? "manual",
      labels: contact.tags ?? [],
      owner: contact.owner && contact.owner !== "—" ? contact.owner : null,
    })
    .select()
    .single();

  if (error) {
    console.error("[contacts-store] insert failed:", error);
    return null;
  }

  // Invariant sync (Phase 9.4): every non-null contacts.company_id gets a
  // corresponding company_contacts row. Never auto-primary — see
  // ensureCompanyContactAssociation's own doc comment.
  if (data.company_id) {
    await ensureCompanyContactAssociation(orgId, data.company_id, data.id);
  }

  const [mapped] = await resolveCompanyNames([mapRow(data)]);
  contacts = [mapped, ...contacts];
  emit();
  return mapped;
}

export async function updateContact(id: string, patch: Partial<Contact>): Promise<Contact | null> {
  const update: Record<string, any> = {};
  if (patch.name !== undefined) update.full_name = patch.name;
  if (patch.email !== undefined) update.email = patch.email || null;
  if (patch.phone !== undefined) update.phone = patch.phone || null;
  if (patch.address !== undefined) update.address = patch.address || null;
  // company_id is canonical — when a caller explicitly sets it, clear the
  // legacy free-text company column rather than let both diverge. A patch
  // that only touches legacy `company` (no company_id in this same patch)
  // leaves company_id untouched, so editing the free-text fallback on an
  // old row never accidentally severs a real company_id link elsewhere.
  if (patch.company_id !== undefined) {
    update.company_id = patch.company_id || null;
    update.company = null;
  } else if (patch.company !== undefined) {
    update.company = patch.company || null;
  }
  if (patch.owner !== undefined) update.owner = patch.owner && patch.owner !== "—" ? patch.owner : null;
  if (patch.source !== undefined) update.source = patch.source || null;
  if (patch.tags !== undefined) update.labels = patch.tags;
  if (patch.avatar_key !== undefined) update.avatar_key = patch.avatar_key || null;

  const { data, error } = await supabase
    .from("contacts")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[contacts-store] update failed:", error);
    return null;
  }

  // Invariant sync (Phase 9.4): a newly-set contacts.company_id gets a
  // corresponding company_contacts row. Clearing/changing company_id does
  // NOT remove old association rows — company_contacts is the full
  // association history, direct affiliation is only one of them (see the
  // invariant comment in companies-store.ts).
  if (patch.company_id !== undefined && data.company_id && data.org_id) {
    await ensureCompanyContactAssociation(data.org_id, data.company_id, data.id);
  }

  const [mapped] = await resolveCompanyNames([mapRow(data)]);
  contacts = contacts.map((c) => c.id === id ? mapped : c);
  emit();
  return mapped;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  if (error) {
    console.error("[contacts-store] delete failed:", error);
    return;
  }
  contacts = contacts.filter((c) => c.id !== id);
  emit();
}

export async function refreshContacts(): Promise<void> {
  await fetchContacts();
}