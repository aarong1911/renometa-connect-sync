import type { Contact } from "@/lib/mock-data";

const CSV_HEADERS = [
  "name", "email", "phone", "company", "tags", "owner",
] as const;

function escapeCSV(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function contactsToCSV(contacts: Contact[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = contacts.map((c) =>
    CSV_HEADERS.map((h) => {
      const val = h === "tags" ? c.tags.join("; ") : (c[h as keyof Contact] as string) ?? "";
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

export const CONTACT_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
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
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], preview: [], totalRows: 0 };
  const headers = parseCSVLine(lines[0]);
  const dataLines = lines.slice(1);
  const preview = dataLines.slice(0, 3).map(parseCSVLine);
  return { headers, preview, totalRows: dataLines.length };
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
      // Whichever appears first gets a stronger weight (1.0 vs 0.5)
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

export function applyMappingToContacts(csv: string, mapping: ContactColumnMapping, tagDelimiter: TagDelimiter = "both"): { contacts: Omit<Contact, "id">[]; errors: string[] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
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
  const parsed: Omit<Contact, "id">[] = [];
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const get = (key: ContactFieldKey) => {
      const idx = mapping[key];
      return idx >= 0 ? (cols[idx]?.trim() ?? "") : "";
    };

    const name = get("name");
    if (!name) { errors.push(`Row ${i + 1}: missing name, skipped.`); continue; }

    const rawTags = get("tags");
    const tags = splitTags(rawTags, resolvedDelimiter);
    const owner = get("owner") || "Unassigned";

    parsed.push({
      name,
      email: get("email"),
      phone: get("phone"),
      company: get("company"),
      tags,
      owner,
      createdAt: now,
      lastActivity: now,
    });
  }

  return { contacts: parsed, errors };
}