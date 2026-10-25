// netlify/functions/lib/test-console-access.ts
//
// Who may use the INTERNAL AI Center Test Console. Server-side only.
//
// The allowlist is the comma-separated env var AI_TEST_CONSOLE_ALLOWED_USER_IDS (authenticated Supabase user ids). It lives only
// in the server environment: nothing in this file, the access endpoint, or the gate's error responses ever returns, logs or echoes
// it. It FAILS CLOSED: an unset, empty or unparsable value allows nobody.
//
// The user id compared is always the one resolved from the verified bearer token — never anything from a request body.

export const TEST_CONSOLE_ALLOWLIST_ENV = "AI_TEST_CONSOLE_ALLOWED_USER_IDS";

/** Generic message for every denial (never reveals who is allowed or how access is configured). */
export const TEST_CONSOLE_DENIED_MESSAGE = "Test Console access is not enabled for this account.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses the env value into a set of lower-cased UUIDs. Anything that is not a UUID is ignored (so a typo can never widen access). */
export function parseTestConsoleAllowlist(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id)) out.add(id);
  }
  return out;
}

export function isTestConsoleUser(userId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (typeof userId !== "string") return false;
  const id = userId.trim().toLowerCase();
  if (!UUID.test(id)) return false;
  return parseTestConsoleAllowlist(env[TEST_CONSOLE_ALLOWLIST_ENV]).has(id);
}
