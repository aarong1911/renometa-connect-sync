import type { Lead, LeadSource, LeadStatus, LeadScore } from "@/lib/mock-data";
import { escapeCSV, parseCSVLine, splitCSVLines, downloadCSV, parseCSVPreview as sharedParseCSVPreview } from "@/lib/csv-utils";
import { leadStatusLabel } from "@/lib/lead-status";
import { leadSourceLabel, normalizeLeadSource } from "@/lib/lead-source";

export { downloadCSV };

const CSV_HEADERS = [
  "name", "email", "phone", "address", "source", "status", "score",
  "projectType", "estimatedBudget", "notes", "owner",
] as const;

// Lead Source Catalog Refinement — canonical machine values, matching
// ADD_LEAD_SOURCE_OPTIONS in routes/leads.tsx exactly (the same 9
// built-in sources the manual Add/Edit Lead form offers). A CSV source
// value is checked against this list AFTER normalizeLeadSource() so any
// case/spacing/legacy variant of a recognized source (e.g. "GOOGLE ADS",
// "google ads", "Website", "website form") is correctly recognized
// instead of being defaulted to "website_form" just because its casing
// didn't exactly match — see applyMappingToLeads() below. This does not
// change the product behavior for genuinely unrecognized values (e.g.
// legacy "Angi"/"Referral"/"Advertising" rows imported fresh), which
// still default to "website_form" exactly as before this pass (the
// importer does not currently accept arbitrary custom source text).
const VALID_SOURCES: LeadSource[] = ["google_ads", "meta_ads", "google_lsa", "website_form", "chatbot", "voice_ai", "phone_call", "sms", "email"];
const VALID_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];
const VALID_SCORES: LeadScore[] = ["hot", "warm", "cold"];

/**
 * `resolveOwnerName`, if supplied, exports the live team-member display
 * name resolved from Lead.assignedTo (Priority 10) instead of the legacy
 * cached owner text, which can go stale after a rename. Status/source are
 * always exported as readable labels, never internal codes/ids.
 */
export function leadsToCSV(leads: Lead[], resolveOwnerName?: (lead: Lead) => string): string {
  const header = CSV_HEADERS.join(",");
  const rows = leads.map((l) =>
    CSV_HEADERS.map((h) => {
      let val: string;
      if (h === "estimatedBudget") val = String(l[h]);
      else if (h === "status") val = leadStatusLabel(l.status);
      else if (h === "source") val = leadSourceLabel(l.source);
      else if (h === "owner") val = resolveOwnerName ? resolveOwnerName(l) : ((l.owner && l.owner !== "—") ? l.owner : "Unassigned");
      else val = (l[h as keyof Lead] as string) ?? "";
      return escapeCSV(val);
    }).join(","),
  );
  return [header, ...rows].join("\n");
}

// Lead fields available for mapping
export const LEAD_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Address" },
  { key: "source", label: "Source" },
  { key: "status", label: "Status" },
  { key: "score", label: "Score" },
  { key: "projectType", label: "Project Type" },
  { key: "estimatedBudget", label: "Est. Budget" },
  { key: "notes", label: "Notes" },
  { key: "owner", label: "Owner" },
] as const;

export type LeadFieldKey = (typeof LEAD_FIELDS)[number]["key"];

/** Mapping from lead field key → CSV column index (-1 = skip) */
export type ColumnMapping = Record<LeadFieldKey, number>;

/** Parse raw CSV text and return headers + first few preview rows */
export function parseCSVPreview(csv: string): { headers: string[]; preview: string[][]; totalRows: number } {
  return sharedParseCSVPreview(csv);
}

/** Auto-guess mapping from CSV headers to lead fields */
export type TemplateType = "lead" | "customer" | "job";

const TEMPLATE_ALIASES: Record<TemplateType, Record<LeadFieldKey, string[]>> = {
  lead: {
    name: ["name", "full name", "contact name", "lead name", "client"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "telephone", "phone number", "tel", "mobile"],
    address: ["address", "street", "location", "street address"],
    source: ["source", "lead source", "channel", "origin"],
    status: ["status", "lead status", "stage"],
    score: ["score", "lead score", "priority", "temperature"],
    projectType: ["project type", "projecttype", "project", "type", "service"],
    estimatedBudget: ["estimated budget", "estimatedbudget", "budget", "value", "amount"],
    notes: ["notes", "note", "comments", "description"],
    owner: ["owner", "assigned to", "assignee", "rep", "salesperson"],
  },
  customer: {
    name: ["name", "full name", "customer name", "client name", "contact name", "client"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "telephone", "phone number", "tel", "mobile"],
    address: ["address", "street", "location", "street address"],
    source: ["source", "channel", "company", "account number"],
    status: ["status", "account status"],
    score: ["score", "tier", "priority"],
    projectType: ["project type", "projecttype", "service", "type"],
    estimatedBudget: ["budget", "value", "amount", "account number"],
    notes: ["notes", "note", "comments", "description"],
    owner: ["owner", "assigned to", "account manager", "rep"],
  },
  job: {
    name: ["job name", "job", "title", "name", "project name"],
    email: ["email", "client email"],
    phone: ["phone", "client phone"],
    address: ["address", "job address", "site", "location", "street address"],
    source: ["source", "client", "customer"],
    status: ["status", "job status", "stage"],
    score: ["score", "priority"],
    projectType: ["project type", "type", "service", "category"],
    estimatedBudget: ["budget", "estimated budget", "value", "amount", "cost"],
    notes: ["notes", "note", "comments", "description"],
    owner: ["owner", "assigned to", "foreman", "crew lead"],
  },
};

export function autoMapHeaders(csvHeaders: string[], templateType: TemplateType = "lead"): ColumnMapping {
  const mapping: ColumnMapping = {
    name: -1, email: -1, phone: -1, address: -1, source: -1,
    status: -1, score: -1, projectType: -1, estimatedBudget: -1, notes: -1, owner: -1,
  };
  const aliases = TEMPLATE_ALIASES[templateType];
  const lower = csvHeaders.map((h) => h.toLowerCase().trim());
  for (const field of LEAD_FIELDS) {
    const fieldAliases = aliases[field.key];
    const idx = lower.findIndex((h) => fieldAliases.includes(h));
    if (idx >= 0) mapping[field.key] = idx;
  }
  return mapping;
}

/**
 * Convert parsed CSV rows using the user-defined column mapping. Invalid
 * source/status/score values are coerced to a safe default (never fail the
 * whole row over a cosmetic field) but ARE now reported as row+field errors
 * (Priority 4) instead of being silently swallowed as before this pass.
 */
export function applyMappingToLeads(csv: string, mapping: ColumnMapping): { leads: Omit<Lead, "id">[]; errors: string[] } {
  const lines = splitCSVLines(csv);
  if (lines.length < 2) return { leads: [], errors: ["CSV must have a header row and at least one data row."] };

  if (mapping.name < 0) return { leads: [], errors: ["You must map the Name field."] };

  const errors: string[] = [];
  const parsed: Omit<Lead, "id">[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // header is row 1
    const cols = parseCSVLine(lines[i]);
    const get = (key: LeadFieldKey) => {
      const idx = mapping[key];
      return idx >= 0 ? (cols[idx]?.trim() ?? "") : "";
    };

    const name = get("name");
    if (!name) { errors.push(`Row ${rowNum}: name — missing, skipped.`); continue; }

    const rawSource = get("source");
    const normalizedSource = normalizeLeadSource(rawSource);
    const source = (VALID_SOURCES.includes(normalizedSource as LeadSource) ? normalizedSource : "website_form") as LeadSource;
    if (rawSource && source !== normalizedSource) errors.push(`Row ${rowNum}: source — "${rawSource}" not recognized, defaulted to "Website Form".`);

    const rawStatus = get("status");
    const status = (VALID_STATUSES.includes(rawStatus as LeadStatus) ? rawStatus : "new") as LeadStatus;
    if (rawStatus && status !== rawStatus) errors.push(`Row ${rowNum}: status — "${rawStatus}" not recognized, defaulted to "new".`);

    const rawScore = get("score");
    const score = (VALID_SCORES.includes(rawScore as LeadScore) ? rawScore : "warm") as LeadScore;
    if (rawScore && score !== rawScore) errors.push(`Row ${rowNum}: score — "${rawScore}" not recognized, defaulted to "warm".`);

    const rawBudget = get("estimatedBudget");
    const estimatedBudget = Number(rawBudget.replace(/[^0-9.-]/g, "")) || 0;
    if (rawBudget && !Number.isFinite(Number(rawBudget.replace(/[^0-9.-]/g, "")))) {
      errors.push(`Row ${rowNum}: estimatedBudget — "${rawBudget}" is not numeric, defaulted to 0.`);
    }

    const owner = get("owner") || "Unassigned";

    parsed.push({
      name,
      email: get("email"),
      phone: get("phone"),
      address: get("address"),
      source,
      status,
      score,
      projectType: get("projectType") || "Kitchen Remodel",
      estimatedBudget,
      notes: get("notes"),
      owner,
      ownerInitials: owner.split(" ").map((p) => p[0]).join(""),
      createdAt: now,
      lastActivity: now,
    });
  }

  return { leads: parsed, errors };
}
