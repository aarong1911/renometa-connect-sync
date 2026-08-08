// src/lib/change-order-approvals.ts
//
// Phase 13.3B — client-side wrapper for the three Change Order Netlify
// functions. Token creation/hashing, approval, and rejection all require
// service-role privileges or SECURITY DEFINER RPC access, so none of this
// is ever done directly against Supabase from the browser — see
// netlify/functions/change-order-send.ts / change-order-data.ts /
// change-order-action.ts.

import { supabase } from "@/lib/supabase";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export type SendChangeOrderResult = {
  ok: boolean;
  status: string;
  totalAmount: number;
  approvalUrl: string;
  emailDelivered: boolean;
  emailError: string | null;
  recipientEmail: string | null;
  sentAt: string;
};

/** Authenticated (Connect) call — recalculates totals server-side, snapshots the version, mints a secure token, and best-effort emails the customer. Always returns a Copy Approval Link-capable URL even if email delivery fails. */
export async function sendChangeOrderForApproval(changeOrderId: string): Promise<SendChangeOrderResult> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/change-order-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ changeOrderId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Could not send this Change Order for approval.");
  return data as SendChangeOrderResult;
}

export type PublicChangeOrderPayload = {
  changeOrder: {
    number: string; version: number; title: string; scope: string | null; customerMessage: string | null;
    status: string; currency: string; subtotal: number; discountAmount: number; markupAmount: number;
    taxAmount: number; totalAmount: number; scheduleImpactDays: number; proposedStartDate: string | null;
    proposedCompletionDate: string | null; approvalDueAt: string | null; projectName: string | null; projectAddress: string | null;
  };
  items: { id: string; position: number; itemType: string; name: string; description: string | null; quantity: number; unit: string | null; unitPrice: number; lineTotal: number; taxable: boolean }[];
  org: { name: string; phone: string | null; logo: string | null; primaryColor: string; address: string | null; website: string | null };
};

/** Public, unauthenticated — used by the /change-order/$token customer approval page. */
export async function fetchPublicChangeOrder(token: string): Promise<PublicChangeOrderPayload> {
  const res = await fetch(`/.netlify/functions/change-order-data?token=${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "This Change Order could not be found.");
  return data as PublicChangeOrderPayload;
}

export type ApproveChangeOrderInput = { token: string; name: string; email?: string; acknowledgment?: string; signatureName?: string };
export type RejectChangeOrderInput = { token: string; name: string; email?: string; reason?: string };

export async function approvePublicChangeOrder(input: ApproveChangeOrderInput): Promise<void> {
  const res = await fetch("/.netlify/functions/change-order-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: input.token,
      action: "approve",
      payload: {
        name: input.name,
        email: input.email,
        acknowledgment: input.acknowledgment,
        signature: input.signatureName ? { name: input.signatureName, typedAt: new Date().toISOString() } : null,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "This Change Order could not be approved.");
}

export async function rejectPublicChangeOrder(input: RejectChangeOrderInput): Promise<void> {
  const res = await fetch("/.netlify/functions/change-order-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: input.token, action: "reject", payload: { name: input.name, email: input.email, reason: input.reason } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "This Change Order could not be rejected.");
}
