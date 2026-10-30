// src/lib/password-recovery.ts
//
// Password-recovery logic for RenoMeta Connect, kept free of React and of the Supabase client so it is unit-testable.
//
// ROOT CAUSE this module exists to fix: resetPassword() used to send the email link to /auth/callback?type=recovery. That route is the
// invite-acceptance / OAuth-return page; it never looked at type=recovery, and supabase-js (implicit flow, detectSessionInUrl on) had already
// turned the recovery tokens in the URL into an ordinary session, so handleOAuthReturn() saw "signed in + has an organization" and sent the
// user to the dashboard — a normal sign-in, with no chance to choose a new password. Nothing listened for PASSWORD_RECOVERY and no reset
// page existed.
//
// DESIGN
//   * A dedicated /reset-password page is the ONLY place a recovery session is turned into a password change.
//   * "Recovery pending" is recorded the moment a recovery link / PASSWORD_RECOVERY event is seen (localStorage, short TTL). While it is
//     pending, the root guard forces /reset-password, so no ordinary post-sign-in redirect can override the flow.
//   * Three ways a recovery arrives are handled: the legacy implicit link (#access_token=...&type=recovery), the scanner-proof token-hash link
//     (/reset-password?token_hash=...&type=recovery -> verifyOtp), and error redirects (#error_code=otp_expired ...).
//   * The recovery is BOUND to the user Supabase itself vouched for (PASSWORD_RECOVERY event / verifyOtp result), never to whatever session
//     happens to be in the browser: auth-js keeps an existing session when a URL login fails, so a forged or broken recovery link opened by a
//     signed-in user must not offer THAT user's password for change.
//   * After a successful change the session is SIGNED OUT everywhere and the user returns to sign-in: no auto-login.
//   * Nothing here reads a redirect/next parameter (no open redirect), and no token is ever logged.

export const RECOVERY_PENDING_KEY = "rm.password-recovery.pending";
/** A recovery that is not completed within this window is abandoned: its session is signed out rather than left as a login. */
export const RECOVERY_TTL_MS = 30 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
/** GoTrue hashes passwords with bcrypt, which only considers the first 72 bytes. */
export const MAX_PASSWORD_LENGTH = 72;
export const PRODUCTION_APP_URL = "https://connect.renometa.com";
export const RESET_PASSWORD_PATH = "/reset-password";

// ── URL parsing ──────────────────────────────────────────────────────────────

export type RecoveryIntent =
  | { kind: "token_hash"; tokenHash: string }       // /reset-password?token_hash=…&type=recovery  (verifyOtp on this page)
  | { kind: "session_in_url" }                      // #access_token=…&type=recovery  (supabase-js consumes it into a session)
  | { kind: "code_in_url" }                         // ?code=…&type=recovery  (PKCE; this client uses the implicit flow)
  | { kind: "error"; code: string }                 // #error=access_denied&error_code=otp_expired …
  | { kind: "none" };

const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

/** Pure: decides what a URL means for password recovery. Never returns or logs a token except the opaque token_hash the page must verify. */
export function parseRecoveryUrl(hash: string, search: string): RecoveryIntent {
  const h = new URLSearchParams((hash || "").replace(/^#/, ""));
  const s = new URLSearchParams((search || "").replace(/^\?/, ""));

  const errorCode = h.get("error_code") || s.get("error_code") || h.get("error") || s.get("error");
  if (errorCode) return { kind: "error", code: errorCode.slice(0, 64) };

  const tokenHash = s.get("token_hash");
  if (tokenHash !== null && s.get("type") === "recovery") {
    return TOKEN_HASH_PATTERN.test(tokenHash) ? { kind: "token_hash", tokenHash } : { kind: "error", code: "invalid_token" };
  }
  if (h.get("type") === "recovery" && h.get("access_token")) return { kind: "session_in_url" };
  if (s.get("type") === "recovery" && s.get("code")) return { kind: "code_in_url" };
  return { kind: "none" };
}

// ── "recovery pending" marker ────────────────────────────────────────────────

export type KeyValueStore = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export type RecoveryState = "none" | "active" | "expired";
type PendingMarker = { t: number; uid: string | null };

/**
 * userId is the account Supabase VERIFIED the recovery for (PASSWORD_RECOVERY session / verifyOtp result). It is null while the link is merely
 * seen in the URL and not yet verified — anything read from the URL itself (e.g. a JWT `sub`) is attacker-controlled and never stored here.
 */
export function markRecoveryPending(kv: KeyValueStore, now: number = Date.now(), userId: string | null = null): void {
  try { kv.setItem(RECOVERY_PENDING_KEY, JSON.stringify({ t: now, uid: userId } satisfies PendingMarker)); } catch { /* storage unavailable */ }
}
export function clearRecoveryPending(kv: KeyValueStore): void {
  try { kv.removeItem(RECOVERY_PENDING_KEY); } catch { /* ignore */ }
}
function readMarker(kv: KeyValueStore): PendingMarker | "unreadable" | null {
  let raw: string | null = null;
  try { raw = kv.getItem(RECOVERY_PENDING_KEY); } catch { return null; }
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === "object" && Number.isFinite(m.t)) return { t: m.t, uid: typeof m.uid === "string" && m.uid ? m.uid : null };
  } catch { /* fall through */ }
  return "unreadable";
}
export function getRecoveryState(kv: KeyValueStore, now: number = Date.now()): RecoveryState {
  const m = readMarker(kv);
  if (m === null) return "none";
  if (m === "unreadable") return "expired";
  return now - m.t > RECOVERY_TTL_MS ? "expired" : "active";
}
/** The user Supabase verified this recovery for, or null if it has not (yet) verified one. */
export function getRecoveryUserId(kv: KeyValueStore): string | null {
  const m = readMarker(kv);
  return m && m !== "unreadable" ? m.uid : null;
}

/** Real-storage convenience wrappers (browser only; "none" elsewhere). */
const browserStore = (): KeyValueStore | null => { try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; } };
export function readRecoveryState(): RecoveryState { const kv = browserStore(); return kv ? getRecoveryState(kv) : "none"; }
export function clearRecoveryPendingNow(): void { const kv = browserStore(); if (kv) clearRecoveryPending(kv); }

/**
 * Registered in src/lib/supabase.ts IMMEDIATELY after createClient, i.e. synchronously, before auth-js finishes initializing — so the
 * PASSWORD_RECOVERY event it emits for a recovery link in the URL can never be missed. auth-js emits that event only after it has validated
 * the URL tokens with the Auth server, so the session's user id is trustworthy and becomes the user this recovery is bound to.
 * (Runs inside the auth lock: it must not call back into supabase.auth.)
 */
export function installRecoveryListener(
  auth: { onAuthStateChange(cb: (event: string, session: SessionLike) => void): unknown },
  kv: KeyValueStore | null = browserStore(),
): void {
  if (!kv) return;
  auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session?.user?.id) markRecoveryPending(kv, Date.now(), session.user.id);
    else if (event === "SIGNED_OUT") clearRecoveryPending(kv);
  });
}

/**
 * Called ONCE, before the Supabase client is created (src/lib/supabase.ts): supabase-js consumes and removes the recovery tokens from the URL
 * during its own initialization, so the intent has to be read first. Records "recovery pending" for the implicit/PKCE link shapes; a
 * token_hash link is marked only after it verifies (see bootstrapRecovery).
 */
let capturedIntent: RecoveryIntent = { kind: "none" };
export function captureRecoveryIntent(win?: { location: { hash: string; search: string } } | null, kv?: KeyValueStore | null): RecoveryIntent {
  const w = win ?? (typeof window !== "undefined" ? window : null);
  if (!w) return capturedIntent;
  capturedIntent = parseRecoveryUrl(w.location.hash, w.location.search);
  const store = kv ?? browserStore();
  // Pending but NOT yet bound to a user: that happens only when Supabase verifies the tokens (installRecoveryListener). A ?code= link is not
  // marked — with the implicit flow auth-js ignores it, so marking it would only trap an already signed-in user on the reset page.
  if (store && capturedIntent.kind === "session_in_url") markRecoveryPending(store);
  return capturedIntent;
}
export function getCapturedRecoveryIntent(): RecoveryIntent { return capturedIntent; }
/** Test helper. */
export function __resetCapturedRecoveryIntent(): void { capturedIntent = { kind: "none" }; }

// ── route decision (used by the root guard) ──────────────────────────────────

export type RecoveryRouteDecision = "proceed" | "go_reset" | "abandon" | "hold";

/**
 * What the root guard must do BEFORE any ordinary sign-in/role redirect:
 *   "go_reset"  a recovery is pending and the user is elsewhere  -> navigate to /reset-password
 *   "hold"      same situation, while the redirect happens       -> render nothing from the app (no flash of the dashboard)
 *   "abandon"   a recovery was left unfinished past its TTL      -> sign the recovery session out
 *   "proceed"   no recovery in play                              -> the normal guards run unchanged
 * A signed-OUT visitor is never affected (a pending marker without a session is ignored).
 */
export function recoveryRouteDecision(input: { hasSession: boolean; state: RecoveryState; pathname: string }): RecoveryRouteDecision {
  if (!input.hasSession) return "proceed";
  if (input.state === "expired") return "abandon";
  if (input.state === "active" && !input.pathname.startsWith(RESET_PASSWORD_PATH)) return "go_reset";
  return "proceed";
}

// ── redirect URL for the reset email ─────────────────────────────────────────

/**
 * Where the emailed link must land. Always the canonical production host unless the page itself is running on localhost or a Netlify
 * preview (so previews can be tested). Derived only from the page's own location — never from user input — and Supabase additionally
 * validates it against the project's Redirect URLs allow-list.
 */
export function recoveryRedirectUrl(loc: { origin: string; hostname: string }): string {
  const host = loc.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  const preview = host.endsWith(".netlify.app");
  const base = host === "connect.renometa.com" || local || preview ? loc.origin : PRODUCTION_APP_URL;
  return `${base}${RESET_PASSWORD_PATH}`;
}

// ── validation + friendly errors ─────────────────────────────────────────────

export type PasswordFieldErrors = { password?: string; confirm?: string };

export function validateNewPassword(password: string, confirm: string): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {};
  if (!password) errors.password = "Enter a new password.";
  else if (password.trim() === "") errors.password = "Your password can't be only spaces.";
  else if (password.length < MIN_PASSWORD_LENGTH) errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (new TextEncoder().encode(password).length > MAX_PASSWORD_LENGTH) errors.password = `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (!confirm) errors.confirm = "Confirm your new password.";
  else if (!errors.password && confirm !== password) errors.confirm = "Passwords don't match.";
  return errors;
}

export type RecoveryProblem = "expired" | "invalid" | "missing";

export const LINK_PROBLEM_MESSAGES: Record<RecoveryProblem, string> = {
  expired: "This reset link has expired or has already been used. Request a new one to continue.",
  invalid: "This reset link isn't valid. Request a new one to continue.",
  missing: "Open the reset link from your email to choose a new password, or request a new one.",
};

export function problemFromErrorCode(code: string): RecoveryProblem {
  return /otp_expired|access_denied|expired|used|flow_state/i.test(code) ? "expired" : "invalid";
}

type AuthErrorLike = { message?: string; code?: string; status?: number; name?: string } | null | undefined;

/** Maps a Supabase Auth error from updateUser() to an end-user message. Raw provider text is never shown. */
export function describePasswordUpdateError(err: AuthErrorLike): { message: string; linkProblem?: RecoveryProblem } {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  const status = Number(err?.status ?? 0);
  if (code === "same_password" || /different from the old/i.test(msg)) return { message: "Choose a password you haven't used before." };
  if (code === "weak_password" || /weak|pwned|compromised|easy to guess/i.test(msg)) return { message: "That password is too easy to guess. Try a longer or less common one." };
  if (code === "session_not_found" || code === "otp_expired" || /jwt|session|expired|not authenticated|auth session missing/i.test(msg) || status === 401 || status === 403) {
    return { message: LINK_PROBLEM_MESSAGES.expired, linkProblem: "expired" };
  }
  if (code === "over_request_rate_limit" || status === 429) return { message: "Too many attempts. Wait a minute and try again." };
  if (/failed to fetch|network|load failed/i.test(msg)) return { message: "We couldn't reach the server. Check your connection and try again." };
  return { message: "We couldn't update your password. Please try again." };
}

// ── the flow, against an injected auth client ────────────────────────────────

type SessionLike = { user?: { id?: string | null; email?: string | null } | null } | null;
export interface RecoveryAuth {
  getSession(): Promise<{ data: { session: SessionLike } }>;
  verifyOtp(p: { token_hash: string; type: "recovery" }): Promise<{ data: { session: SessionLike }; error: AuthErrorLike }>;
  updateUser(a: { password: string }): Promise<{ error: AuthErrorLike }>;
  signOut(o?: { scope?: "global" | "local" | "others" }): Promise<{ error: AuthErrorLike }>;
  onAuthStateChange(cb: (event: string, session: SessionLike) => void): { data: { subscription: { unsubscribe(): void } } };
}

export type RecoveryBootstrap = { status: "ready"; userId: string; email: string | null } | { status: "invalid"; problem: RecoveryProblem };

export async function bootstrapRecovery(
  auth: RecoveryAuth,
  intent: RecoveryIntent,
  kv: KeyValueStore,
  opts: { now?: number; waitMs?: number } = {},
): Promise<RecoveryBootstrap> {
  const now = opts.now ?? Date.now();
  if (intent.kind === "error") return { status: "invalid", problem: problemFromErrorCode(intent.code) };

  if (intent.kind === "token_hash") {
    const { data, error } = await auth.verifyOtp({ token_hash: intent.tokenHash, type: "recovery" });
    if (error || !data?.session) return { status: "invalid", problem: "expired" };   // consumed (reused / pre-fetched by a scanner) or expired
    const userId = data.session.user?.id;
    if (!userId) return { status: "invalid", problem: "invalid" };
    markRecoveryPending(kv, now, userId);
    return { status: "ready", userId, email: data.session.user?.email ?? null };
  }

  if (intent.kind === "code_in_url") return { status: "invalid", problem: "invalid" };   // PKCE codes need a verifier this client never created

  const state = getRecoveryState(kv, now);
  if (state === "expired") {
    clearRecoveryPending(kv);
    try { await auth.signOut({ scope: "local" }); } catch { /* ignore */ }
    return { status: "invalid", problem: "expired" };
  }
  if (state === "none") return { status: "invalid", problem: "missing" };

  // Pending: auth-js turns the URL tokens into a session during startup and, once it has VERIFIED them, emits PASSWORD_RECOVERY, which binds the
  // marker to that user (installRecoveryListener). Only a session belonging to that verified user may proceed. If the tokens were forged,
  // broken or stale, auth-js keeps whatever session was already in the browser — that unrelated user must NOT get a password form.
  const verified = async (): Promise<{ userId: string; email: string | null } | null> => {
    const uid = getRecoveryUserId(kv);
    if (!uid) return null;
    const session = (await auth.getSession()).data.session;
    return session?.user?.id === uid ? { userId: uid, email: session.user.email ?? null } : null;
  };
  let result = await verified();
  if (!result) {
    // the PASSWORD_RECOVERY event is dispatched just after auth-js finishes initializing: give it a moment to bind the marker
    const deadline = Date.now() + (opts.waitMs ?? 4000);
    while (!result && Date.now() < deadline && getRecoveryState(kv) === "active") {
      await new Promise((r) => setTimeout(r, 50));
      if (getRecoveryUserId(kv)) result = await verified();
    }
  }
  if (result) return { status: "ready", ...result };

  // Not verified. Drop the marker so no redirect keeps forcing this page. A session that is not the recovery's is left alone (it is someone's
  // ordinary login); no session at all simply means the link did not work.
  const hasSession = !!(await auth.getSession()).data.session;
  clearRecoveryPending(kv);
  return { status: "invalid", problem: hasSession ? "invalid" : "expired" };
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; fieldErrors?: PasswordFieldErrors; message?: string; linkProblem?: RecoveryProblem };

/**
 * Validates, requires the recovery session of the user bootstrapRecovery verified (expectedUserId must still be the current session AND the
 * user the pending recovery is bound to — another tab may have switched accounts meanwhile), updates the password, then signs the user OUT
 * everywhere (no auto-login).
 */
export async function submitNewPassword(
  auth: RecoveryAuth, kv: KeyValueStore, expectedUserId: string, password: string, confirm: string,
): Promise<SubmitResult> {
  const fieldErrors = validateNewPassword(password, confirm);
  if (fieldErrors.password || fieldErrors.confirm) return { ok: false, fieldErrors };

  const { data: { session } } = await auth.getSession();
  if (!expectedUserId || session?.user?.id !== expectedUserId || getRecoveryUserId(kv) !== expectedUserId) {
    clearRecoveryPending(kv);
    return { ok: false, message: LINK_PROBLEM_MESSAGES.expired, linkProblem: "expired" };
  }

  const { error } = await auth.updateUser({ password });
  if (error) {
    const d = describePasswordUpdateError(error);
    if (d.linkProblem) clearRecoveryPending(kv);
    return { ok: false, message: d.message, ...(d.linkProblem ? { linkProblem: d.linkProblem } : {}) };
  }

  clearRecoveryPending(kv);
  try {
    const { error: outErr } = await auth.signOut({ scope: "global" });
    if (outErr) await auth.signOut({ scope: "local" });
  } catch {
    try { await auth.signOut({ scope: "local" }); } catch { /* the password IS changed; sign-in will simply ask for it */ }
  }
  return { ok: true };
}

/** The user backs out: the recovery session is not left behind as a login. */
export async function cancelRecovery(auth: RecoveryAuth, kv: KeyValueStore): Promise<void> {
  clearRecoveryPending(kv);
  try { await auth.signOut({ scope: "local" }); } catch { /* ignore */ }
}
