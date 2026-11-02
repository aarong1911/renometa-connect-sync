// src/lib/integration-config-client.ts
//
// Browser client for the per-org API-key integration endpoints
// (netlify/functions/integration-config-*.ts). The browser never reads or
// writes organizations.integration_settings directly — it only ever sees the
// redacted { configured, fields } shape, which carries no secret values.

import { supabase } from "@/lib/supabase";

export type IntegrationStatus = { configured: boolean; fields: Record<string, string> };

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` };
}

/** Redacted status keyed by integration_settings key (e.g. "twilio"), or null if unavailable. */
export async function fetchIntegrationStatuses(): Promise<Record<string, IntegrationStatus> | null> {
  try {
    const res = await fetch("/.netlify/functions/integration-config-status", { headers: await authHeaders() });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    return json.integrations ?? {};
  } catch {
    return null;
  }
}

export async function saveIntegrationConfig(provider: string, fields: Record<string, string>): Promise<IntegrationStatus> {
  const res = await fetch("/.netlify/functions/integration-config-save", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ provider, fields }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Failed to save credentials");
  return json.status ?? { configured: true, fields: {} };
}

export async function disconnectIntegrationConfig(provider: string): Promise<void> {
  const res = await fetch("/.netlify/functions/integration-config-disconnect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? "Disconnect failed");
  }
}
