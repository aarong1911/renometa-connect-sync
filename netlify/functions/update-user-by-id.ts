/// <reference types="node" />
// netlify/functions/update-user-by-id.ts
//
// Owner edits a member of their own organization (Team settings). Service-role writes, so every check runs BEFORE any write:
//   - the caller must be the owner of their organization (lib/member-authorization.ts, fail-closed);
//   - the target must have a membership in that organization, no membership in any other organization, and a profile in it —
//     profile and Auth data are per user, so editing someone who also belongs elsewhere would be a cross-tenant write;
//   - a role must be one of the supported roles and can never become 'owner';
//   - an owner can't be edited here, except the owner's own name/phone/address (their role and worker type are left as they are;
//     the Team dialog always re-sends the current role, so role 'owner' for the owner themselves is accepted as "unchanged");
//   - every write is scoped to this organization and must hit exactly one row.
// Any failed write returns an error, never { ok: true }. The writes are separate requests (not one transaction).
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { errorCode, membershipsOf, requireOrgOwner, respond } from "./lib/member-authorization";
import { isSupportedMemberRole } from "./lib/member-roles";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const WORKER_TYPES = ["employee", "subcontractor"];
const TEXT_FIELDS = ["targetUserId", "phone", "firstName", "lastName", "role", "workerType", "addressLine1", "addressLine2",
  "city", "state", "postalCode", "ssn", "ein", "companyName"] as const;

function toE164(raw: string): string | undefined {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length > 10) return `+${d}`;
  return undefined;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return respond(405, { error: "Method Not Allowed" });

  const caller = await requireOrgOwner(admin, event.headers.authorization);
  if (!caller.ok) return respond(caller.statusCode, { error: caller.error });
  const { orgId } = caller;

  let reqBody: Record<string, unknown>;
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return respond(400, { error: "Invalid JSON" }); }
  if (!reqBody || typeof reqBody !== "object" || Array.isArray(reqBody)) return respond(400, { error: "Invalid request" });
  for (const key of TEXT_FIELDS)
    if (reqBody[key] !== undefined && typeof reqBody[key] !== "string") return respond(400, { error: `${key} must be text` });
  const {
    targetUserId, phone, firstName, lastName, role, workerType,
    addressLine1, addressLine2, city, state, postalCode,
    ssn, ein, companyName,
  } = reqBody as Partial<Record<(typeof TEXT_FIELDS)[number], string>>;

  if (!targetUserId) return respond(400, { error: "targetUserId required" });
  if (role !== undefined && !isSupportedMemberRole(role)) return respond(422, { error: "Unsupported role" });
  if (workerType !== undefined && !WORKER_TYPES.includes(workerType)) return respond(422, { error: "Unsupported worker type" });

  // The target must belong to this organization, and only to it.
  const targetMemberships = await membershipsOf(admin, targetUserId);
  if (!targetMemberships) return respond(500, { error: "Could not load this member." });
  const membership = targetMemberships.find((m) => m.org_id === orgId);
  if (!membership) return respond(404, { error: "Member not found in this organization." });
  if (targetMemberships.length !== 1)
    return respond(409, { error: "This member also belongs to another organization and can't be edited here." });
  const { data: targetProfile, error: targetProfileErr } = await admin.from("profiles")
    .select("organization_id").eq("id", targetUserId).maybeSingle();
  if (targetProfileErr) return respond(500, { error: "Could not load this member." });
  if (targetProfile?.organization_id !== orgId)
    return respond(409, { error: "This member's profile belongs to another organization and can't be edited here." });

  const isOwnerTarget = membership.role === "owner";
  if (isOwnerTarget) {
    if (targetUserId !== caller.userId) return respond(403, { error: "Another owner can't be edited here." });
    if (role !== undefined && role !== "owner") return respond(403, { error: "The owner's role can't be changed here." });
  } else if (role === "owner") {
    return respond(403, { error: "The owner role can't be assigned here." });
  }

  // ── Writes (all checks passed) ──────────────────────────────────────────

  // 1. Membership (never for an owner)
  const memberPatch: Record<string, unknown> = {};
  if (!isOwnerTarget && role !== undefined && role !== membership.role) memberPatch.role = role;
  if (!isOwnerTarget && workerType !== undefined) memberPatch.worker_type = workerType;
  if (Object.keys(memberPatch).length > 0) {
    const { data: updated, error } = await admin.from("org_memberships").update(memberPatch)
      .eq("member_id", targetUserId).eq("org_id", orgId).select("member_id");
    if (error || updated?.length !== 1) {
      console.error(`[update-user-by-id] membership update failed (${error ? errorCode(error) : `${updated?.length ?? 0} rows`}) for ${targetUserId}`);
      return respond(500, { error: "Could not update this member's role." });
    }
  }

  // 2. Profile
  const profilePatch: Record<string, unknown> = {};
  if (firstName    !== undefined) profilePatch.first_name    = firstName;
  if (lastName     !== undefined) profilePatch.last_name     = lastName;
  if (phone        !== undefined) profilePatch.phone         = phone || null;
  if (addressLine1 !== undefined) profilePatch.address_line1 = addressLine1 || null;
  if (addressLine2 !== undefined) profilePatch.address_line2 = addressLine2 || null;
  if (city         !== undefined) profilePatch.city          = city  || null;
  if (state        !== undefined) profilePatch.state         = state || null;
  if (postalCode   !== undefined) profilePatch.postal_code   = postalCode || null;
  if (ssn          !== undefined) profilePatch.ssn           = ssn  || null;
  if (ein          !== undefined) profilePatch.ein           = ein  || null;
  if (companyName  !== undefined) profilePatch.company_name  = companyName || null;
  if (!isOwnerTarget && workerType !== undefined) profilePatch.worker_type = workerType;
  if (Object.keys(profilePatch).length > 0) {
    const { data: updated, error } = await admin.from("profiles").update(profilePatch)
      .eq("id", targetUserId).eq("organization_id", orgId).select("id");
    if (error || updated?.length !== 1) {
      console.error(`[update-user-by-id] profile update failed (${error ? errorCode(error) : `${updated?.length ?? 0} rows`}) for ${targetUserId}`);
      return respond(500, { error: "Could not update this member's profile." });
    }
  }

  // 3. Auth (display metadata and E.164 phone)
  const metaPatch: Record<string, unknown> = {};
  if (firstName !== undefined) metaPatch.first_name = firstName;
  if (lastName  !== undefined) metaPatch.last_name  = lastName;
  if (firstName !== undefined || lastName !== undefined)
    metaPatch.full_name = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  if (phone !== undefined) metaPatch.phone = phone;
  const e164 = phone ? toE164(phone) : undefined;
  if (Object.keys(metaPatch).length > 0 || e164) {
    let code: string | null;
    try {
      const { error } = await admin.auth.admin.updateUserById(targetUserId, {
        ...(e164 ? { phone: e164 } : {}),
        user_metadata: metaPatch,
      });
      code = error ? errorCode(error) : null;
    } catch (e) { code = errorCode(e); }
    if (code !== null) {
      console.error(`[update-user-by-id] auth update failed (${code}) for ${targetUserId}`);
      return respond(500, { error: "Could not update this member's sign-in details." });
    }
  }

  console.log(`[update-user-by-id] ✓ updated ${targetUserId} in org ${orgId}`);
  return respond(200, { ok: true });
};
