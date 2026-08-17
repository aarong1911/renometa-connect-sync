// src/lib/marketing-audience.ts
//
// Shared, whitelisted Audience filter shape + resolver for Phase 14.1
// Campaigns. Imported both by the frontend (live preview counts while
// building an Audience/Campaign) and by the trusted Netlify functions
// (marketing-audience-preview.ts, marketing-campaign-send.ts) that
// authoritatively resolve recipients at send time — one implementation,
// not two copies that could drift.
//
// Only whitelisted field/operator combinations below are ever accepted.
// Nothing here builds or accepts raw SQL — every condition maps to a
// parameterized Supabase Postgrest call.
//
// Deliberately does NOT filter on structured city/state — contacts has
// only a single free-text `address` column (no city/state/zip breakdown),
// confirmed by audit. `address_contains` below is an honest ILIKE match
// against that real column, not a fabricated structured filter.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ContactCategory = "lead" | "customer" | "past_customer";

export const CONTACT_CATEGORY_OPTIONS: { value: ContactCategory; label: string }[] = [
  { value: "lead", label: "Leads" },
  { value: "customer", label: "Active customers" },
  { value: "past_customer", label: "Past customers" },
];

export const LEAD_STATUS_OPTIONS = ["new", "contacted", "qualified", "converted", "lost"] as const;

export type AudienceCondition =
  | { field: "contact_category"; operator: "in"; value: ContactCategory[] }
  | { field: "lead_status"; operator: "in"; value: string[] }
  | { field: "lead_source"; operator: "in"; value: string[] }
  | { field: "contact_source"; operator: "in"; value: string[] }
  | { field: "tags"; operator: "has_any"; value: string[] }
  | { field: "project_status"; operator: "in"; value: string[] }
  | { field: "estimate_status"; operator: "in"; value: string[] }
  | { field: "created_after"; operator: "gte"; value: string }
  | { field: "created_before"; operator: "lte"; value: string }
  | { field: "address_contains"; operator: "contains"; value: string };

export type AudienceFilters = {
  conditions: AudienceCondition[];
};

const ALLOWED_FIELDS = new Set<AudienceCondition["field"]>([
  "contact_category", "lead_status", "lead_source", "contact_source",
  "tags", "project_status", "estimate_status", "created_after",
  "created_before", "address_contains",
]);

/** Validates an arbitrary JSON value against the whitelist above. Throws on anything else — never trust client-supplied filter JSON as-is. */
export function validateAudienceFilters(raw: unknown): AudienceFilters {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).conditions)) {
    return { conditions: [] };
  }
  const conditions: AudienceCondition[] = [];
  for (const c of (raw as any).conditions) {
    if (!c || typeof c !== "object" || !ALLOWED_FIELDS.has(c.field)) continue;
    if (c.field === "created_after" || c.field === "created_before") {
      if (typeof c.value === "string" && c.value) conditions.push({ field: c.field, operator: c.field === "created_after" ? "gte" : "lte", value: c.value });
    } else if (c.field === "address_contains") {
      if (typeof c.value === "string" && c.value.trim()) conditions.push({ field: "address_contains", operator: "contains", value: c.value.trim() });
    } else if (c.field === "tags") {
      if (Array.isArray(c.value) && c.value.length) conditions.push({ field: "tags", operator: "has_any", value: c.value.filter((v: any) => typeof v === "string") });
    } else {
      if (Array.isArray(c.value) && c.value.length) conditions.push({ field: c.field, operator: "in", value: c.value.filter((v: any) => typeof v === "string") } as AudienceCondition);
    }
  }
  return { conditions };
}

export type SmsStatus = "unknown" | "eligible" | "opted_out" | "suppressed";

export type AudienceContact = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  // Communication-preference state now lives in the dedicated,
  // service-role-owned marketing_contact_preferences table (see the
  // pre-apply hardening pass on 20260829_marketing_campaigns_foundation.sql)
  // — never columns on `contacts`, which ordinary authenticated CRM edits
  // can freely write to. A contact with no preferences row yet gets the
  // safe defaults below (email eligible/opt-out model, SMS 'unknown'/
  // opt-in model) rather than a second, divergent notion of "default".
  email_unsubscribed: boolean;
  email_suppressed: boolean;
  sms_status: SmsStatus;
};

/**
 * Resolves the set of org contacts matching ALL given conditions (AND across
 * conditions; `in`/`has_any` are OR within a single condition's own values).
 * Returns full contact rows (not just ids) so callers can compute per-contact
 * channel eligibility without a second round-trip.
 */
export async function resolveAudienceContacts(
  client: SupabaseClient,
  orgId: string,
  filters: AudienceFilters,
): Promise<AudienceContact[]> {
  const [{ data: baseRows, error: baseErr }, { data: prefRows, error: prefErr }] = await Promise.all([
    client
      .from("contacts")
      .select("id, full_name, email, phone, source, labels, created_at")
      .eq("org_id", orgId),
    client
      .from("marketing_contact_preferences")
      .select("contact_id, email_unsubscribed, email_suppressed, sms_status")
      .eq("org_id", orgId),
  ]);
  if (baseErr) throw new Error(`contacts query failed: ${baseErr.message}`);
  if (prefErr) throw new Error(`marketing_contact_preferences query failed: ${prefErr.message}`);

  const prefsByContact = new Map((prefRows ?? []).map((p: any) => [p.contact_id, p]));

  let matchingIds: Set<string> | null = null;
  const intersect = (ids: Set<string>) => {
    matchingIds = matchingIds === null ? ids : new Set([...matchingIds].filter((id) => ids.has(id)));
  };

  const rowsById = new Map((baseRows ?? []).map((r: any) => [r.id, r]));
  const allIds = new Set(rowsById.keys());

  for (const cond of filters.conditions) {
    if (cond.field === "contact_source") {
      const set = new Set([...allIds].filter((id) => cond.value.includes(rowsById.get(id)?.source ?? "")));
      intersect(set);
    } else if (cond.field === "tags") {
      const set = new Set(
        [...allIds].filter((id) => {
          const labels: string[] = rowsById.get(id)?.labels ?? [];
          return cond.value.some((tag) => labels.includes(tag));
        }),
      );
      intersect(set);
    } else if (cond.field === "created_after" || cond.field === "created_before") {
      const cutoff = new Date(cond.value).getTime();
      const set = new Set(
        [...allIds].filter((id) => {
          const created = new Date(rowsById.get(id)?.created_at ?? 0).getTime();
          return cond.field === "created_after" ? created >= cutoff : created <= cutoff;
        }),
      );
      intersect(set);
    } else if (cond.field === "address_contains") {
      const { data: addrRows } = await client
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .ilike("address", `%${cond.value}%`);
      intersect(new Set((addrRows ?? []).map((r: any) => r.id)));
    } else if (cond.field === "lead_status" || cond.field === "lead_source") {
      let q = client.from("leads").select("contact_id").eq("org_id", orgId).not("contact_id", "is", null);
      q = cond.field === "lead_status" ? q.in("status", cond.value) : q.in("source", cond.value);
      const { data: leadRows } = await q;
      intersect(new Set((leadRows ?? []).map((r: any) => r.contact_id).filter(Boolean)));
    } else if (cond.field === "project_status") {
      const { data: projRows } = await client
        .from("projects")
        .select("client_id")
        .eq("org_id", orgId)
        .in("status", cond.value)
        .not("client_id", "is", null);
      intersect(new Set((projRows ?? []).map((r: any) => r.client_id).filter(Boolean)));
    } else if (cond.field === "estimate_status") {
      const { data: estRows } = await client
        .from("estimates")
        .select("client_id")
        .eq("org_id", orgId)
        .in("status", cond.value)
        .not("client_id", "is", null);
      intersect(new Set((estRows ?? []).map((r: any) => r.client_id).filter(Boolean)));
    } else if (cond.field === "contact_category") {
      const categorySets = await Promise.all(cond.value.map((cat) => resolveCategoryIds(client, orgId, cat)));
      const union = new Set<string>();
      for (const s of categorySets) for (const id of s) union.add(id);
      intersect(union);
    }
  }

  const finalIds = matchingIds ?? allIds;
  return [...finalIds].map((id) => {
    const r = rowsById.get(id);
    const pref = prefsByContact.get(id);
    return {
      id,
      full_name: r?.full_name ?? "Unknown",
      email: r?.email ?? null,
      phone: r?.phone ?? null,
      // No preferences row = never unsubscribed/suppressed (email's
      // opt-out-model default) but 'unknown' for SMS (opt-in-model
      // default) — see the AudienceContact type comment above.
      email_unsubscribed: !!pref?.email_unsubscribed,
      email_suppressed: !!pref?.email_suppressed,
      sms_status: (pref?.sms_status as SmsStatus | undefined) ?? "unknown",
    };
  });
}

async function resolveCategoryIds(client: SupabaseClient, orgId: string, category: ContactCategory): Promise<Set<string>> {
  if (category === "lead") {
    const { data } = await client.from("leads").select("contact_id").eq("org_id", orgId).not("contact_id", "is", null);
    return new Set((data ?? []).map((r: any) => r.contact_id).filter(Boolean));
  }
  if (category === "customer") {
    const { data } = await client
      .from("projects")
      .select("client_id")
      .eq("org_id", orgId)
      .not("status", "in", "(completed,cancelled)")
      .not("client_id", "is", null);
    return new Set((data ?? []).map((r: any) => r.client_id).filter(Boolean));
  }
  // past_customer
  const { data } = await client
    .from("projects")
    .select("client_id")
    .eq("org_id", orgId)
    .eq("status", "completed")
    .not("client_id", "is", null);
  return new Set((data ?? []).map((r: any) => r.client_id).filter(Boolean));
}

export type ChannelEligibility = {
  eligible: AudienceContact[];
  excluded: { contact: AudienceContact; reason: string }[];
};

/**
 * Splits resolved audience contacts into eligible/excluded for a given send
 * channel — the server-authoritative check every send path must run before
 * dispatching.
 *
 * SMS is FAIL CLOSED: only sms_status === 'eligible' is ever included. A
 * contact who has never had eligibility explicitly recorded ('unknown') is
 * excluded exactly like an opted-out one — "no recorded opt-out" is not
 * the same thing as "known eligible for marketing SMS" (Phase 14.1
 * hardening review, item 2). Email keeps its opt-out model: eligible
 * unless explicitly unsubscribed/suppressed.
 */
export function splitByChannelEligibility(contacts: AudienceContact[], channel: "email" | "sms"): ChannelEligibility {
  const eligible: AudienceContact[] = [];
  const excluded: { contact: AudienceContact; reason: string }[] = [];
  for (const c of contacts) {
    if (channel === "email") {
      if (!c.email) excluded.push({ contact: c, reason: "Missing email" });
      else if (c.email_unsubscribed) excluded.push({ contact: c, reason: "Unsubscribed" });
      else if (c.email_suppressed) excluded.push({ contact: c, reason: "Suppressed" });
      else eligible.push(c);
    } else {
      if (!c.phone) excluded.push({ contact: c, reason: "Missing phone" });
      else if (c.sms_status === "opted_out") excluded.push({ contact: c, reason: "SMS opted out" });
      else if (c.sms_status === "suppressed") excluded.push({ contact: c, reason: "SMS suppressed" });
      else if (c.sms_status === "unknown") excluded.push({ contact: c, reason: "SMS eligibility not established" });
      else eligible.push(c);
    }
  }
  return { eligible, excluded };
}
