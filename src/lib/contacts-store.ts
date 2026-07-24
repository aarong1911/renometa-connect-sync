// src/lib/contacts-store.ts
// Supabase-backed contacts store — maintains the same hook interface
// so existing page components work without changes.

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Contact } from "@/lib/mock-data";

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
function mapRow(row: any): Contact {
  return {
    id: row.id,
    name: row.full_name ?? "Unknown",
    email: row.email ?? "",
    phone: row.phone ?? "",
    address: row.address ?? "",
    company: row.company ?? "",
    tags: row.labels ?? [],
    owner: row.owner ?? "—",
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    createdAt: row.created_at ?? new Date().toISOString(),
    avatar_key: row.avatar_key ?? null,
  };
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

  contacts = (data ?? []).map(mapRow);
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
      company: contact.company || null,
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

  const mapped = mapRow(data);
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
  if (patch.company !== undefined) update.company = patch.company || null;
  if (patch.owner !== undefined) update.owner = patch.owner && patch.owner !== "—" ? patch.owner : null;
  if (patch.tags !== undefined) update.labels = patch.tags;
  if (patch.avatar_key !== undefined) update.avatar_key = patch.avatar_key;

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

  const mapped = mapRow(data);
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