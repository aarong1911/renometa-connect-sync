// src/lib/lead-status.ts
//
// Single shared source of truth for the 5 canonical lead statuses.
// Previously src/routes/leads.tsx defined its own STATUS_FILTERS/
// ALL_STATUSES/STATUS_LABELS/statusBadgeVariant inline — this consolidates
// that into one module so future lead UI (or CSV import/export) can't drift
// from it.
//
// `leads.status` has no database CHECK constraint (confirmed in the Phase 9
// audit) and a live read of every current row confirmed all 17 existing
// leads already use only canonical values ("new"/"contacted"/"qualified"/
// "lost" — no row currently holds anything outside this set). That's
// reassuring, but per the Phase 9.1 scope this pass still does NOT add a
// database constraint — only normalizes the application layer and leaves
// room for a legacy/unknown value to render safely rather than crash or be
// silently misrepresented as "New".

import type { LeadStatus } from "@/lib/mock-data";
export type { LeadStatus };

export const LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  lost: "Lost",
};

export type LeadStatusBadgeVariant = "default" | "secondary" | "outline" | "destructive";

export const LEAD_STATUS_BADGE_VARIANT: Record<LeadStatus, LeadStatusBadgeVariant> = {
  new: "default",
  contacted: "secondary",
  qualified: "outline",
  converted: "default",
  lost: "destructive",
};

function isKnownLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as string[]).includes(value);
}

/** Normalizes a raw status value (any casing/whitespace) for a NEW write — falls back to "new" only when genuinely empty, never for an unrecognized-but-present value (callers that need to preserve an unknown legacy value untouched should not run it through this). */
export function normalizeLeadStatusForWrite(raw: string | null | undefined): LeadStatus {
  const trimmed = (raw ?? "").trim().toLowerCase();
  return isKnownLeadStatus(trimmed) ? (trimmed as LeadStatus) : "new";
}

/** Display label for any raw status string. A known status gets its canonical label; an unrecognized legacy value is shown Title-Cased as-is rather than misrepresented as "New" — see file header. */
export function leadStatusLabel(status: string): string {
  const trimmed = status.trim().toLowerCase();
  if (isKnownLeadStatus(trimmed)) return LEAD_STATUS_LABELS[trimmed];
  return status.trim() ? status.trim().replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown";
}

/** Badge tone for any raw status string — unrecognized values get a neutral "outline" tone rather than defaulting to "new"'s tone. */
export function leadStatusBadgeVariant(status: string): LeadStatusBadgeVariant {
  const trimmed = status.trim().toLowerCase();
  return isKnownLeadStatus(trimmed) ? LEAD_STATUS_BADGE_VARIANT[trimmed] : "outline";
}
