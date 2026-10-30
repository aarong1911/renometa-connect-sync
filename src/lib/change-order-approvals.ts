// src/lib/change-order-approvals.ts
//
// Phase 13.3B — client-side wrapper for the three Change Order Netlify
// functions. Token creation/hashing, approval, and rejection all require
// service-role privileges or SECURITY DEFINER RPC access, so none of this
// is ever done directly against Supabase from the browser — see
// netlify/functions/change-order-send.ts / change-order-data.ts /
// change-order-action.ts.

import { supabase } from "@/lib/supabase";
import { EmailSendRequestError, parseEmailSendAction } from "@/lib/email-send-errors";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export type SendChangeOrderResult = {
  ok: boolean;
  status: string;
  totalAmount: number | null;
  /** Null when an earlier, already-emailed send was finished — the customer already has the link. */
  approvalUrl: string | null;
  emailDelivered: boolean;
  emailError: string | null;
  recipientEmail: string | null;
  fromEmail: string | null;
  sentAt: string | null;
  /** False when Gmail accepted the email but the Change Order couldn't be marked sent yet (see warning). */
  recorded?: boolean;
  warning?: string;
  /** This request finished recording an earlier send instead of emailing again. */
  recoveredEarlierSend?: boolean;
};

/** Authenticated (Connect) call — recalculates totals server-side, snapshots the version, mints a secure token, and emails the customer from the org's connected Gmail account; the Change Order is marked sent only after Gmail accepts. Throws EmailSendRequestError when the customer has an email address and Gmail isn't usable, rejects the message, or can't confirm it — the Change Order is then left unsent. */
export async function sendChangeOrderForApproval(changeOrderId: string, opts: { confirmResend?: boolean } = {}): Promise<SendChangeOrderResult> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/change-order-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ changeOrderId, ...(opts.confirmResend ? { confirmResend: true } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new EmailSendRequestError(
      { error: data?.error, code: data?.code, action: parseEmailSendAction(data?.action), canConfirmResend: data?.canConfirmResend === true },
      "Could not send this Change Order for approval.",
    );
  }
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
