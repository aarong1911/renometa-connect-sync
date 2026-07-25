// netlify/functions/lib/org-secret-store.ts
//
// Thin, reusable read/write/delete layer over
// organization_integration_secrets (see
// supabase/migrations/20260727_organization_integration_secrets.sql).
// Reuses the exact same AES-256-GCM + bytea wire format already used for
// Gmail OAuth tokens (netlify/functions/lib/gmail-token-crypto.ts) rather
// than inventing a second encryption scheme. Service-role only — this
// table has no RLS policies for anon/authenticated at all, so every
// caller here must be running with the service-role client.
//
// Never logs plaintext, ciphertext, or any part of a secret value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptBytea, encryptToBytea } from "./gmail-token-crypto";

export async function getOrgSecret(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
  provider: string,
  secretType: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("organization_integration_secrets")
    .select("encrypted_value")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("secret_type", secretType)
    .maybeSingle();

  if (error) {
    console.error("[org-secret-store] read failed:", error.message);
    return null;
  }
  if (!data?.encrypted_value) return null;

  try {
    return decryptBytea(data.encrypted_value);
  } catch (err: any) {
    console.error("[org-secret-store] decrypt failed:", err.message);
    return null;
  }
}

export async function setOrgSecret(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
  provider: string,
  secretType: string,
  plaintext: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const encrypted = encryptToBytea(plaintext);
  const { error } = await supabaseAdmin
    .from("organization_integration_secrets")
    .upsert(
      {
        organization_id: organizationId,
        provider,
        secret_type: secretType,
        encrypted_value: encrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider,secret_type" },
    );

  if (error) {
    console.error("[org-secret-store] write failed:", error.message);
    return { ok: false, error: "Failed to save secret" };
  }
  return { ok: true };
}

export async function deleteOrgSecret(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
  provider: string,
  secretType: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("organization_integration_secrets")
    .delete()
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("secret_type", secretType);

  if (error) {
    console.error("[org-secret-store] delete failed:", error.message);
    return { ok: false, error: "Failed to delete secret" };
  }
  return { ok: true };
}
