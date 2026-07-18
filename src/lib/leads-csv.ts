import type { Lead, LeadSource, LeadStatus, LeadScore } from "@/lib/mock-data";

const CSV_HEADERS = [
  "name", "email", "phone", "address", "source", "status", "score",
  "projectType", "estimatedBudget", "notes", "owner",
] as const;

const VALID_SOURCES: LeadSource[] = ["Website", "Referral", "Angi", "Thumbtack", "Google Ads", "Walk-in", "Social Media"];
const VALID_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];
const VALID_SCORES: LeadScore[] = ["hot", "warm", "cold"];

function escapeCSV(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function leadsToCSV(leads: Lead[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = leads.map((l) =>
    CSV_HEADERS.map((h) => {
      const val = h === "estimatedBudget" ? String(l[h]) : (l[h as keyof Lead] as string) ?? "";
      return escapeCSV(val);
    }).join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { result.push(current.trim()); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
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
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], preview: [], totalRows: 0 };
  const headers = parseCSVLine(lines[0]);
  const dataLines = lines.slice(1);
  const preview = dataLines.slice(0, 3).map(parseCSVLine);
  return { headers, preview, totalRows: dataLines.length };
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

/** Convert parsed CSV rows using the user-defined column mapping */
export function applyMappingToLeads(csv: string, mapping: ColumnMapping): { leads: Omit<Lead, "id">[]; errors: string[] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { leads: [], errors: ["CSV must have a header row and at least one data row."] };

  if (mapping.name < 0) return { leads: [], errors: ["You must map the Name field."] };

  const errors: string[] = [];
  const parsed: Omit<Lead, "id">[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const get = (key: LeadFieldKey) => {
      const idx = mapping[key];
      return idx >= 0 ? (cols[idx]?.trim() ?? "") : "";
    };

    const name = get("name");
    if (!name) { errors.push(`Row ${i + 1}: missing name, skipped.`); continue; }

    const rawSource = get("source");
    const source = (VALID_SOURCES.includes(rawSource as LeadSource) ? rawSource : "Website") as LeadSource;
    const rawStatus = get("status");
    const status = (VALID_STATUSES.includes(rawStatus as LeadStatus) ? rawStatus : "new") as LeadStatus;
    const rawScore = get("score");
    const score = (VALID_SCORES.includes(rawScore as LeadScore) ? rawScore : "warm") as LeadScore;
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
      estimatedBudget: Number(get("estimatedBudget")) || 0,
      notes: get("notes"),
      owner,
      ownerInitials: owner.split(" ").map((p) => p[0]).join(""),
      createdAt: now,
      lastActivity: now,
    });
  }

  return { leads: parsed, errors };
}