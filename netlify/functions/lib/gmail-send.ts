// netlify/functions/lib/gmail-send.ts
//
// Contractor-owned outbound email through the Gmail API, for customer-facing
// documents (estimate-send.ts, change-order-send.ts). Customer email is sent
// FROM the contractor's own connected Gmail account — never from RenoMeta's
// SES account or a renometa.com address, and never silently falls back to
// one. AWS SES stays reserved for RenoMeta platform mail.
//
// Sender selection: the Gmail connection is ORG-scoped — `integrations` holds
// at most one (org_id, provider='gmail') row, created by
// gmail-oauth-callback.ts. There is no per-user connection and no
// org-level sender policy, so the only authorized sender for an org is that
// row's account. The sender is always resolved here, server-side, from the
// caller's already-resolved orgId; the browser never names a sender address.
//
// Preflight (resolveGmailSender) runs BEFORE the caller writes anything:
// connection present + connected, token decryptable, refreshed if expired
// (same refresh_token grant as gmail-sync.ts), and the live token is checked
// against Google's tokeninfo for (a) this app's OAuth client and (b) a scope
// that permits users.messages.send. A missing/revoked/under-scoped
// connection is therefore reported before any estimate/change-order state
// changes.
//
// Send (sendGmailMessage) is never retried automatically: a 5xx, a network
// failure, or a 2xx without an id is classified `email_delivery_unknown`
// because Gmail may already have accepted the message — retrying could send
// the customer a duplicate.
//
// Reconciliation: every send carries an `X-RenoMeta-Send-Id` header (the
// duplicate-send claim id). When an earlier outcome was ambiguous,
// findSentGmailMessage looks for that header in the account's Sent mail
// around the claim time, so the caller can finish recording a message Gmail
// did accept instead of guessing. (A custom header, not Message-ID: Gmail
// may replace the Message-ID of API-sent mail.) Needs gmail.readonly, which
// the app already requests for inbox sync. Only a match is conclusive; a
// miss never authorizes a resend on its own (see email-send-claim.ts).
//
// Never logs tokens, message bodies, or recipient addresses.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptBytea, encryptToBytea } from "./gmail-token-crypto.ts";
import { getAppConfigs } from "./app-config-store.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const SEND_ID_HEADER = "X-RenoMeta-Send-Id";

/** Refresh a little before the stored expiry so the token can't lapse mid-send. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

/** Any one of these lets users.messages.send succeed. gmail.send is what the app requests. */
const SEND_CAPABLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
];

export const CONNECT_EMAIL_PATH = "/settings/integrations";

export type GmailSendErrorCode =
  | "email_not_connected"
  | "email_reconnect_required"
  | "email_send_scope_missing"
  | "email_rate_limited"
  | "email_provider_rejected"
  | "email_provider_unavailable"
  | "email_delivery_unknown";

export type EmailSendAction =
  | { type: "connect_email" | "reconnect_email"; path: string }
  /** Only the org owner can open Settings → Integrations; other roles are told to ask them. */
  | { type: "contact_owner" };

const OWNER_GUIDANCE: Partial<Record<GmailSendErrorCode, string>> = {
  email_not_connected:
    "Gmail isn't connected for your organization. Ask your organization owner to connect Gmail in Settings → Integrations, then send again.",
  email_reconnect_required:
    "Your organization's Gmail connection has expired or was revoked. Ask your organization owner to reconnect Gmail in Settings → Integrations, then send again.",
  email_send_scope_missing:
    "Your organization's Gmail connection doesn't allow sending email. Ask your organization owner to reconnect Gmail in Settings → Integrations and grant send access.",
};

export class GmailSendError extends Error {
  readonly code: GmailSendErrorCode;
  readonly httpStatus: number;
  /** True when Gmail may have accepted the message — callers must NOT offer an automatic retry. */
  readonly maybeSent: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(code: GmailSendErrorCode, message: string, opts: { httpStatus: number; maybeSent?: boolean; retryAfterSeconds?: number | null }) {
    super(message);
    this.name = "GmailSendError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.maybeSent = opts.maybeSent ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }

  get action(): EmailSendAction | null {
    if (this.code === "email_not_connected") return { type: "connect_email", path: CONNECT_EMAIL_PATH };
    if (this.code === "email_reconnect_required" || this.code === "email_send_scope_missing") {
      return { type: "reconnect_email", path: CONNECT_EMAIL_PATH };
    }
    return null;
  }

  /**
   * Browser-safe response body. Never contains provider error text.
   * `canManageIntegrations: false` (anyone but the org owner) swaps the
   * Connect/Reconnect action for guidance to contact the owner.
   */
  toResponseBody(opts: { canManageIntegrations?: boolean } = {}): Record<string, unknown> {
    const ownerOnly = opts.canManageIntegrations === false && this.action !== null;
    const action: EmailSendAction | null = ownerOnly ? { type: "contact_owner" } : this.action;
    return {
      error: ownerOnly ? OWNER_GUIDANCE[this.code] ?? this.message : this.message,
      code: this.code,
      ...(action ? { action } : {}),
      ...(ownerOnly ? { ownerActionRequired: true } : {}),
      ...(this.retryAfterSeconds !== null ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.maybeSent ? { maybeSent: true } : {}),
    };
  }
}

const notConnected = () =>
  new GmailSendError(
    "email_not_connected",
    "Connect your Gmail account in Settings → Integrations to send email to customers.",
    { httpStatus: 409 },
  );
const reconnectRequired = () =>
  new GmailSendError(
    "email_reconnect_required",
    "Your Gmail connection has expired or was revoked. Reconnect Gmail in Settings → Integrations, then send again.",
    { httpStatus: 409 },
  );
const scopeMissing = () =>
  new GmailSendError(
    "email_send_scope_missing",
    "Your Gmail connection doesn't allow sending email. Reconnect Gmail in Settings → Integrations and grant send access.",
    { httpStatus: 409 },
  );
const providerUnavailable = () =>
  new GmailSendError(
    "email_provider_unavailable",
    "Gmail could not be reached. Nothing was sent — please try again.",
    { httpStatus: 503 },
  );

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GmailSender = {
  integrationId: string;
  orgId: string;
  accessToken: string;
  /** The connected account's own address (captured at connect time); null only for very old rows. */
  accountEmail: string | null;
};

type IntegrationRow = {
  id: string;
  org_id: string;
  status: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  provider_account_email: string | null;
};

type OAuthClientConfig = { clientId: string | null; clientSecret: string | null };

async function loadOAuthClientConfig(admin: SupabaseClient): Promise<OAuthClientConfig> {
  const config = await getAppConfigs(admin, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  return { clientId: config.GOOGLE_OAUTH_CLIENT_ID, clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET };
}

async function refreshAccessToken(
  admin: SupabaseClient,
  row: IntegrationRow,
  oauth: OAuthClientConfig,
  fetchImpl: FetchLike,
): Promise<string> {
  if (!row.refresh_token_encrypted) throw reconnectRequired();
  if (!oauth.clientId || !oauth.clientSecret) {
    console.error("[gmail-send] Google OAuth client is not configured on the server");
    throw providerUnavailable();
  }

  let refreshToken: string;
  try {
    refreshToken = decryptBytea(row.refresh_token_encrypted);
  } catch (err: any) {
    console.error("[gmail-send] refresh token decrypt failed:", err?.message);
    throw reconnectRequired();
  }

  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch {
    throw providerUnavailable();
  }

  if (!res.ok) {
    // Only Google's short error code is logged — never the body.
    const errJson: any = await res.json().catch(() => ({}));
    const googleError = typeof errJson?.error === "string" ? errJson.error : null;
    console.error("[gmail-send] token refresh failed", { status: res.status, error: googleError });
    if (googleError === "invalid_grant" || res.status === 400 || res.status === 401) throw reconnectRequired();
    throw providerUnavailable();
  }

  const json: any = await res.json().catch(() => ({}));
  if (typeof json?.access_token !== "string" || !json.access_token) throw providerUnavailable();
  const expiresAt = new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString();

  const update: Record<string, unknown> = {
    access_token_encrypted: encryptToBytea(json.access_token),
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  if (typeof json.refresh_token === "string" && json.refresh_token) {
    update.refresh_token_encrypted = encryptToBytea(json.refresh_token);
  }
  const { error } = await admin.from("integrations").update(update).eq("id", row.id).eq("org_id", row.org_id);
  if (error) {
    // The fresh token is still valid for this request; the next caller refreshes again.
    console.error("[gmail-send] storing refreshed token failed:", error.message);
  }
  return json.access_token;
}

type TokenInfo = { valid: true; scopes: string[]; audience: string | null } | { valid: false };

async function fetchTokenInfo(accessToken: string, fetchImpl: FetchLike): Promise<TokenInfo> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKENINFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
    });
  } catch {
    throw providerUnavailable();
  }
  // tokeninfo answers 400 for an expired/revoked/unknown token.
  if (res.status === 400 || res.status === 401) return { valid: false };
  if (!res.ok) throw providerUnavailable();
  const json: any = await res.json().catch(() => ({}));
  const scopes = typeof json?.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
  const audience = typeof json?.aud === "string" ? json.aud : typeof json?.azp === "string" ? json.azp : null;
  return { valid: true, scopes, audience };
}

export function hasSendScope(scopes: string[]): boolean {
  return scopes.some((s) => SEND_CAPABLE_SCOPES.includes(s));
}

/**
 * Resolve the org's authorized Gmail sender and a live, send-capable access
 * token. Read-only apart from persisting a refreshed token on the org's own
 * integrations row. Throws GmailSendError.
 */
export async function resolveGmailSender(
  admin: SupabaseClient,
  orgId: string,
  fetchImpl: FetchLike = fetch,
): Promise<GmailSender> {
  const { data, error } = await admin
    .from("integrations")
    .select("id, org_id, status, access_token_encrypted, refresh_token_encrypted, token_expires_at, provider_account_email")
    .eq("org_id", orgId)
    .eq("provider", "gmail")
    .maybeSingle();

  if (error) {
    console.error("[gmail-send] integration lookup failed:", error.message);
    throw providerUnavailable();
  }
  const row = data as IntegrationRow | null;
  // Defense in depth: the query is org-filtered, but never use a row from
  // any other tenant even if a filter were ever dropped.
  if (!row || row.org_id !== orgId) throw notConnected();
  if (row.status === "disconnected") throw notConnected();
  if (row.status !== "connected") throw reconnectRequired();
  if (!row.access_token_encrypted && !row.refresh_token_encrypted) throw notConnected();

  const oauth = await loadOAuthClientConfig(admin);

  let accessToken: string | null = null;
  let refreshed = false;
  const expiresAtMs = row.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
  const expired = !Number.isFinite(expiresAtMs) || expiresAtMs - EXPIRY_SKEW_MS <= Date.now();

  if (row.access_token_encrypted && !expired) {
    try {
      accessToken = decryptBytea(row.access_token_encrypted);
    } catch (err: any) {
      console.error("[gmail-send] access token decrypt failed:", err?.message);
    }
  }
  if (!accessToken) {
    accessToken = await refreshAccessToken(admin, row, oauth, fetchImpl);
    refreshed = true;
  }

  let info = await fetchTokenInfo(accessToken, fetchImpl);
  if (!info.valid && !refreshed) {
    accessToken = await refreshAccessToken(admin, row, oauth, fetchImpl);
    info = await fetchTokenInfo(accessToken, fetchImpl);
  }
  if (!info.valid) throw reconnectRequired();

  if (oauth.clientId && info.audience && info.audience !== oauth.clientId) {
    // A token minted for a different OAuth client must never be used here.
    console.error("[gmail-send] stored Gmail token was issued to a different OAuth client");
    throw reconnectRequired();
  }
  if (!hasSendScope(info.scopes)) throw scopeMissing();

  return {
    integrationId: row.id,
    orgId: row.org_id,
    accessToken,
    accountEmail: row.provider_account_email?.trim() || null,
  };
}

// ── MIME ────────────────────────────────────────────────────────────────

export type MimeAttachment = { filename: string; contentType: string; content: Buffer };

export type OutgoingEmail = {
  fromName: string | null;
  fromEmail: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MimeAttachment[];
  /** Domain part for the generated RFC Message-ID. */
  messageIdDomain?: string;
  /** Written as X-RenoMeta-Send-Id so an ambiguous send can be found in Sent mail later. */
  sendId?: string;
  now?: Date;
};

const EMAIL_PATTERN = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

export function isValidRecipientEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email) && !/[\r\n]/.test(email);
}

/** Header values can never carry a line break (header injection). */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-word for any non-ASCII header text. */
function encodeHeaderText(value: string): string {
  const safe = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

export function formatFromHeader(name: string | null, email: string): string {
  const cleanName = name ? headerSafe(name).replace(/["\\<>]/g, "").trim() : "";
  if (!cleanName) return email;
  return /^[\x20-\x7e]*$/.test(cleanName) ? `"${cleanName}" <${email}>` : `${encodeHeaderText(cleanName)} <${email}>`;
}

function base64Lines(content: Buffer | string): string {
  const b64 = Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64");
  return b64.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();
}

function safeFilename(name: string): string {
  return headerSafe(name).replace(/["\\/]/g, "_") || "attachment";
}

/** Build an RFC 5322 message. Returns the raw MIME text and its Message-ID. */
export function buildMimeMessage(email: OutgoingEmail): { mime: string; messageId: string } {
  if (!isValidRecipientEmail(email.to)) throw new Error("Invalid recipient email address");
  if (email.fromEmail && !isValidRecipientEmail(email.fromEmail)) throw new Error("Invalid sender email address");

  const boundary = (tag: string) => `=_rm_${tag}_${crypto.randomBytes(12).toString("hex")}`;
  const domain = (email.messageIdDomain || email.fromEmail?.split("@")[1] || "renometa.com").replace(/[^A-Za-z0-9.-]/g, "");
  const messageId = `<${crypto.randomUUID()}@${domain}>`;

  const headers = [
    // Without a From header Gmail uses the account's primary address.
    ...(email.fromEmail ? [`From: ${formatFromHeader(email.fromName, email.fromEmail)}`] : []),
    `To: ${email.to}`,
    `Subject: ${encodeHeaderText(email.subject)}`,
    `Date: ${(email.now ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(email.sendId ? [`${SEND_ID_HEADER}: ${email.sendId.replace(/[^A-Za-z0-9-]/g, "")}`] : []),
    "MIME-Version: 1.0",
  ];

  const altBoundary = boundary("alt");
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.text),
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.html),
    `--${altBoundary}--`,
  ].join("\r\n");

  const attachments = email.attachments ?? [];
  let body: string;
  if (attachments.length === 0) {
    body = alternative;
  } else {
    const mixedBoundary = boundary("mixed");
    const parts = [`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`, "", `--${mixedBoundary}`, alternative];
    for (const attachment of attachments) {
      const filename = safeFilename(attachment.filename);
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${headerSafe(attachment.contentType)}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(attachment.content),
      );
    }
    parts.push(`--${mixedBoundary}--`);
    body = parts.join("\r\n");
  }

  return { mime: `${headers.join("\r\n")}\r\n${body}\r\n`, messageId };
}

export function toBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

// ── Send ────────────────────────────────────────────────────────────────

export type GmailSendResult = { gmailMessageId: string; gmailThreadId: string | null; rfcMessageId: string };

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

function googleReasons(errJson: any): string[] {
  const reasons: string[] = [];
  for (const e of errJson?.error?.errors ?? []) if (typeof e?.reason === "string") reasons.push(e.reason);
  for (const d of errJson?.error?.details ?? []) if (typeof d?.reason === "string") reasons.push(d.reason);
  return reasons;
}

/** Classify a non-2xx Gmail send response. Exported for tests. */
export function classifyGmailSendFailure(status: number, errJson: unknown, retryAfterHeader: string | null): GmailSendError {
  const reasons = googleReasons(errJson);
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;

  if (status === 401) return reconnectRequired();
  if (status === 429 || reasons.some((r) => RATE_LIMIT_REASONS.has(r))) {
    return new GmailSendError(
      "email_rate_limited",
      "Gmail is limiting how fast this account can send. Nothing was sent — wait a minute and try again.",
      { httpStatus: 429, retryAfterSeconds: retryAfter ?? 60 },
    );
  }
  if (status === 403 && reasons.some((r) => SCOPE_REASONS.has(r))) return scopeMissing();
  if (status >= 400 && status < 500) {
    return new GmailSendError(
      "email_provider_rejected",
      "Gmail rejected this message, so nothing was sent. Check the customer's email address and your Gmail account, then try again.",
      { httpStatus: 502 },
    );
  }
  return deliveryUnknown();
}

function deliveryUnknown(): GmailSendError {
  return new GmailSendError(
    "email_delivery_unknown",
    "Gmail did not confirm the message. It may still have been sent — check your Gmail Sent folder before sending again.",
    { httpStatus: 502, maybeSent: true },
  );
}

/** One users.messages.send call. Never retried (see header). Throws GmailSendError. */
export async function sendGmailMessage(
  sender: GmailSender,
  email: OutgoingEmail,
  fetchImpl: FetchLike = fetch,
): Promise<GmailSendResult> {
  const { mime, messageId } = buildMimeMessage({ ...email, fromEmail: sender.accountEmail });

  let res: Response;
  try {
    res = await fetchImpl(GMAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${sender.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: toBase64Url(mime) }),
    });
  } catch {
    console.error("[gmail-send] Gmail send request failed before a response");
    throw deliveryUnknown();
  }

  if (!res.ok) {
    const errJson: any = await res.json().catch(() => ({}));
    console.error("[gmail-send] Gmail rejected send", { status: res.status, reasons: googleReasons(errJson) });
    throw classifyGmailSendFailure(res.status, errJson, res.headers.get("retry-after"));
  }

  const json: any = await res.json().catch(() => ({}));
  if (typeof json?.id !== "string" || !json.id) throw deliveryUnknown();
  return {
    gmailMessageId: json.id,
    gmailThreadId: typeof json.threadId === "string" ? json.threadId : null,
    rfcMessageId: messageId,
  };
}

// ── Reconcile ───────────────────────────────────────────────────────────

export type SentLookup =
  | { status: "found"; gmailMessageId: string; gmailThreadId: string | null }
  /**
   * Every page of the search window was checked and nothing matched. Still
   * NOT proof the message wasn't accepted (indexing lag, clock skew) — the
   * caller must not resend on this alone.
   */
  | { status: "not_found" }
  /** Search failed or was cut short (no read scope, Gmail error, network, too many pages). */
  | { status: "unavailable" };

/** How far around the claim time to look; generous for clock skew and slow sends. */
const LOOKUP_BEFORE_S = 5 * 60;
const LOOKUP_AFTER_S = 20 * 60;
const LOOKUP_PAGE_SIZE = 100;
/** Bounded so a very busy mailbox can't stall the request; hitting it means "unavailable", never "not found". */
const LOOKUP_MAX_PAGES = 5;

/**
 * Look for a message this app sent with `X-RenoMeta-Send-Id: <sendId>` in
 * the account's Sent mail around `claimedAt`, following pagination. Read-only;
 * never sends. Only `found` is conclusive.
 */
export async function findSentGmailMessage(
  sender: GmailSender,
  input: { sendId: string; claimedAt: Date },
  fetchImpl: FetchLike = fetch,
): Promise<SentLookup> {
  const sendId = input.sendId.replace(/[^A-Za-z0-9-]/g, "");
  const at = Math.floor(input.claimedAt.getTime() / 1000);
  if (!sendId || !Number.isFinite(at)) return { status: "unavailable" };

  const auth = { Authorization: `Bearer ${sender.accessToken}` };
  const q = `in:sent after:${at - LOOKUP_BEFORE_S} before:${at + LOOKUP_AFTER_S}`;
  try {
    let pageToken: string | null = null;
    for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
      const url = `${GMAIL_MESSAGES_URL}?q=${encodeURIComponent(q)}&maxResults=${LOOKUP_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const listRes = await fetchImpl(url, { headers: auth });
      if (!listRes.ok) {
        console.warn("[gmail-send] Sent lookup failed", { status: listRes.status });
        return { status: "unavailable" };
      }
      const list: any = await listRes.json().catch(() => null);
      if (!list || typeof list !== "object") return { status: "unavailable" };
      const candidates: Array<{ id?: unknown; threadId?: unknown }> = Array.isArray(list.messages) ? list.messages : [];

      for (const candidate of candidates) {
        if (typeof candidate.id !== "string") continue;
        const getRes = await fetchImpl(
          `${GMAIL_MESSAGES_URL}/${encodeURIComponent(candidate.id)}?format=metadata&metadataHeaders=${SEND_ID_HEADER}`,
          { headers: auth },
        );
        if (!getRes.ok) return { status: "unavailable" };
        const message: any = await getRes.json().catch(() => ({}));
        const headers: Array<{ name?: unknown; value?: unknown }> = message?.payload?.headers ?? [];
        const match = headers.some(
          (h) => typeof h.name === "string" && h.name.toLowerCase() === SEND_ID_HEADER.toLowerCase() && String(h.value ?? "").trim() === sendId,
        );
        if (match) {
          return {
            status: "found",
            gmailMessageId: candidate.id,
            gmailThreadId: typeof message?.threadId === "string" ? message.threadId : typeof candidate.threadId === "string" ? candidate.threadId : null,
          };
        }
      }

      pageToken = typeof list.nextPageToken === "string" && list.nextPageToken ? list.nextPageToken : null;
      if (!pageToken) return { status: "not_found" };
    }
    // More pages than we're willing to read: incomplete, so inconclusive.
    return { status: "unavailable" };
  } catch {
    console.warn("[gmail-send] Sent lookup request failed");
    return { status: "unavailable" };
  }
}

/**
 * Confirm one specific message (by Gmail id) is in this account's Sent mail
 * AND carries `X-RenoMeta-Send-Id: <sendId>`. Read-only. Used as trusted,
 * server-side evidence that Gmail accepted a particular send: a stored id
 * alone (e.g. in document metadata) is not trusted until Gmail confirms it.
 */
export async function verifySentGmailMessage(
  sender: GmailSender,
  input: { gmailMessageId: string; sendId: string },
  fetchImpl: FetchLike = fetch,
): Promise<SentLookup> {
  const sendId = input.sendId.replace(/[^A-Za-z0-9-]/g, "");
  if (!sendId || !input.gmailMessageId) return { status: "unavailable" };
  try {
    const res = await fetchImpl(
      `${GMAIL_MESSAGES_URL}/${encodeURIComponent(input.gmailMessageId)}?format=metadata&metadataHeaders=${SEND_ID_HEADER}`,
      { headers: { Authorization: `Bearer ${sender.accessToken}` } },
    );
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "unavailable" };
    const message: any = await res.json().catch(() => ({}));
    const labels: unknown[] = Array.isArray(message?.labelIds) ? message.labelIds : [];
    const headers: Array<{ name?: unknown; value?: unknown }> = message?.payload?.headers ?? [];
    const matches = labels.includes("SENT") && headers.some(
      (h) => typeof h.name === "string" && h.name.toLowerCase() === SEND_ID_HEADER.toLowerCase() && String(h.value ?? "").trim() === sendId,
    );
    if (!matches) return { status: "not_found" };
    return {
      status: "found",
      gmailMessageId: input.gmailMessageId,
      gmailThreadId: typeof message?.threadId === "string" ? message.threadId : null,
    };
  } catch {
    console.warn("[gmail-send] Sent verification request failed");
    return { status: "unavailable" };
  }
}
