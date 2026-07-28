import type { Contact } from "@/lib/mock-data";
import { normalizeTags } from "@/lib/tag-utils";
import { escapeCSV, parseCSVLine, splitCSVLines, downloadCSV, parseCSVPreview as sharedParseCSVPreview } from "@/lib/csv-utils";

export { downloadCSV };

const CSV_HEADERS = ["name", "email", "phone", "company", "tags", "owner"] as const;

export function contactsToCSV(contacts: Contact[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = contacts.map((c) =>
    CSV_HEADERS.map((h) => {
      const val = h === "tags"
        ? c.tags.join("; ")
        : h === "company"
          ? (c.companyName || c.company || "")
          : (c[h as keyof Contact] as string) ?? "";
      return escapeCSV(val);
    }).join(","),
  );
  return [header, ...rows].join("\n");
}

export const CONTACT_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  // Display label only — Contacts UX pass renamed "Company" to "Account" in
  // user-facing text. The field `key` stays "company" (matches
  // Contact.company / ParsedContactRow) since this is a UI wording change
  // only, not a data-model rename.
  { key: "company", label: "Account" },
  { key: "tags", label: "Tags" },
  { key: "owner", label: "Owner" },
] as const;

export type ContactFieldKey = (typeof CONTACT_FIELDS)[number]["key"];
export type ContactColumnMapping = Record<ContactFieldKey, number>;

export type ContactTemplateType = "contact" | "customer" | "vendor";

const TEMPLATE_ALIASES: Record<ContactTemplateType, Record<ContactFieldKey, string[]>> = {
  contact: {
    name: ["name", "full name", "contact name", "client"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "telephone", "phone number", "tel", "mobile"],
    company: ["company", "organization", "org", "business", "firm"],
    tags: ["tags", "tag", "labels", "categories", "type"],
    owner: ["owner", "assigned to", "assignee", "rep"],
  },
  customer: {
    name: ["name", "full name", "customer name", "client name"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "telephone", "phone number", "tel", "mobile"],
    company: ["company", "account", "organization", "business"],
    tags: ["tags", "tier", "segment", "type", "labels"],
    owner: ["owner", "account manager", "rep", "assigned to"],
  },
  vendor: {
    name: ["name", "vendor name", "supplier", "contact name"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "telephone", "phone number", "tel", "mobile"],
    company: ["company", "vendor", "supplier", "business", "firm"],
    tags: ["tags", "trade", "specialty", "category", "type"],
    owner: ["owner", "managed by", "rep", "assigned to"],
  },
};

export function parseCSVPreview(csv: string): { headers: string[]; preview: string[][]; totalRows: number } {
  return sharedParseCSVPreview(csv);
}

export function autoMapHeaders(csvHeaders: string[], templateType: ContactTemplateType = "contact"): ContactColumnMapping {
  const mapping: ContactColumnMapping = {
    name: -1, email: -1, phone: -1, company: -1, tags: -1, owner: -1,
  };
  const aliases = TEMPLATE_ALIASES[templateType];
  const lower = csvHeaders.map((h) => h.toLowerCase().trim());
  for (const field of CONTACT_FIELDS) {
    const fieldAliases = aliases[field.key];
    const idx = lower.findIndex((h) => fieldAliases.includes(h));
    if (idx >= 0) mapping[field.key] = idx;
  }
  return mapping;
}

export type TagDelimiter = "auto" | "comma" | "semicolon" | "both";

export interface DelimiterDetectionResult {
  delimiter: Exclude<TagDelimiter, "auto">;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Analyze tag column values and pick the best delimiter.
 * Samples up to 50 rows and weights by which delimiter appears first in each value,
 * giving a more reliable signal than simple occurrence counting.
 */
export function detectTagDelimiterWithConfidence(values: string[]): DelimiterDetectionResult {
  const sample = values.filter(Boolean).slice(0, 50);
  if (sample.length === 0) return { delimiter: "comma", confidence: "low", reason: "No tag data found — defaulting to comma" };

  let commaScore = 0;
  let semicolonScore = 0;

  for (const v of sample) {
    const ci = v.indexOf(",");
    const si = v.indexOf(";");
    const hasComma = ci >= 0;
    const hasSemicolon = si >= 0;

    if (hasComma && hasSemicolon) {
      if (ci < si) { commaScore += 1; semicolonScore += 0.5; }
      else { semicolonScore += 1; commaScore += 0.5; }
    } else if (hasComma) {
      commaScore += 1;
    } else if (hasSemicolon) {
      semicolonScore += 1;
    }
  }

  const total = commaScore + semicolonScore;
  const sampled = sample.length;
  void total;

  if (commaScore > 0 && semicolonScore === 0) {
    return { delimiter: "comma", confidence: sampled >= 3 ? "high" : "medium", reason: `Comma found in ${Math.round(commaScore)}/${sampled} rows, no semicolons` };
  }
  if (semicolonScore > 0 && commaScore === 0) {
    return { delimiter: "semicolon", confidence: sampled >= 3 ? "high" : "medium", reason: `Semicolon found in ${Math.round(semicolonScore)}/${sampled} rows, no commas` };
  }
  if (commaScore > 0 && semicolonScore > 0) {
    if (commaScore > semicolonScore * 2) {
      return { delimiter: "comma", confidence: "medium", reason: `Comma dominant (${commaScore.toFixed(1)} vs ${semicolonScore.toFixed(1)} score across ${sampled} rows)` };
    }
    if (semicolonScore > commaScore * 2) {
      return { delimiter: "semicolon", confidence: "medium", reason: `Semicolon dominant (${semicolonScore.toFixed(1)} vs ${commaScore.toFixed(1)} score across ${sampled} rows)` };
    }
    return { delimiter: "both", confidence: "medium", reason: `Both delimiters used (scores: comma ${commaScore.toFixed(1)}, semicolon ${semicolonScore.toFixed(1)} across ${sampled} rows)` };
  }
  return { delimiter: "comma", confidence: "low", reason: "No delimiters found — defaulting to comma" };
}

/** Simple wrapper that returns just the delimiter for backward compat. */
export function detectTagDelimiter(values: string[]): Exclude<TagDelimiter, "auto"> {
  return detectTagDelimiterWithConfidence(values).delimiter;
}

export function splitTags(raw: string, delimiter: TagDelimiter): string[] {
  if (!raw) return [];
  const effective = delimiter === "auto" ? "both" : delimiter;
  const pattern = effective === "comma" ? /,/ : effective === "semicolon" ? /;/ : /[;,]/;
  return raw.split(pattern).map((t) => t.trim()).filter(Boolean);
}

/**
 * Exact-match company resolution for Contact CSV import (Priority 13):
 * matches a CSV "company" cell against a same-org company's name (or, if
 * given, slug/website domain) — case-insensitive, whitespace-normalized,
 * EXACT only. No fuzzy matching, no cross-org lookup (the caller must only
 * pass companies already scoped to the current org). Returns null and lets
 * the caller report "unresolved" on no-match or ambiguous match; never
 * silently guesses and never creates a company implicitly.
 */
export function resolveCompanyByName(
  raw: string,
  companies: { id: string; name: string }[],
): { id: string; name: string } | "ambiguous" | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  const matches = companies.filter((c) => c.name.trim().toLowerCase() === needle);
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

export type ParsedContactRow = Omit<Contact, "id"> & {
  /** Set only on an exact, unambiguous same-org company-name match (Priority 13). */
  companyResolution?: "matched" | "ambiguous" | "none" | "not-mapped";
};

/**
 * `companies`, if supplied, enables Contact→Company resolution (Priority
 * 13): an exact name match sets company_id and clears the legacy free-text
 * company field; an ambiguous or missing match imports the contact
 * unassigned with company left as free text, and is reported via
 * companyResolution so the caller's import summary can show an
 * unresolved-company count. Omitting `companies` preserves old behavior
 * (legacy free-text company only).
 */
export function applyMappingToContacts(
  csv: string,
  mapping: ContactColumnMapping,
  tagDelimiter: TagDelimiter = "both",
  companies?: { id: string; name: string }[],
): { contacts: ParsedContactRow[]; errors: string[] } {
  const lines = splitCSVLines(csv);
  if (lines.length < 2) return { contacts: [], errors: ["CSV must have a header row and at least one data row."] };
  if (mapping.name < 0) return { contacts: [], errors: ["You must map the Name field."] };

  // Resolve auto-detect by scanning all tag values
  let resolvedDelimiter: Exclude<TagDelimiter, "auto"> = tagDelimiter === "auto" ? "both" : tagDelimiter;
  if (tagDelimiter === "auto" && mapping.tags >= 0) {
    const tagSamples = lines.slice(1).map((l) => {
      const cols = parseCSVLine(l);
      return cols[mapping.tags]?.trim() ?? "";
    }).filter(Boolean);
    resolvedDelimiter = detectTagDelimiter(tagSamples);
  }

  const errors: string[] = [];
  const parsed: ParsedContactRow[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = parseCSVLine(lines[i]);
    const get = (key: ContactFieldKey) => {
      const idx = mapping[key];
      return idx >= 0 ? (cols[idx]?.trim() ?? "") : "";
    };

    const name = get("name");
    if (!name) { errors.push(`Row ${rowNum}: name — missing, skipped.`); continue; }

    const rawTags = get("tags");
    const tags = normalizeTags(splitTags(rawTags, resolvedDelimiter));
    const owner = get("owner") || "Unassigned";
    const rawCompany = get("company");

    let company_id: string | null = null;
    let companyResolution: ParsedContactRow["companyResolution"] = "not-mapped";
    let companyText = rawCompany;

    if (mapping.company >= 0) {
      if (!rawCompany) {
        companyResolution = "none";
      } else if (companies) {
        const match = resolveCompanyByName(rawCompany, companies);
        if (match === "ambiguous") {
          companyResolution = "ambiguous";
          errors.push(`Row ${rowNum}: company — "${rawCompany}" matched more than one account, imported unassigned.`);
        } else if (match) {
          companyResolution = "matched";
          company_id = match.id;
          companyText = "";
        } else {
          companyResolution = "none";
        }
      } else {
        companyResolution = "none";
      }
    }

    parsed.push({
      name,
      email: get("email"),
      phone: get("phone"),
      company: companyText,
      company_id,
      companyName: null,
      tags,
      owner,
      createdAt: now,
      lastActivity: now,
      companyResolution,
    } as ParsedContactRow);
  }

  return { contacts: parsed, errors };
}
