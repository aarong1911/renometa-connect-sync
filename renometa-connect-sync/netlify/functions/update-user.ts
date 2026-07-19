/// <reference types="node" />
// netlify/functions/update-user.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/** Convert any phone string to E.164 format (+1XXXXXXXXXX for US numbers) */
function toE164(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  // Already has country code
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // 10-digit US number — prepend +1
  if (digits.length === 10) return `+1${digits}`;
  // International — trust as-is
  if (digits.length > 10) return `+${digits}`;
  return undefined;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: "" };

  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return { statusCode: 401, body: "" };

  const { phone, firstName, lastName } = JSON.parse(event.body ?? "{}");

  const e164Phone = toE164(phone ?? "");

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    // Only set phone column if we have a valid E.164 value
    ...(e164Phone ? { phone: e164Phone } : {}),
    user_metadata: {
      ...user.user_metadata,
      first_name: firstName || user.user_metadata?.first_name,
      last_name:  lastName  || user.user_metadata?.last_name,
      full_name:  `${firstName || ""} ${lastName || ""}`.trim() || user.user_metadata?.full_name,
      phone:      phone     || user.user_metadata?.phone,
    },
  });

  if (error) {
    console.error("[update-user] failed:", JSON.stringify(error));
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  console.log(`[update-user] updated user ${user.id}, phone: ${e164Phone ?? "not set"}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};