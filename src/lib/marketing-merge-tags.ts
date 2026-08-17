// src/lib/marketing-merge-tags.ts
//
// Single, shared merge-tag renderer for Phase 14.1 Campaigns — used by
// BOTH the Create Campaign preview (src/routes/marketing.tsx, sample
// data) and the real send worker
// (netlify/functions/marketing-campaign-process-queue.ts, real recipient/
// org data). One implementation, so the preview a user sees can never
// diverge from what a real send actually substitutes.
//
// Supported tags: {{first_name}}, {{last_name}}, {{company_name}} — kept
// intentionally minimal (see marketing.tsx's MERGE_TAGS constant, the
// only tags exposed as insertable buttons in the composer).

export type MergeTagContext = Record<string, string>;

export function renderMergeTags(text: string, ctx: MergeTagContext): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key: string) => ctx[key] ?? full);
}

// campaign_recipients.contact_name (and contacts.full_name it was
// snapshotted from) is a single free-text field, not separate first/last
// columns — split it the same simple way for both preview parity and
// real sends: first whitespace-delimited token is the first name, the
// rest (if any) is the last name.
export function splitFullName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
