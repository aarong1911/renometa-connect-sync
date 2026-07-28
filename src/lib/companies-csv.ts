// src/lib/companies-csv.ts
//
// Stage 9.5, Priority 12 — Company import/export, new capability, built on
// the same shared csv-utils foundation as leads-csv.ts/contacts-csv.ts
// (Priority 1). Companies previously had NO import capability at all
// (confirmed in Phase 9.4's audit).
//
// Canonical fields only (Priority 2): no arbitrary column passthrough, no
// org_id/id/created_at/updated_at/slug from CSV — slug is always generated
// server-side via companies-store's createUniqueCompanySlug. owner_name is
// legacy free text (no owner UUID column exists on companies — confirmed
// live in Phase 9.4) so it's taken as-is, not resolved against team members.

import { escapeCSV, parseCSVLine, splitCSVLines, downloadCSV, parseCSVPreview as sharedParseCSVPreview } from "@/lib/csv-utils";
import { normalizeTags } from "@/lib/tag-utils";
import type { Company } from "@/lib/companies-store";

export { downloadCSV };

const VALID_ACCOUNT_TYPES = ["Prospect", "Customer", "Vendor", "Partner"];
const VALID_STATUSES = ["Active", "Inactive"];

const CSV_HEADERS = [
  "name", "email", "phone", "website", "industry", "address", "city", "state",
  "zip", "country", "accountType", "status", "ownerName", "tags", "notes",
] as const;

export function companiesToCSV(companies: Company[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = companies.map((c) =>
    CSV_HEADERS.map((h) => {
      let val = "";
      switch (h) {
        case "accountType": val = c.account_type ?? ""; break;
        case "ownerName": val = c.owner_name ?? ""; break;
        case "tags": val = (c.tags ?? []).join("; "); break;
        default: val = (c[h as keyof Company] as string) ?? "";
      }
      return escapeCSV(val);
    }).join(","),
  );
  return [header, ...rows].join("\n");
}

export const COMPANY_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "website", label: "Website" },
  { key: "industry", label: "Industry" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "country", label: "Country" },
  { key: "accountType", label: "Account Type" },
  { key: "status", label: "Status" },
  { key: "ownerName", label: "Owner" },
  { key: "tags", label: "Tags" },
  { key: "notes", label: "Notes" },
] as const;

export type CompanyFieldKey = (typeof COMPANY_FIELDS)[number]["key"];
export type CompanyColumnMapping = Record<CompanyFieldKey, number>;

const TEMPLATE_ALIASES: Record<CompanyFieldKey, string[]> = {
  name: ["name", "company", "company name", "account", "account name", "business"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "telephone", "phone number", "tel"],
  website: ["website", "url", "domain", "site"],
  industry: ["industry", "sector", "category"],
  address: ["address", "street", "street address"],
  city: ["city"],
  state: ["state", "province"],
  zip: ["zip", "zip code", "postal code", "postcode"],
  country: ["country"],
  accountType: ["account type", "type", "accounttype"],
  status: ["status", "account status"],
  ownerName: ["owner", "owner name", "assigned to", "account manager", "rep"],
  tags: ["tags", "tag", "labels", "categories"],
  notes: ["notes", "note", "comments", "description"],
};

export function parseCSVPreview(csv: string): { headers: string[]; preview: string[][]; totalRows: number } {
  return sharedParseCSVPreview(csv);
}

export function autoMapHeaders(csvHeaders: string[]): CompanyColumnMapping {
  const mapping = Object.fromEntries(COMPANY_FIELDS.map((f) => [f.key, -1])) as CompanyColumnMapping;
  const lower = csvHeaders.map((h) => h.toLowerCase().trim());
  for (const field of COMPANY_FIELDS) {
    const idx = lower.findIndex((h) => TEMPLATE_ALIASES[field.key].includes(h));
    if (idx >= 0) mapping[field.key] = idx;
  }
  return mapping;
}

export type ParsedCompanyRow = {
  name: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  account_type: string;
  status: string;
  owner_name: string;
  tags: string[];
  notes: string;
};

/**
 * Validates and parses Company CSV rows. Unlike leads/contacts, an invalid
 * accountType/status is a real field-level error (not silently coerced)
 * because these two directly gate visible list filters — reported per row
 * per Priority 4, defaulted to a safe value so the row still imports.
 */
export function applyMappingToCompanies(csv: string, mapping: CompanyColumnMapping): { companies: ParsedCompanyRow[]; errors: string[] } {
  const lines = splitCSVLines(csv);
  if (lines.length < 2) return { companies: [], errors: ["CSV must have a header row and at least one data row."] };
  if (mapping.name < 0) return { companies: [], errors: ["You must map the Name field."] };

  const errors: string[] = [];
  const parsed: ParsedCompanyRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = parseCSVLine(lines[i]);
    const get = (key: CompanyFieldKey) => {
      const idx = mapping[key];
      return idx >= 0 ? (cols[idx]?.trim() ?? "") : "";
    };

    const name = get("name");
    if (!name) { errors.push(`Row ${rowNum}: name — missing, skipped.`); continue; }

    const rawType = get("accountType");
    const account_type = rawType && VALID_ACCOUNT_TYPES.includes(rawType) ? rawType : "Prospect";
    if (rawType && account_type !== rawType) errors.push(`Row ${rowNum}: accountType — "${rawType}" not recognized, defaulted to "Prospect".`);

    const rawStatus = get("status");
    const status = rawStatus && VALID_STATUSES.includes(rawStatus) ? rawStatus : "Active";
    if (rawStatus && status !== rawStatus) errors.push(`Row ${rowNum}: status — "${rawStatus}" not recognized, defaulted to "Active".`);

    const email = get("email");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      errors.push(`Row ${rowNum}: email — "${email}" does not look like a valid email, kept as-is.`);
    }

    parsed.push({
      name,
      email,
      phone: get("phone"),
      website: get("website"),
      industry: get("industry"),
      address: get("address"),
      city: get("city"),
      state: get("state"),
      zip: get("zip"),
      country: get("country"),
      account_type,
      status,
      owner_name: get("ownerName"),
      tags: normalizeTags(get("tags").split(/[;,]+/)),
      notes: get("notes"),
    });
  }

  return { companies: parsed, errors };
}
