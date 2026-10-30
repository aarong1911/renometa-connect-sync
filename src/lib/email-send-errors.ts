// src/lib/email-send-errors.ts
//
// Browser side of the structured customer-email errors returned by
// estimate-send.ts / change-order-send.ts (see netlify/functions/lib/gmail-send.ts):
// `email_not_connected` / `email_reconnect_required` / `email_send_scope_missing`
// carry an `action` — a link to the Settings → Integrations Gmail flow for the
// org owner, or `contact_owner` for everyone else (Settings is owner-only).
// `email_delivery_unconfirmed` with `canConfirmResend` lets the user choose to
// send again after checking their Gmail Sent folder.
import { toast } from "sonner";

export type EmailSendAction =
  | { type: "connect_email" | "reconnect_email"; path: string }
  | { type: "contact_owner" };

export type EmailSendFailure = {
  error?: string;
  code?: string;
  action?: EmailSendAction;
  canConfirmResend?: boolean;
};

export class EmailSendRequestError extends Error {
  readonly code: string | null;
  readonly action: EmailSendAction | null;
  readonly canConfirmResend: boolean;

  constructor(failure: EmailSendFailure, fallback: string) {
    super(failure.error || fallback);
    this.name = "EmailSendRequestError";
    this.code = failure.code ?? null;
    this.action = failure.action ?? null;
    this.canConfirmResend = failure.canConfirmResend === true;
  }

  toFailure(): EmailSendFailure {
    return {
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(this.action ? { action: this.action } : {}),
      ...(this.canConfirmResend ? { canConfirmResend: true } : {}),
    };
  }
}

export function parseEmailSendAction(value: unknown): EmailSendAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { type, path } = value as { type?: unknown; path?: unknown };
  if (type === "contact_owner") return { type };
  if ((type !== "connect_email" && type !== "reconnect_email") || typeof path !== "string" || !path.startsWith("/")) return undefined;
  return { type, path };
}

/**
 * Error toast. Owners get a Connect/Reconnect Gmail button; other roles get
 * the server's "ask your organization owner" message with no button. When an
 * earlier send couldn't be confirmed and the server allows it, `onConfirmResend`
 * becomes a "Send anyway" button.
 */
export function toastEmailSendFailure(
  failure: EmailSendFailure,
  fallback: string,
  opts: { onConfirmResend?: () => void } = {},
): void {
  const message = failure.error || fallback;
  const action = failure.action;
  if (action && action.type !== "contact_owner") {
    toast.error(message, {
      duration: 10000,
      action: {
        label: action.type === "connect_email" ? "Connect Gmail" : "Reconnect Gmail",
        onClick: () => window.location.assign(action.path),
      },
    });
    return;
  }
  if (failure.code === "email_delivery_unconfirmed" && failure.canConfirmResend && opts.onConfirmResend) {
    toast.error(message, {
      duration: 15000,
      action: { label: "Send anyway", onClick: opts.onConfirmResend },
    });
    return;
  }
  toast.error(message, action ? { duration: 10000 } : undefined);
}
