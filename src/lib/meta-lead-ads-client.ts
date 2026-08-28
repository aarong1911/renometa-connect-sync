// src/lib/meta-lead-ads-client.ts
//
// Frontend fetch layer for Meta Lead Ads form discovery + manual
// reconciliation (Phase 1B / Step 2) — same bearer-session +
// discriminated-result pattern as meta-ads-client.ts (Phase 1A). No UI
// component fetches these endpoints directly.

import { supabase } from "@/lib/supabase";

export interface MetaLeadForm {
  id: string;
  name: string | null;
  status: string | null;
  createdTime: string | null;
}

export interface MetaLeadFormsResponse {
  connected: true;
  page: { id: string; name: string | null };
  forms: MetaLeadForm[];
}

export type MetaLeadAdsResultKind =
  | "unauthorized"
  | "not_connected"
  | "reconnect_required"
  | "permission_required"
  | "temporarily_unavailable"
  | "provider_error"
  | "network_error";

export type MetaLeadFormsResult =
  | { ok: true; data: MetaLeadFormsResponse }
  | { ok: false; kind: MetaLeadAdsResultKind; errorCode?: string | null };

export async function getMetaLeadForms(): Promise<MetaLeadFormsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/meta-lead-forms", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  // Only 401 means "your session is invalid" — meta-lead-forms.ts also
  // uses 403 for permission_required (missing leads_retrieval), which must
  // be classified via errorCode below, never collapsed into "unauthorized".
  if (res.status === 401) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && json?.connected === true) {
    return { ok: true, data: json as MetaLeadFormsResponse };
  }
  if (res.ok && json?.connected === false) {
    return { ok: false, kind: "not_connected" };
  }

  const errorCode: string | null = typeof json?.errorCode === "string" ? json.errorCode : null;
  if (errorCode === "reconnect_required" || errorCode === "permission_required" || errorCode === "temporarily_unavailable") {
    return { ok: false, kind: errorCode };
  }
  return { ok: false, kind: "provider_error", errorCode };
}

export type MetaReconcileWindow = "1h" | "6h" | "24h" | "72h" | "7d";

export interface MetaReconcileSummary {
  ok: true;
  window: MetaReconcileWindow;
  formsScanned: number;
  leadsDiscovered: number;
  created: number;
  matched: number;
  duplicates: number;
  failed: number;
  failures: Array<{ metaLeadId: string; errorCode: string }>;
  truncated: boolean;
}

export type MetaReconcileResult =
  | { ok: true; data: MetaReconcileSummary }
  | { ok: false; kind: MetaLeadAdsResultKind; errorCode?: string | null };

export async function reconcileMetaLeadAds(window: MetaReconcileWindow = "24h"): Promise<MetaReconcileResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/meta-lead-reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ window }),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  // Only 401 means "your session is invalid" — meta-lead-reconcile.ts also
  // uses 403 for permission_required and 409 for reconnect_required, both
  // of which must be classified via errorCode below.
  if (res.status === 401) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && json?.ok === true) {
    return { ok: true, data: json as MetaReconcileSummary };
  }
  if (json?.connected === false) return { ok: false, kind: "not_connected" };

  const errorCode: string | null = typeof json?.errorCode === "string" ? json.errorCode : null;
  if (errorCode === "reconnect_required" || errorCode === "permission_required" || errorCode === "temporarily_unavailable") {
    return { ok: false, kind: errorCode };
  }
  return { ok: false, kind: "provider_error", errorCode };
}
