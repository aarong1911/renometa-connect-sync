// netlify/functions/lib/invitation-lookup.ts
//
// Phones Pro S1 — server-side invitation lookup by token, replacing the browser's direct anon SELECT on the invitations table.
//
// WHY: the live invitations table has a PERMISSIVE PUBLIC SELECT policy "Anyone can look up invitation by token" with USING (true).
// A policy cannot see which token the request filtered on, so it let ANYONE holding the public anon key list EVERY invitation —
// emails, names, phone numbers, addresses, the stored ssn / ein, and the invitation TOKENS themselves. Since accept-invite.ts lets a
// token holder create an account with the invitation's email and role (admin included), a leaked token is account takeover and
// organization access. This lookup returns exactly one invitation, for a caller that presents its token, with MINIMAL fields.
//
// RESPONSE CONTRACT (no secret ever returned):
//   - never: id, organization_id, token, invited_by, ssn, ein, status internals
//   - tax fields are reduced to "last four" hints so the invitee can recognise what the administrator entered; the full values stay on
//     the server and accept-invite.ts uses them when the invitee leaves the field blank (see resolveAcceptedTaxFields).
//   - outcomes are limited to ok / invalid / used / expired.
// The token is a UUID (crypto.randomUUID() in invite-member.ts, 122 bits); malformed input never reaches the database.

import type { SupabaseClient } from "@supabase/supabase-js";

export const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicInvitation = {
  email: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
  primary_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  worker_type: string | null;
  company_name: string | null;
  /** "1234" — never the full number. */
  ssn_last4: string | null;
  ein_last4: string | null;
};

export type InvitationLookupResult =
  | { status: "ok"; invitation: PublicInvitation }
  | { status: "invalid" | "used" | "expired" };

const INVITATION_COLUMNS =
  "email, role, first_name, last_name, primary_phone, address_line1, address_line2, city, state, postal_code, worker_type, company_name, ssn, ein, status, expires_at";

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const last4 = (v: unknown): string | null => {
  const digits = typeof v === "string" ? v.replace(/\D/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export async function lookupInvitation(admin: SupabaseClient, token: unknown, now: () => Date = () => new Date()): Promise<InvitationLookupResult> {
  if (typeof token !== "string" || !INVITATION_TOKEN_PATTERN.test(token)) return { status: "invalid" };
  const { data, error } = await admin.from("invitations").select(INVITATION_COLUMNS).eq("token", token.toLowerCase()).maybeSingle();
  if (error || !data) return { status: "invalid" };
  const row = data as Record<string, unknown>;
  if (row.status !== "pending") return { status: "used" };
  if (new Date(String(row.expires_at)) < now()) return { status: "expired" };
  return {
    status: "ok",
    invitation: {
      email: String(row.email ?? ""),
      role: String(row.role ?? ""),
      first_name: text(row.first_name), last_name: text(row.last_name), primary_phone: text(row.primary_phone),
      address_line1: text(row.address_line1), address_line2: text(row.address_line2), city: text(row.city), state: text(row.state), postal_code: text(row.postal_code),
      worker_type: text(row.worker_type), company_name: text(row.company_name),
      ssn_last4: last4(row.ssn), ein_last4: last4(row.ein),
    },
  };
}

/**
 * What accept-invite stores for the tax fields. The invitee page no longer receives the administrator's full ssn / ein, so a BLANK
 * field means "use what the administrator entered" (this is exactly what the old pre-filled form submitted); a typed value wins.
 */
export function resolveAcceptedTaxFields(
  body: { ssn?: string; ein?: string; companyName?: string },
  invitation: { ssn?: unknown; ein?: unknown; company_name?: unknown },
): { ssn: string | null; ein: string | null; company_name: string | null } {
  const pick = (typed: string | undefined, stored: unknown): string | null => {
    const t = typeof typed === "string" ? typed.trim() : "";
    if (t) return t;
    return typeof stored === "string" && stored !== "" ? stored : null;
  };
  return { ssn: pick(body.ssn, invitation.ssn), ein: pick(body.ein, invitation.ein), company_name: pick(body.companyName, invitation.company_name) };
}
