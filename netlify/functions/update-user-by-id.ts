/// <reference types="node" />
// netlify/functions/update-user-by-id.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function toE164(raw: string): string | undefined {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length > 10) return `+${d}`;
  return undefined;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: "" };

  const { data: { user: caller } } = await admin.auth.getUser(token);
  if (!caller) return { statusCode: 401, body: "" };

  const {
    targetUserId, phone, firstName, lastName, role, workerType,
    addressLine1, addressLine2, city, state, postalCode,
    ssn, ein, companyName,
  } = JSON.parse(event.body ?? "{}");

  if (!targetUserId) return { statusCode: 400, body: JSON.stringify({ error: "targetUserId required" }) };

  const e164 = phone ? toE164(phone) : undefined;

  // 1. Update auth.users
  const metaPatch: Record<string, any> = {};
  if (firstName !== undefined) metaPatch.first_name = firstName;
  if (lastName  !== undefined) metaPatch.last_name  = lastName;
  if (firstName !== undefined || lastName !== undefined)
    metaPatch.full_name = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  if (phone !== undefined) metaPatch.phone = phone;

  if (Object.keys(metaPatch).length > 0 || e164) {
    const { error } = await admin.auth.admin.updateUserById(targetUserId, {
      ...(e164 ? { phone: e164 } : {}),
      user_metadata: metaPatch,
    });
    if (error) console.error("[update-user-by-id] auth update failed:", error);
  }

  // 2. Update profiles (admin bypasses RLS)
  const profilePatch: Record<string, any> = {};
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
  if (workerType   !== undefined) profilePatch.worker_type   = workerType;

  if (Object.keys(profilePatch).length > 0) {
    const { error } = await admin.from("profiles").update(profilePatch).eq("id", targetUserId);
    if (error) console.error("[update-user-by-id] profiles update failed:", error);
    else console.log(`[update-user-by-id] profile updated for ${targetUserId}`);
  }

  // 3. Update org_memberships
  const memberPatch: Record<string, any> = {};
  if (role       !== undefined) memberPatch.role        = role;
  if (workerType !== undefined) memberPatch.worker_type = workerType;

  if (Object.keys(memberPatch).length > 0) {
    const { error } = await admin.from("org_memberships").update(memberPatch).eq("member_id", targetUserId);
    if (error) console.error("[update-user-by-id] memberships update failed:", error);
    else console.log(`[update-user-by-id] memberships updated for ${targetUserId}`);
  }

  console.log(`[update-user-by-id] ✓ updated ${targetUserId}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};