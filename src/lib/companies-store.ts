// src/lib/companies-store.ts
//
// Phase 9.4 — the single canonical company data store. Before this file
// existed, `Company`/`CompanyRow` were independently redefined in
// src/routes/companies.tsx, src/routes/accounts_.$accountSlug.tsx, and
// src/lib/deals-store.ts, and each file ran its own ad hoc
// `supabase.from("companies")` query. This consolidates reads/writes
// behind one reactive store — callers are being migrated gradually (per
// instruction), not all in one pass, so existing page-level dialogs that
// already work (e.g. companies.tsx's logo upload, accounts_.$accountSlug's
// company_notes/company_activities/company_contacts UI) are left in place
// and only their *data-access* points are redirected here where it was
// safe to do so without touching working UI.
//
// Live schema (confirmed via a direct check, not assumed from any prior
// type): companies has id, org_id, name, industry, website, phone, email,
// address, city, state, zip, country, logo_url, notes, custom_fields
// (jsonb), account_type, status, owner_name (legacy display-text — no real
// owner UUID column exists), tags (real text[]), created_by, created_at,
// updated_at, slug. No archive/soft-delete column exists.

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";

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

export type Company = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  logo_url: string | null;
  // Legacy single free-text blurb — distinct from the generic `notes`
  // table's per-note history (see contact-notes.ts's useEntityNotes and
  // this task's report for why accounts_.$accountSlug.tsx's real,
  // already-working `company_notes` table is kept as the canonical
  // multi-note mechanism instead of being migrated to the generic table).
  notes: string | null;
  custom_fields: Record<string, unknown> | null;
  account_type: string;
  status: string;
  // Legacy display-text owner — no real owner_id/assigned_to UUID column
  // exists on companies (confirmed live). Never write more into this than
  // the pre-existing owner-picker UI already did; do not treat it as a
  // safely-editable canonical reference.
  owner_name: string | null;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: any): Company {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name ?? "",
    slug: row.slug ?? "",
    industry: row.industry ?? null,
    website: row.website ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
    country: row.country ?? null,
    logo_url: row.logo_url ?? null,
    notes: row.notes ?? null,
    custom_fields: row.custom_fields ?? null,
    account_type: row.account_type ?? "Prospect",
    status: row.status ?? "Active",
    owner_name: row.owner_name ?? null,
    tags: row.tags ?? [],
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Slug helpers (Priority 4) — canonical here; both companies.tsx and
// accounts_.$accountSlug.tsx previously had their own copies of this exact
// logic. ────────────────────────────────────────────────────────────────
export function slugifyCompanyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "account";
}

/**
 * Generates an org-scoped unique slug, appending a stable numeric suffix on
 * collision (matching the existing UX — manual slug editing isn't exposed
 * anywhere in the current form, so this is the only slug-generation path).
 * `excludeCompanyId` lets an edit keep its own current slug rather than
 * detecting a false collision against itself.
 */
export async function createUniqueCompanySlug(
  orgId: string,
  name: string,
  excludeCompanyId?: string,
): Promise<string> {
  const baseSlug = slugifyCompanyName(name);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    let query = supabase.from("companies").select("id").eq("org_id", orgId).eq("slug", candidate);
    if (excludeCompanyId) query = query.neq("id", excludeCompanyId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

// ── Reactive store ──────────────────────────────────────────────────────
let companies: Company[] = [];
let loaded = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

export async function fetchCompanies(): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) return;

  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("org_id", orgId)
    .order("name");

  if (error) {
    console.error("[companies-store] fetch failed:", error);
    return;
  }

  companies = (data ?? []).map(mapRow);
  loaded = true;
  emit();
}

fetchCompanies();

export function useCompanies(): Company[] {
  useEffect(() => { if (!loaded) void fetchCompanies(); }, []);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => companies,
    () => [],
  );
}

export function useCompaniesLoading(): boolean {
  return !loaded;
}

export function getCompanyById(id: string): Company | undefined {
  return companies.find((c) => c.id === id);
}

export function getCompanyBySlug(slug: string): Company | undefined {
  return companies.find((c) => c.slug === slug);
}

/**
 * Direct, live, org-scoped lookup by slug — used by the detail route,
 * which can't wait for the full list to load first and needs the
 * authoritative row (not a possibly-stale cached one). Cross-org safety:
 * always filters by the caller's own resolved orgId, never a client-
 * supplied one, so a slug from another organization can never resolve.
 */
export async function fetchCompanyBySlug(slug: string): Promise<Company | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("slug", slug)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[companies-store] fetchCompanyBySlug failed:", error);
    return null;
  }
  if (!data) return null;
  const mapped = mapRow(data);
  upsertCompanyLocal(mapped);
  return mapped;
}

/** Reflects a canonical row into the reactive store without a refetch. */
export function upsertCompanyLocal(company: Company): void {
  const idx = companies.findIndex((c) => c.id === company.id);
  companies = idx >= 0 ? companies.map((c, i) => (i === idx ? company : c)) : [...companies, company].sort((a, b) => a.name.localeCompare(b.name));
  emit();
}

export type NewCompanyInput = Partial<Omit<Company, "id" | "org_id" | "slug" | "created_at" | "updated_at" | "created_by">> & { name: string };

export async function addCompany(input: NewCompanyInput): Promise<Company | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const slug = await createUniqueCompanySlug(orgId, input.name);

  const { data, error } = await supabase
    .from("companies")
    .insert({
      org_id: orgId,
      slug,
      name: input.name.trim(),
      industry: input.industry ?? null,
      website: input.website ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      country: input.country ?? "United States",
      logo_url: input.logo_url ?? null,
      notes: input.notes ?? null,
      account_type: input.account_type ?? "Prospect",
      status: input.status ?? "Active",
      owner_name: input.owner_name ?? null,
      tags: input.tags ?? [],
    })
    .select("*")
    .single();

  if (error) {
    console.error("[companies-store] insert failed:", error);
    return null;
  }

  const mapped = mapRow(data);
  upsertCompanyLocal(mapped);
  return mapped;
}

export async function updateCompany(id: string, patch: Partial<Company>): Promise<Company | null> {
  const update: Record<string, any> = {};
  // "slug" is included so a caller can backfill a slug onto a legacy row
  // that predates the slug column being required (QA pass fix — the
  // Companies page's own edit dialog previously bypassed this store
  // entirely, in part because this function couldn't write slug). Every
  // other caller continues to leave slug alone by simply not passing it.
  for (const key of ["name", "industry", "website", "phone", "email", "address", "city", "state", "zip", "country", "logo_url", "notes", "account_type", "status", "owner_name", "tags", "custom_fields", "slug"] as const) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  update.updated_at = new Date().toISOString();

  const orgId = await getOrgId();
  if (!orgId) return null;

  const { data, error } = await supabase
    .from("companies")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) {
    console.error("[companies-store] update failed:", error);
    return null;
  }

  const mapped = mapRow(data);
  upsertCompanyLocal(mapped);
  return mapped;
}

// ── Contact↔Company synchronization (Phase 9.4 consistency pass) ─────────
//
// DOCUMENTED INVARIANT (the "recommended invariant" from the Stage 9.4
// consistency spec, adopted as-is since nothing in the live schema
// conflicts with it):
//   - contacts.company_id  = the contact's single default/direct company.
//   - company_contacts     = ALL of the contact's company associations,
//                            plus relationship metadata (title/department/
//                            is_primary).
//   - Every non-null contacts.company_id should have a corresponding
//     company_contacts row (enforced going forward by the sync points in
//     contacts-store.ts and accounts_.$accountSlug.tsx — historical rows
//     created before this pass are NOT retroactively backfilled here).
//   - Not every company_contacts row becomes contacts.company_id — a
//     contact can be associated with several companies while directly
//     belonging to one (or none).
//
// Known, documented gap: the convert_lead_to_deal RPC creates a
// company_contacts row but does not set contacts.company_id — fixing that
// means altering the RPC, which every Phase 9 pass has been instructed
// not to do. Deferred.

/**
 * Ensures a company_contacts association row exists for (company, contact)
 * — idempotent (ON CONFLICT DO NOTHING against company_contacts_unique),
 * never marks primary, never touches an existing row's metadata, so it can
 * safely run after any contacts.company_id write without downgrading a
 * real primary flag someone set deliberately.
 */
export async function ensureCompanyContactAssociation(orgId: string, companyId: string, contactId: string): Promise<void> {
  const { error } = await supabase.from("company_contacts").upsert(
    { org_id: orgId, company_id: companyId, contact_id: contactId, is_primary: false },
    { onConflict: "company_id,contact_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[companies-store] association sync failed:", error);
  }
}

export type CompanyLinkedRecordCount = {
  label: string;
  count: number;
  /**
   * Whether this record type prevents deletion. Explicit flag (Phase 9.4
   * consistency pass) rather than the earlier label-prefix string check.
   * Blocking: deals, projects, estimates, invoices, AND directly-affiliated
   * contacts (contacts.company_id pointing at this company) — deleting the
   * company would either leave those contacts with a stale/dangling
   * company_id or fail outright at the database, depending on the FK's ON
   * DELETE behavior, which cannot be verified from this environment (no
   * information_schema access) and is deliberately not assumed. Non-blocking:
   * company_contacts association rows (pure metadata; contacts themselves
   * are never deleted). company_notes/company_activities are not counted
   * here — their FK behavior is likewise unverified, so a RESTRICT there
   * surfaces as the friendly 23503 message in deleteCompany() rather than
   * being silently assumed to cascade.
   */
  blocking: boolean;
};

/**
 * Organization-scoped linked-record check before deletion (Priority 12).
 * `deals.company_id` is a real direct FK; projects/estimates/invoices have
 * no company_id column (confirmed live) so they're counted via their real
 * `client_id` against contacts whose `company_id` matches this company —
 * an ID-based join, not free-text name matching, explicitly documented as
 * an indirect/contact-mediated count rather than a direct one.
 */
export async function countCompanyLinkedRecords(companyId: string, orgId: string): Promise<CompanyLinkedRecordCount[]> {
  const { data: linkedContacts } = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("company_id", companyId);
  const contactIds = (linkedContacts ?? []).map((c: any) => c.id as string);

  const [companyContacts, deals, projects, estimates, invoices] = await Promise.all([
    supabase.from("company_contacts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("org_id", orgId),
    supabase.from("deals").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("org_id", orgId),
    contactIds.length > 0
      ? supabase.from("projects").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("client_id", contactIds)
      : Promise.resolve({ count: 0 } as any),
    contactIds.length > 0
      ? supabase.from("estimates").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("client_id", contactIds)
      : Promise.resolve({ count: 0 } as any),
    contactIds.length > 0
      ? supabase.from("invoices").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("client_id", contactIds)
      : Promise.resolve({ count: 0 } as any),
  ]);

  return [
    { label: "directly affiliated contact", count: contactIds.length, blocking: true },
    { label: "contact association", count: companyContacts.count ?? 0, blocking: false },
    { label: "deal", count: deals.count ?? 0, blocking: true },
    { label: "project (via linked contacts)", count: (projects as any).count ?? 0, blocking: true },
    { label: "estimate (via linked contacts)", count: (estimates as any).count ?? 0, blocking: true },
    { label: "invoice (via linked contacts)", count: (invoices as any).count ?? 0, blocking: true },
  ].filter((r) => r.count > 0);
}

export type DeleteCompanyResult = { ok: true } | { ok: false; error: string };

/**
 * Deletes a company only when it has zero blocking linked records — a
 * store-level guard, not only a UI-level one (see
 * CompanyLinkedRecordCount.blocking for the exact classification).
 * Contacts, deals, projects, estimates, and invoices are NEVER deleted or
 * modified by this function. The only explicit cleanup performed is
 * removing this company's own company_contacts association rows (pure
 * link metadata, non-blocking by classification) — done explicitly here
 * rather than assumed to cascade, since the FK's ON DELETE behavior can't
 * be verified from this environment. If some other unverified FK (e.g.
 * company_notes/company_activities) RESTRICTs the delete anyway, the
 * 23503 branch below reports it as a friendly message instead of raw
 * Postgres error text.
 */
export async function deleteCompany(id: string): Promise<DeleteCompanyResult> {
  const orgId = await getOrgId();
  if (!orgId) return { ok: false, error: "Could not determine your workspace." };

  const linked = await countCompanyLinkedRecords(id, orgId);
  const blocking = linked.filter((l) => l.blocking);
  if (blocking.length > 0) {
    return {
      ok: false,
      error: `This account is still linked to ${blocking.map((l) => `${l.count} ${l.label}${l.count === 1 ? "" : "s"}`).join(", ")}. Reassign or remove those records first.`,
    };
  }

  // Explicit association cleanup — never assumed via cascade.
  const { error: assocError } = await supabase
    .from("company_contacts")
    .delete()
    .eq("company_id", id)
    .eq("org_id", orgId);
  if (assocError) {
    console.error("[companies-store] association cleanup failed:", assocError);
    return { ok: false, error: "Could not remove this account's contact associations. Please try again." };
  }

  const { error } = await supabase.from("companies").delete().eq("id", id).eq("org_id", orgId);
  if (error) {
    console.error("[companies-store] delete failed:", error);
    if ((error as any).code === "23503") {
      return { ok: false, error: "This account is linked to other records and can't be deleted." };
    }
    return { ok: false, error: "Failed to delete this account. Please try again." };
  }

  companies = companies.filter((c) => c.id !== id);
  emit();
  return { ok: true };
}

export async function refreshCompanies(): Promise<void> {
  await fetchCompanies();
}

/**
 * Exact-match duplicate warning (Priority 18) — normalized name or website
 * domain, organization-scoped. Never fuzzy/similar-name matching, never
 * blocks creation outright — only surfaces candidates for the caller to
 * warn about and let the user acknowledge.
 */
export type CompanyDuplicateCandidate = { id: string; name: string; website: string | null; matchedOn: "name" | "website" };

function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function findCompanyDuplicateCandidates(
  name: string,
  website: string | null | undefined,
  excludeCompanyId?: string,
): CompanyDuplicateCandidate[] {
  const normalizedName = normalizeCompanyName(name);
  const domain = websiteDomain(website);
  const candidates: CompanyDuplicateCandidate[] = [];
  const seen = new Set<string>();

  for (const c of companies) {
    if (excludeCompanyId && c.id === excludeCompanyId) continue;
    if (normalizedName && normalizeCompanyName(c.name) === normalizedName && !seen.has(c.id)) {
      seen.add(c.id);
      candidates.push({ id: c.id, name: c.name, website: c.website, matchedOn: "name" });
      continue;
    }
    if (domain && websiteDomain(c.website) === domain && !seen.has(c.id)) {
      seen.add(c.id);
      candidates.push({ id: c.id, name: c.name, website: c.website, matchedOn: "website" });
    }
  }
  return candidates;
}
