// tests/netlify-functions/support/gmail-stub.ts
//
// Shared by the estimate-send / change-order-send handler tests: a global
// fetch stub that answers Google's tokeninfo/token endpoints and Gmail's
// users.messages.send with canned responses (recording every request), plus a
// seeded `integrations` row for a connected Gmail account. Accepted messages
// land in an in-memory Sent mailbox that users.messages.list/get answer from,
// so Sent-mail reconciliation can be exercised. Nothing here can reach the
// network, so no real email is ever sent.

import { encryptToBytea } from "../../../netlify/functions/lib/gmail-token-crypto.ts";

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
export const OAUTH_CLIENT_ID = "client-123.apps.googleusercontent.com";

process.env.ENCRYPTION_KEY = "test-only-encryption-key";
process.env.GOOGLE_OAUTH_CLIENT_ID = OAUTH_CLIENT_ID;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-only-client-secret";

export type StubCall = { url: string; method: string; body: string };
/**
 * One canned send outcome. `accept: true` puts the message in the Sent
 * mailbox even though the response says otherwise — Gmail accepted it, but
 * the reply was a 5xx (`status`) or never arrived (`network: true`).
 */
export type StubSend = { status?: number; body?: unknown; accept?: boolean; network?: boolean };
export type GmailStubConfig = {
  scope: string;
  refresh: { status: number; body: unknown };
  send: StubSend[];
  /** users.messages.list response status; anything but 200 makes Sent-mail search unavailable. */
  searchStatus: number;
  /** Results per users.messages.list page (pagination via nextPageToken). */
  searchPageSize: number;
  /** False simulates Gmail's search-index lag: newly accepted messages aren't listed until `indexed` is set. */
  indexNewMessages: boolean;
};
export type SentMessage = { id: string; threadId: string; sendId: string | null; mime: string; indexed: boolean };

export const gmailStub = {
  calls: [] as StubCall[],
  /** Every message Gmail accepted (including ones whose response was lost). */
  mailbox: [] as SentMessage[],
  config: null as unknown as GmailStubConfig,
  /** Decoded MIME of every users.messages.send request, in order. */
  get sentMime(): string[] {
    return this.calls
      .filter((c) => c.url === GMAIL_SEND_URL)
      .map((c) => Buffer.from(JSON.parse(c.body).raw, "base64url").toString("utf8"));
  },
  get workflowCalls(): StubCall[] {
    return this.calls.filter((c) => c.url.includes("execute-workflow"));
  },
  reset(config: Partial<GmailStubConfig> = {}) {
    this.calls.length = 0;
    this.mailbox.length = 0;
    this.config = {
      scope: SEND_SCOPE,
      refresh: { status: 200, body: { access_token: "refreshed-access-token", expires_in: 3599 } },
      send: [],
      searchStatus: 200,
      searchPageSize: 1000,
      indexNewMessages: true,
      ...config,
    };
  },
};
gmailStub.reset();

let sendCounter = 0;
export function installFetchStub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    gmailStub.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    if (url.includes("oauth2.googleapis.com/tokeninfo")) {
      return new Response(JSON.stringify({ scope: gmailStub.config.scope, aud: OAUTH_CLIENT_ID }), { status: 200 });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify(gmailStub.config.refresh.body), { status: gmailStub.config.refresh.status });
    }
    if (url === GMAIL_SEND_URL) {
      const next = gmailStub.config.send.shift();
      sendCounter += 1;
      const id = `gm-msg-${sendCounter}`;
      const threadId = `gm-thr-${sendCounter}`;
      const mime = Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString("utf8");
      if (!next || next.accept) {
        const sendId = /^X-RenoMeta-Send-Id: ([A-Za-z0-9-]+)\r?$/m.exec(mime)?.[1] ?? null;
        gmailStub.mailbox.push({ id, threadId, sendId, mime, indexed: gmailStub.config.indexNewMessages });
      }
      if (next?.network) throw new TypeError("fetch failed");
      if (next && next.status !== undefined) return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
      return new Response(JSON.stringify({ id, threadId, labelIds: ["SENT"] }), { status: 200 });
    }
    if (url.startsWith(`${GMAIL_MESSAGES_URL}?`)) {
      if (gmailStub.config.searchStatus !== 200) {
        return new Response(JSON.stringify({ error: { code: gmailStub.config.searchStatus } }), { status: gmailStub.config.searchStatus });
      }
      const listed = gmailStub.mailbox.filter((m) => m.indexed);
      const offset = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      const size = gmailStub.config.searchPageSize;
      const page = listed.slice(offset, offset + size);
      const next = offset + size < listed.length ? String(offset + size) : undefined;
      return new Response(JSON.stringify({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next }), { status: 200 });
    }
    if (url.startsWith(`${GMAIL_MESSAGES_URL}/`)) {
      const id = decodeURIComponent(url.slice(GMAIL_MESSAGES_URL.length + 1).split("?")[0]);
      const message = gmailStub.mailbox.find((m) => m.id === id);
      if (!message) return new Response("{}", { status: 404 });
      const headers = message.sendId ? [{ name: "X-RenoMeta-Send-Id", value: message.sendId }] : [];
      return new Response(JSON.stringify({ id, threadId: message.threadId, labelIds: ["SENT"], payload: { headers } }), { status: 200 });
    }
    if (url.includes("amazonaws.com")) throw new Error("AWS must never be called for customer email");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

export function gmailIntegration(orgId: string, over: Record<string, unknown> = {}) {
  return {
    id: `int-${orgId.slice(0, 4)}`,
    org_id: orgId,
    provider: "gmail",
    status: "connected",
    access_token_encrypted: encryptToBytea("live-access-token"),
    refresh_token_encrypted: encryptToBytea("refresh-token-1"),
    token_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    provider_account_email: "owner@acmeremodeling.com",
    ...over,
  };
}

export const expiredAt = () => new Date(Date.now() - 60 * 1000).toISOString();
