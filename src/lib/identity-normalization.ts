// src/lib/identity-normalization.ts
//
// Phase 9.1 — single shared source of truth for "is this the same
// person" checks used by contact-creation paths (manual New Contact,
// Gmail sender → contact, and later CSV import). Before this file existed,
// each creation path had its own ad hoc dedupe logic (or none at all —
// see the Phase 9 audit): manual contact creation had no check,
// convert-lead-dialog.tsx queried contacts by a raw last-10-digit phone
// string that never actually matches this app's stored phone format (see
// normalizePhoneForComparison below), and Gmail contact creation checked
// email only inside its own file. This module consolidates the matching
// rules so every caller applies the same organization-scoped logic.
//
// normalizeEmail is intentionally NOT reimplemented here — it already has
// exactly one canonical implementation in gmail-conversations.ts (Phase 7,
// not modified by this pass), so this module re-exports that one instead
// of creating a second copy.

import { supabase } from "@/lib/supabase";
import { normalizeEmail } from "@/lib/gmail-conversations";

export { normalizeEmail };

/**
 * Comparison-safe (NOT storage) phone normalization: strips all formatting
 * characters and, for an 11-digit number beginning with the US/Canada
 * country code "1", drops that leading digit so "+1 (555) 123-4567" and
 * "555-123-4567" compare equal. This mirrors the same US-centric heuristic
 * already used in voice-conversations.ts's private normalizePhone — it is
 * NOT full E.164 validation. A genuinely different country's number that
 * happens to be 11 digits and starts with "1" would be mis-trimmed by this
 * heuristic. Documented as a known limit, not fixed in this pass.
 */
export function normalizePhoneForComparison(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * This codebase does not store phone numbers in one consistent format —
 * confirmed via the Phase 9 audit: manual/CSV contact creation stores
 * whatever formatPhone() (src/lib/format.ts) produces, e.g.
 * "(555) 123-4567", while netlify/functions/meta-webhook.ts stores E.164
 * ("+15551234567"). A plain `.eq("phone", normalizedDigits)` query (the
 * pattern convert-lead-dialog.tsx currently uses) will silently never match
 * anything, because neither stored format is bare digits. Rather than an
 * unbounded full-table scan + client-side normalization compare (a real
 * performance risk flagged in the Phase 9 audit), this generates the small,
 * bounded set of concrete stored-string variants a 10-digit US number could
 * plausibly appear as today, so a single indexed `.in("phone", ...)` query
 * can catch the two known real formats. A phone stored in some other exotic
 * format is a known, documented gap — not silently "fixed" with a full scan.
 */
function phoneStorageVariants(normalized: string): string[] {
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  if (normalized.length === 10) {
    const p1 = normalized.slice(0, 3);
    const p2 = normalized.slice(3, 6);
    const p3 = normalized.slice(6, 10);
    variants.add(`(${p1}) ${p2}-${p3}`); // formatPhone() output
    variants.add(`+1${normalized}`); // E.164 (meta-webhook.ts)
    variants.add(`1${normalized}`);
  }
  return [...variants];
}

export type ContactDuplicateCandidate = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  matchedOn: "email" | "phone";
};

/**
 * Organization-scoped duplicate-contact lookup. Checks normalized email
 * first (strongest signal), then normalized/variant-matched phone. Never
 * merges or blocks anything itself — always returns candidates for the
 * caller to surface for manual review, per the Phase 9 matching-priority
 * rule: exact email > exact phone > never auto-merge on name alone.
 *
 * `excludeContactId` lets a caller editing an existing contact search for
 * OTHER contacts that now collide with its edited email/phone, without the
 * contact always matching itself.
 */
export async function findDuplicateContactCandidates(
  orgId: string,
  input: { email?: string | null; phone?: string | null },
  excludeContactId?: string,
): Promise<ContactDuplicateCandidate[]> {
  const candidates: ContactDuplicateCandidate[] = [];
  const seen = new Set<string>();

  const email = normalizeEmail(input.email);
  if (email) {
    let query = supabase
      .from("contacts")
      .select("id, full_name, email, phone, address")
      .eq("org_id", orgId)
      .ilike("email", email);
    if (excludeContactId) query = query.neq("id", excludeContactId);
    const { data, error } = await query;
    if (error) {
      console.error("[identity-normalization] email duplicate lookup failed:", error.message);
    }
    for (const row of data ?? []) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidates.push({ ...row, matchedOn: "email" });
      }
    }
  }

  const normalizedPhone = normalizePhoneForComparison(input.phone);
  const variants = phoneStorageVariants(normalizedPhone);
  if (variants.length > 0) {
    let query = supabase
      .from("contacts")
      .select("id, full_name, email, phone, address")
      .eq("org_id", orgId)
      .in("phone", variants);
    if (excludeContactId) query = query.neq("id", excludeContactId);
    const { data, error } = await query;
    if (error) {
      console.error("[identity-normalization] phone duplicate lookup failed:", error.message);
    }
    for (const row of data ?? []) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidates.push({ ...row, matchedOn: "phone" });
      }
    }
  }

  return candidates;
}
