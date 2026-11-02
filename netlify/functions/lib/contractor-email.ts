// netlify/functions/lib/contractor-email.ts
//
// Which account sends an organization's own (contractor-originated) email —
// Conversations replies (send-inbox-message.ts) and email campaigns
// (marketing-campaign-*.ts). Estimates and change orders call
// resolveGmailSender directly and stay Gmail-API-only.
//
// RenoMeta's platform mail (invites, invoices, receipts, appointment
// confirmations, workflows — SMTP_USER / SMTP_PASSWORD env vars) is never
// routed through here and never through a contractor's Gmail.
//
// Routing, in order:
//   1. The org has a Gmail OAuth connection (integrations row not
//      'disconnected') and it passes resolveGmailSender's preflight
//      (decryptable, refreshable, issued to this app, send scope)
//        -> "gmail_api".
//   2. Otherwise, the org has legacy SMTP sending configured (App Password in
//      organization_integration_secrets, or a not-yet-migrated plaintext one)
//        -> "smtp", exactly as before this module existed. If step 1 failed,
//      `gmailIssue` carries why, so callers can tell the user to reconnect
//      instead of switching accounts silently.
//   3. Neither -> throws GmailSendError (connect / reconnect guidance).
//
// Falling back in step 2 only ever happens BEFORE anything was sent (a
// preflight failure). After a Gmail send attempt, callers never fall back to
// SMTP — an ambiguous Gmail result could already be in the customer's inbox.

import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailSendError, isGmailAuthorizationError, resolveGmailSender, type FetchLike, type GmailSender } from "./gmail-send.ts";
import { getOrgSecret } from "./org-secret-store.ts";

export type SmtpCredentials = {
  email: string;
  /** Whitespace already stripped (Google displays App Passwords in groups of four). */
  password: string;
  /** True when the password came from the pre-migration plaintext integration_settings field. */
  usedLegacyPlaintext: boolean;
  senderName: string | null;
};

export type ContractorEmailRoute =
  | { provider: "gmail_api"; sender: GmailSender }
  | { provider: "smtp"; smtp: SmtpCredentials; gmailIssue: GmailSendError | null };

/** Legacy SMTP credentials, or null when the org has none. Never logs the password. */
export async function loadSmtpCredentials(admin: SupabaseClient, orgId: string): Promise<SmtpCredentials | null> {
  const { data: org } = await admin.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
  const gmail = (org as { integration_settings?: Record<string, any> } | null)?.integration_settings?.gmail;
  const email = typeof gmail?.email === "string" ? gmail.email.trim() : "";
  if (!email) return null;

  let password = await getOrgSecret(admin, orgId, "gmail", "smtp_app_password");
  const usedLegacyPlaintext = !password && !!gmail.appPassword;
  if (!password && gmail.appPassword) password = String(gmail.appPassword);
  if (!password) return null;

  return {
    email,
    password: password.replace(/\s+/g, ""),
    usedLegacyPlaintext,
    senderName: typeof gmail.senderName === "string" ? gmail.senderName : null,
  };
}

const noEmailAccount = () =>
  new GmailSendError(
    "email_not_connected",
    "Connect your Google account in Settings → Integrations to send email from RenoMeta.",
    { httpStatus: 409 },
  );

export async function resolveContractorEmailRoute(
  admin: SupabaseClient,
  orgId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ContractorEmailRoute> {
  const { data: row, error } = await admin
    .from("integrations")
    .select("status")
    .eq("org_id", orgId)
    .eq("provider", "gmail")
    .maybeSingle();
  if (error) {
    console.error("[contractor-email] gmail connection lookup failed:", error.message);
    throw new GmailSendError("email_provider_unavailable", "Couldn't check your email connection. Nothing was sent — please try again.", { httpStatus: 503 });
  }

  let gmailIssue: GmailSendError | null = null;
  if (row && (row as { status?: string }).status !== "disconnected") {
    try {
      return { provider: "gmail_api", sender: await resolveGmailSender(admin, orgId, fetchImpl) };
    } catch (err) {
      if (!(err instanceof GmailSendError)) throw err;
      gmailIssue = err;
    }
  }

  const smtp = await loadSmtpCredentials(admin, orgId);
  if (smtp) return { provider: "smtp", smtp, gmailIssue };
  throw gmailIssue ?? noEmailAccount();
}

/** Shown alongside a successful SMTP send when the Google connection couldn't be used. */
export function smtpFallbackNotice(gmailIssue: GmailSendError | null): string | null {
  if (!gmailIssue) return null;
  return isGmailAuthorizationError(gmailIssue)
    ? "Sent from your legacy SMTP account because your Google connection needs to be reconnected in Settings → Integrations."
    : "Sent from your legacy SMTP account because Google couldn't be reached.";
}
