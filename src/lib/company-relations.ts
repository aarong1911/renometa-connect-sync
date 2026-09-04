// src/lib/company-relations.ts
//
// Platform State Sync Phase S5B — Account detail relationship data
// (company_contacts associations, company_notes, company_activities).
//
// BEFORE S5B: accounts_.$accountSlug.tsx's own `loadAccount()` ran all
// three of these as direct `supabase.from(...)` reads inside one big
// Promise.all, held the results in local `useState` arrays, and every
// mutation (link/unlink/set-primary/note add-edit-delete-pin) re-ran the
// ENTIRE cascade (10 queries, including company/projects/estimates/
// invoices/deal_activities/appointment_activities) just to refresh one
// small piece. No realtime coverage, no cross-tab updates.
//
// AFTER S5B: one TanStack Query per (org, company) for each of the three
// relationship resources. The route's mutation functions keep their exact
// existing Supabase writes (same invariant-sync rules, same toasts) — only
// the post-write refresh changed, from `loadAccount()` to calling the
// matching `invalidate*` helper below. The central RealtimeBridge also
// invalidates these on any `company_contacts`/`company_notes`/
// `company_activities` row change (by (org) prefix, since the bridge
// doesn't know which Account detail tab, if any, is open).
//
// Full Contact rows are deliberately NOT duplicated here — `useCompanyContacts`
// returns bare association rows (id, companyId, contactId, relationshipTitle,
// isPrimary); the route joins them against the already-shared
// `queryKeys.contacts(orgId)` list (contacts-store.ts) to build display rows.
// This keeps Contact identity canonical in exactly one cache.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";

const qc = () => getQueryClient();

// ── Contact associations (company_contacts) ────────────────────────────

export type CompanyContactAssociation = {
  id: string;
  companyId: string;
  contactId: string;
  relationshipTitle: string | null;
  isPrimary: boolean;
};

function mapAssociation(row: any): CompanyContactAssociation {
  return {
    id: row.id,
    companyId: row.company_id,
    contactId: row.contact_id,
    relationshipTitle: row.relationship_title ?? null,
    isPrimary: !!row.is_primary,
  };
}

export async function fetchCompanyContactsForOrgCompany(
  orgId: string,
  companyId: string,
): Promise<CompanyContactAssociation[]> {
  const { data, error } = await supabase
    .from("company_contacts")
    .select("id, company_id, contact_id, relationship_title, is_primary")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .order("is_primary", { ascending: false });

  if (error) {
    console.error("[company-relations] company_contacts fetch failed:", error);
    throw error;
  }
  return (data ?? []).map(mapAssociation);
}

export function useCompanyContacts(orgId: string | null | undefined, companyId: string | null | undefined) {
  const enabled = !!orgId && !!companyId;
  return useQuery({
    queryKey: enabled ? queryKeys.companyContacts(orgId as string, companyId as string) : ["companyContacts", "_pending"],
    queryFn: () => fetchCompanyContactsForOrgCompany(orgId as string, companyId as string),
    enabled,
    // Association changes are user-driven and infrequent per Account — the
    // realtime bridge + explicit post-mutation invalidation are the primary
    // freshness path, this just caps redundant refetches.
    staleTime: 45_000,
  });
}

export function invalidateCompanyContacts(orgId: string, companyId: string) {
  void qc().invalidateQueries({ queryKey: queryKeys.companyContacts(orgId, companyId) });
}

// ── Notes (company_notes) ───────────────────────────────────────────────
//
// Row shape kept intentionally loose (title/body/note/content all
// optional) — matches the pre-S5B route's own CompanyNote type, which
// already had to tolerate more than one possible text column on this
// table. Not reshaped/renamed here so the route's existing rendering
// (noteText() helper, is_pinned/author_name/created_at field access)
// needs zero changes.

export type CompanyNoteRow = {
  id: string;
  title?: string | null;
  body?: string | null;
  note?: string | null;
  content?: string | null;
  is_pinned?: boolean | null;
  author_name?: string | null;
  created_at: string;
  updated_at?: string | null;
};

export async function fetchCompanyNotesForOrgCompany(orgId: string, companyId: string): Promise<CompanyNoteRow[]> {
  const { data, error } = await supabase
    .from("company_notes")
    .select("*")
    .eq("company_id", companyId)
    .eq("org_id", orgId)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[company-relations] company_notes fetch failed:", error);
    throw error;
  }
  return (data ?? []) as CompanyNoteRow[];
}

export function useCompanyNotes(orgId: string | null | undefined, companyId: string | null | undefined) {
  const enabled = !!orgId && !!companyId;
  return useQuery({
    queryKey: enabled ? queryKeys.companyNotes(orgId as string, companyId as string) : ["companyNotes", "_pending"],
    queryFn: () => fetchCompanyNotesForOrgCompany(orgId as string, companyId as string),
    enabled,
    staleTime: 30_000,
  });
}

export function invalidateCompanyNotes(orgId: string, companyId: string) {
  void qc().invalidateQueries({ queryKey: queryKeys.companyNotes(orgId, companyId) });
}

// ── Activities (company_activities) ─────────────────────────────────────
//
// Same "keep the existing shape" rule as notes — the route merges this
// list with derived deal_activities/appointment_activities rows client-
// side (mergedActivity), so the field names must stay activity_type/
// title/description/occurred_at/created_at/created_by_name.

export type CompanyActivityRow = {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  occurred_at?: string | null;
  created_at: string;
  created_by_name?: string | null;
};

export async function fetchCompanyActivitiesForOrgCompany(orgId: string, companyId: string): Promise<CompanyActivityRow[]> {
  const { data, error } = await supabase
    .from("company_activities")
    .select("*")
    .eq("company_id", companyId)
    .eq("org_id", orgId)
    .order("occurred_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) {
    console.error("[company-relations] company_activities fetch failed:", error);
    throw error;
  }
  return (data ?? []) as CompanyActivityRow[];
}

export function useCompanyActivities(orgId: string | null | undefined, companyId: string | null | undefined) {
  const enabled = !!orgId && !!companyId;
  return useQuery({
    queryKey: enabled ? queryKeys.companyActivities(orgId as string, companyId as string) : ["companyActivities", "_pending"],
    queryFn: () => fetchCompanyActivitiesForOrgCompany(orgId as string, companyId as string),
    enabled,
    staleTime: 30_000,
  });
}

export function invalidateCompanyActivities(orgId: string, companyId: string) {
  void qc().invalidateQueries({ queryKey: queryKeys.companyActivities(orgId, companyId) });
}
