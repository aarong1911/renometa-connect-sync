/// <reference types="node" />
// netlify/functions/accept-invite.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body: {
    token: string; password: string;
    firstName: string; lastName: string; phone?: string;
    addressLine1?: string; addressLine2?: string; city?: string; state?: string; postalCode?: string;
    ssn?: string; ein?: string; companyName?: string;
  };
  try { body = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { token, password, firstName, lastName, phone,
    addressLine1, addressLine2, city, state, postalCode,
    ssn, ein, companyName } = body;

  if (!token || !password) return { statusCode: 400, body: JSON.stringify({ error: "token and password required" }) };

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from("invitations").select("*").eq("token", token).eq("status", "pending").maybeSingle();

  if (invErr || !invitation) {
    console.error("[accept-invite] token lookup failed:", invErr);
    return { statusCode: 404, body: JSON.stringify({ error: "Invalid or expired invitation" }) };
  }
  if (new Date(invitation.expires_at) < new Date())
    return { statusCode: 410, body: JSON.stringify({ error: "Invitation has expired" }) };

  const { email, organization_id: orgId, role, worker_type: workerType } = invitation;
  console.log(`[accept-invite] processing: ${email} → org ${orgId} as ${role} (${workerType})`);

  // Create auth user
  const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr) {
    console.error("[accept-invite] createUser failed:", createErr);
    return { statusCode: 500, body: JSON.stringify({ error: createErr.message }) };
  }
  const userId = newUser.user.id;
  console.log(`[accept-invite] created auth user: ${userId}`);

  // Update metadata
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      first_name: firstName, last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      phone: phone || null, org_id: orgId, role,
      invitation_id: invitation.id,
    },
  });

  // Upsert full profile
  const { error: profileErr } = await supabaseAdmin.from("profiles").upsert({
    id: userId, email,
    first_name:    firstName,
    last_name:     lastName,
    phone:         phone         || null,
    organization_id: orgId,
    address_line1: addressLine1  || null,
    address_line2: addressLine2  || null,
    city:          city          || null,
    state:         state         || null,
    postal_code:   postalCode    || null,
    worker_type:   workerType    || "employee",
    ssn:           ssn           || null,
    ein:           ein           || null,
    company_name:  companyName   || null,
  }, { onConflict: "id" });
  if (profileErr) console.error("[accept-invite] profiles upsert failed:", JSON.stringify(profileErr));
  else console.log("[accept-invite] profile upserted");

  // Add to org_memberships
  const { error: memberErr } = await supabaseAdmin.from("org_memberships").insert({
    member_id:   userId,
    org_id:      orgId,
    role,
    worker_type: workerType || "employee",
  });
  if (memberErr) console.error("[accept-invite] org_memberships insert failed:", JSON.stringify(memberErr));
  else console.log("[accept-invite] added to org_memberships");

  // Mark invitation accepted
  await supabaseAdmin.from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);

  // Set phone E.164
  if (phone) {
    const d = phone.replace(/\D/g, "");
    const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : null;
    if (e164) await supabaseAdmin.auth.admin.updateUserById(userId, { phone: e164 });
  }

  console.log(`[accept-invite] ✓ complete — ${email} joined org ${orgId} as ${role}`);
  return { statusCode: 200, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, email }) };
};