// src/lib/contacts-store.ts
//
// Platform State Sync Phase S3 — Contacts shared server state.
//
// BEFORE S3: a module-level `contacts` array + a listener Set + `emit()` +
// `useSyncExternalStore`, i.e. an isolated hand-rolled cache with no
// realtime coverage and no shared invalidation with the rest of the app.
//
// AFTER S3: one TanStack Query per org (`queryKeys.contacts(orgId)`).
// `useContacts()` keeps its exact public shape (`Contact[]`, `[]` until
// loaded) but is now a thin `useQuery` wrapper, so every consumer
// (Contacts page, Inbox contact panel, Lead/Deal drawers, Command Center
// avatar surfaces, entity pickers, …) reads the SAME cached list. The
// imperative mutation functions (`addContact`/`updateContact`/… — called
// directly from ~25 sites, not hooks) are unchanged in signature; after a
// confirmed DB write they invalidate the relevant query keys on the shared
// client (see query-client.ts / getQueryClient()) instead of mutating a
// singleton. The central RealtimeBridge now also invalidates
// `queryKeys.contacts(orgId)` on any `contacts` row change.
//
// `getOrgId()` is kept here as a PURE helper (identical to org-id.ts's, but
// imported by ~12 other modules under this name) — not a cache.
//
// `mapRow` / `resolveCompanyNames` normalisation is unchanged from before —
// same columns, same company-name batch resolve, same avatar/messenger
// fields.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Contact } from "@/lib/mock-data";
import { ensureCompanyContactAssociation } from "@/lib/companies-store";
import { queryKeys } from "@/lib/query-keys";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";

// ── Org helper (pure — NOT a cache) ──
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
    // Real columns (see supabase/migrations/20260904_meta_schema_baseline.sql),
    // already fetched by the `select("*")` below and already declared on the
    // Contact type — previously silently dropped here during row mapping,
    // which meant every consumer of useContacts() (Inbox's composer channel
    // gating, in particular) always saw them as undefined even for a real
    // Messenger/Instagram contact. That's the actual root cause of the
    // Messenger/Instagram compose tabs never appearing — not a rendering bug.
    messenger_psid: row.messenger_psid ?? undefined,
    instagram_igsid: row.instagram_igsid ?? undefined,
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

// ── Query layer ──

/**
 * The Contacts list queryFn — org-scoped, newest-first, with companyName
 * batch-resolved. Self-contained (no React, no other query's cache) so it
 * is safe to run from `useQuery` or an imperative `refetchQueries`.
 */
export async function fetchContactsForOrg(orgId: string): Promise<Contact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[contacts-store] fetch failed:", error);
    throw error;
  }
  return resolveCompanyNames((data ?? []).map(mapRow));
}

/** Broad prefix invalidation for the shared Contacts list (all orgs cached — normally exactly one). */
function invalidateContactsQuery() {
  void getQueryClient().invalidateQueries({ queryKey: ["contacts"] });
}

/**
 * Immediately reflect a CONFIRMED change into the cached Contacts list(s)
 * so the UI updates without waiting for the reconciling refetch. Only ever
 * called with a real, persisted server row (from `.select().single()`) —
 * never speculatively — so it cannot disagree with a failed write.
 */
function patchContactsCache(fn: (list: Contact[]) => Contact[]) {
  getQueryClient().setQueriesData<Contact[]>({ queryKey: ["contacts"] }, (old) =>
    Array.isArray(old) ? fn(old) : old,
  );
}

/**
 * Dependency fan-out after a Contact write (name / avatar / tags / owner /
 * delete). This is THE one canonical propagation path — every Contact
 * mutation call site (the drawer's quick AvatarPicker, Edit→Save, tag
 * chips, bulk actions, the convert-lead reflect) reaches it through
 * updateContact/deleteContact/upsertContactFromRow, so none of them need
 * their own ad-hoc invalidation.
 *
 * A Contact's name/avatar/tags render in: the Contacts list, Conversations
 * rows, Leads' Contact enrichment, Command Center Recent-Activity avatars,
 * Pipeline Deal cards / Deal drawer (S4A — deals-store.ts's `["deals"]`
 * bundle re-enriches its linked Contact on refetch), and — since S4B —
 * Projects (projects-store.ts's `["projects"]` list embeds `client_name`
 * via a server-side join, refreshed the same way; a linked Contact's
 * AVATAR on Project surfaces was already independent of this store, since
 * Project cards resolve it by joining the separately-loaded useContacts()
 * list client-side rather than storing avatar fields on Project itself).
 * All Contact-dependent domains are Query-backed now, so a plain prefix
 * invalidation covers them — no more cross-store dynamic-import bridges.
 *
 * Deliberately scoped — NOT an invalidate-everything.
 */
function invalidateContactDependents() {
  const qc = getQueryClient();
  void qc.invalidateQueries({ queryKey: ["contacts"] });
  void qc.invalidateQueries({ queryKey: ["conversations"] });
  void qc.invalidateQueries({ queryKey: ["leads"] });
  void qc.invalidateQueries({ queryKey: ["deals"] });
  void qc.invalidateQueries({ queryKey: ["projects"] });
  void qc.invalidateQueries({ queryKey: ["dashboard"] });
}

// ── Public hooks (unchanged shape) ──

export function useContacts(): Contact[] {
  const orgId = useOrgId();
  const { data } = useQuery({
    queryKey: orgId ? queryKeys.contacts(orgId) : ["contacts", "_pending"],
    queryFn: () => fetchContactsForOrg(orgId as string),
    enabled: !!orgId,
    // Realtime + mutation invalidation drive freshness; staleTime just
    // caps redundant refetches on remount/focus churn.
    staleTime: 90_000,
  });
  return data ?? [];
}

export function useContactsLoading(): boolean {
  const orgId = useOrgId();
  const { isLoading, isPending } = useQuery({
    queryKey: orgId ? queryKeys.contacts(orgId) : ["contacts", "_pending"],
    queryFn: () => fetchContactsForOrg(orgId as string),
    enabled: !!orgId,
    staleTime: 90_000,
  });
  // Before org id resolves the query is disabled (isPending, not fetching)
  // — treat that as "still loading" to match the old `!loaded` semantics.
  return !orgId || isLoading || (isPending as boolean);
}

// ── Imperative mutations (unchanged signatures) ──

/**
 * Reflects a canonical Contact row (e.g. returned by the
 * convert_lead_to_deal RPC) into the shared cache. Returns the mapped
 * Contact for the caller; the list is refreshed via invalidation rather
 * than a hand-merged optimistic entry (the RPC has already persisted it).
 */
export function upsertContactFromRow(row: any): Contact {
  invalidateContactDependents();
  return mapRow(row);
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
  patchContactsCache((list) => [mapped, ...list.filter((c) => c.id !== mapped.id)]);
  invalidateContactsQuery();
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
  patchContactsCache((list) => list.map((c) => (c.id === id ? mapped : c)));
  // A Contact edit can change how it renders in Conversations / Leads /
  // Recent Activity (name, avatar, tags), so fan out — not just contacts.
  invalidateContactDependents();
  return mapped;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  if (error) {
    console.error("[contacts-store] delete failed:", error);
    return;
  }
  patchContactsCache((list) => list.filter((c) => c.id !== id));
  invalidateContactDependents();
}

export async function refreshContacts(): Promise<void> {
  await getQueryClient().refetchQueries({ queryKey: ["contacts"] });
}
