// src/lib/password-recovery.test.ts
//
// Run:  node --test src/lib/password-recovery.test.ts
//
// Password recovery: the Forgot Password submission, recovery-link parsing, recovery-session establishment, protection against ordinary auth
// redirects, password validation / confirmation, the password update, expired / invalid / reused links, a user who is already signed in, and
// recovery from a fresh browser. The REAL logic and view run against a fake auth client and a stubbed Supabase client — no network, no Supabase.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "password-recovery-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// auth.ts imports "./supabase" (which needs Vite env vars and a browser); tests substitute a recording stub.
const stubSupabase = {
  name: "stub-supabase",
  setup(build: any) {
    build.onResolve({ filter: /^\.\/supabase$/ }, () => ({ path: "stub-supabase", namespace: "stub" }));
    build.onLoad({ filter: /^stub-supabase$/, namespace: "stub" }, () => ({ contents: `export const supabase = new Proxy({}, { get: (_t, p) => globalThis.__sb[p] });`, loader: "js" }));
  },
};
const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from "react-dom/server";
      import { createElement } from "react";
      export { renderToStaticMarkup, createElement };
      export * from "./src/lib/password-recovery";
      export { ResetPasswordView, NewPasswordForm } from "./src/components/auth/reset-password-view";
      export { resetPassword } from "./src/lib/auth";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error", jsx: "automatic",
  alias: { "@": path.join(repoRoot, "src") }, loader: { ".png": "dataurl" }, plugins: [stubSupabase],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const R: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// ── fakes ────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
class MemoryStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
type Session = { user: { id: string; email: string } } | null;
const as = (id: string, email = `${id}@example.com`): Session => ({ user: { id, email } });
function fakeAuth(opts: { session?: Session; verifyError?: any; updateError?: any; signOutGlobalError?: any } = {}) {
  const calls: Array<{ fn: string; arg?: any }> = [];
  let session: Session = opts.session ?? null;
  let listener: ((e: string, s: Session) => void) | null = null;
  const auth: any = {
    calls,
    async getSession() { calls.push({ fn: "getSession" }); return { data: { session } }; },
    async verifyOtp(p: any) {
      calls.push({ fn: "verifyOtp", arg: p });
      if (opts.verifyError) return { data: { session: null }, error: opts.verifyError };
      session = as("u-owner", "owner@example.com");
      return { data: { session }, error: null };
    },
    async updateUser(a: any) { calls.push({ fn: "updateUser", arg: a }); return { error: opts.updateError ?? null }; },
    async signOut(o?: any) { calls.push({ fn: "signOut", arg: o }); if (o?.scope === "global" && opts.signOutGlobalError) return { error: opts.signOutGlobalError }; session = null; return { error: null }; },
    onAuthStateChange(cb: any) {
      calls.push({ fn: "onAuthStateChange" });
      listener = cb;
      return { data: { subscription: { unsubscribe() { calls.push({ fn: "unsubscribe" }); listener = null; } } } };
    },
    emit(event: string, s: Session) { listener?.(event, s); },
  };
  return auth;
}
/** A pending recovery that Supabase has verified for `uid` (what installRecoveryListener / verifyOtp record). */
const boundStore = (uid: string, t = NOW) => { const kv = new MemoryStore(); R.markRecoveryPending(kv, t, uid); return kv; };
const fns = (a: any) => a.calls.map((c: any) => c.fn);

// ── URL parsing ──────────────────────────────────────────────────────────

test("parse — implicit recovery link (#access_token…&type=recovery) -> session_in_url; the legacy ?type=recovery hint is not required", () => {
  assert.deepEqual(R.parseRecoveryUrl("#access_token=abc&refresh_token=def&expires_in=3600&token_type=bearer&type=recovery", ""), { kind: "session_in_url" });
  assert.deepEqual(R.parseRecoveryUrl("#access_token=abc&type=recovery", "?type=recovery"), { kind: "session_in_url" });
  assert.deepEqual(R.parseRecoveryUrl("", "?type=recovery"), { kind: "none" }, "the hint alone proves nothing");
});

test("parse — token-hash link (scanner-proof) -> token_hash; a malformed hash is rejected", () => {
  assert.deepEqual(R.parseRecoveryUrl("", "?token_hash=pkce_0123456789abcdef&type=recovery"), { kind: "token_hash", tokenHash: "pkce_0123456789abcdef" });
  assert.equal(R.parseRecoveryUrl("", "?token_hash=pkce_0123456789abcdef&type=signup").kind, "none", "only type=recovery");
  for (const bad of ["x", "has space aaaaaaaa", "<script>alert(1)</script>", "a".repeat(300), "../../etc/passwd"]) {
    assert.equal(R.parseRecoveryUrl("", `?token_hash=${encodeURIComponent(bad)}&type=recovery`).kind, "error", bad);
  }
});

test("parse — expired / used / denied links arrive as error redirects and win over everything else", () => {
  assert.deepEqual(R.parseRecoveryUrl("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", ""), { kind: "error", code: "otp_expired" });
  assert.deepEqual(R.parseRecoveryUrl("", "?error=access_denied"), { kind: "error", code: "access_denied" });
  assert.equal(R.parseRecoveryUrl("#error_code=otp_expired&access_token=abc&type=recovery", "").kind, "error");
  assert.equal(R.parseRecoveryUrl("", "").kind, "none");
  assert.equal(R.parseRecoveryUrl("#type=signup&access_token=abc", "").kind, "none", "an ordinary sign-up / magic link is not a recovery");
  assert.equal(R.parseRecoveryUrl("", "?code=abc&type=recovery").kind, "code_in_url");
});

test("capture — runs before supabase-js: an implicit link marks recovery pending (unbound); nothing else does (token_hash is marked only after it verifies)", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["#access_token=a&type=recovery", "", "session_in_url", true],
    ["", "?code=abc&type=recovery", "code_in_url", false],
    ["", "?token_hash=pkce_0123456789abcdef&type=recovery", "token_hash", false],
    ["#error_code=otp_expired", "", "error", false],
    ["", "", "none", false],
    ["#access_token=a&type=signup", "", "none", false],
  ];
  for (const [hash, search, kind, pending] of cases) {
    R.__resetCapturedRecoveryIntent();
    const kv = new MemoryStore();
    assert.equal(R.captureRecoveryIntent({ location: { hash, search } }, kv).kind, kind, `${hash}${search}`);
    assert.equal(R.getRecoveryState(kv, NOW) === "active" || R.getRecoveryState(kv, Date.now()) === "active", pending, `${hash}${search}`);
    assert.equal(R.getCapturedRecoveryIntent().kind, kind);
    assert.equal(R.getRecoveryUserId(kv), null, "the URL alone never binds the recovery to a user (a JWT sub in the URL is attacker-controlled)");
  }
});

test("listener — only a VERIFIED PASSWORD_RECOVERY binds the recovery to its user; SIGNED_OUT clears it; other events change nothing", () => {
  const kv = new MemoryStore();
  const auth = fakeAuth();
  R.installRecoveryListener(auth, kv);
  auth.emit("SIGNED_IN", as("u-a"));
  assert.equal(R.getRecoveryState(kv), "none", "an ordinary sign-in is not a recovery");
  auth.emit("PASSWORD_RECOVERY", as("u-b"));
  assert.equal(R.getRecoveryState(kv), "active");
  assert.equal(R.getRecoveryUserId(kv), "u-b");
  auth.emit("TOKEN_REFRESHED", as("u-b"));
  assert.equal(R.getRecoveryUserId(kv), "u-b");
  auth.emit("SIGNED_OUT", null);
  assert.equal(R.getRecoveryState(kv), "none");
});

// ── pending marker ───────────────────────────────────────────────────────

test("pending marker — active within the TTL, expired after it, none when absent or storage is unavailable", () => {
  const kv = new MemoryStore();
  assert.equal(R.getRecoveryState(kv, NOW), "none");
  R.markRecoveryPending(kv, NOW);
  assert.equal(R.getRecoveryState(kv, NOW + 1000), "active");
  assert.equal(R.getRecoveryState(kv, NOW + R.RECOVERY_TTL_MS), "active");
  assert.equal(R.getRecoveryState(kv, NOW + R.RECOVERY_TTL_MS + 1), "expired");
  assert.equal(R.getRecoveryUserId(kv), null);
  R.markRecoveryPending(kv, NOW, "u-1");
  assert.equal(R.getRecoveryUserId(kv), "u-1");
  kv.setItem(R.RECOVERY_PENDING_KEY, "garbage");
  assert.equal(R.getRecoveryState(kv, NOW), "expired");
  assert.equal(R.getRecoveryUserId(kv), null);
  R.clearRecoveryPending(kv);
  assert.equal(R.getRecoveryState(kv, NOW), "none");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  assert.equal(R.getRecoveryState(broken, NOW), "none");
  R.markRecoveryPending(broken, NOW); R.clearRecoveryPending(broken);
});

// ── protection against ordinary auth redirects ───────────────────────────

test("route decision — while a recovery is pending, a signed-in user is held on /reset-password and cannot be sent to the dashboard / sign-in redirects", () => {
  const d = R.recoveryRouteDecision;
  // the original bug: a recovery session on /auth/callback, /, /signin or any app page
  for (const pathname of ["/auth/callback", "/", "/signin", "/onboarding", "/inbox", "/settings/team"]) {
    assert.equal(d({ hasSession: true, state: "active", pathname }), "go_reset", pathname);
  }
  assert.equal(d({ hasSession: true, state: "active", pathname: "/reset-password" }), "proceed", "the reset page itself renders");
  // not in play
  assert.equal(d({ hasSession: true, state: "none", pathname: "/" }), "proceed", "an ordinary signed-in user is unaffected");
  assert.equal(d({ hasSession: true, state: "none", pathname: "/signin" }), "proceed");
  assert.equal(d({ hasSession: false, state: "active", pathname: "/" }), "proceed", "a stale marker without a session changes nothing");
  // abandoned
  assert.equal(d({ hasSession: true, state: "expired", pathname: "/" }), "abandon");
  assert.equal(d({ hasSession: true, state: "expired", pathname: "/reset-password" }), "abandon");
});

test("route decision is wired BEFORE every ordinary redirect in the root guard, the reset page is public, and AppShell treats it as an auth page", () => {
  const root = read("src/routes/__root.tsx");
  assert.match(root, /const PUBLIC_ROUTES\s*=\s*\[[^\]]*"\/reset-password"[^\]]*\]/);
  const effect = root.slice(root.indexOf("// Redirect unauthenticated users"), root.indexOf("if (!checked) {"));
  const iDecision = effect.indexOf("recoveryRouteDecision");
  const iSignin = effect.indexOf('navigate({ to: "/signin" })');
  const iHome = effect.indexOf('navigate({ to: "/" })');
  assert.ok(iDecision > 0 && iSignin > iDecision && iHome > iDecision, "recovery precedence must come first");
  assert.match(effect, /go_reset[\s\S]*navigate\(\{ to: RESET_PASSWORD_PATH, replace: true \}\)/);
  assert.match(root, /holdForRecovery[\s\S]*Loader2/, "no flash of the app while the redirect happens");
  assert.match(read("src/components/layout/app-shell.tsx"), /pathname === "\/reset-password"/);
  // already-sent recovery emails still point at /auth/callback?type=recovery: that route must hand them to the reset page, not sign the user in
  const cb = read("src/routes/auth.callback.tsx");
  assert.match(cb, /readRecoveryState\(\) === "active" \|\| new URLSearchParams\(window\.location\.search\)\.get\("type"\) === "recovery"/);
  assert.ok(cb.indexOf("RESET_PASSWORD_PATH") < cb.indexOf("handleOAuthReturn();"), "the recovery hand-off precedes handleOAuthReturn()");
});

// ── recovery-session establishment ───────────────────────────────────────

test("bootstrap — FRESH BROWSER: implicit link, session established from the URL and verified by Supabase -> ready (no prior login needed); updateUser is not called yet", async () => {
  const kv = boundStore("u-owner");
  const auth = fakeAuth({ session: as("u-owner", "owner@example.com") });
  const r = await R.bootstrapRecovery(auth, { kind: "session_in_url" }, kv, { now: NOW + 1000 });
  assert.deepEqual(r, { status: "ready", userId: "u-owner", email: "owner@example.com" });
  assert.deepEqual(fns(auth), ["getSession"]);
});

test("bootstrap — Supabase may still be initializing: the verification (PASSWORD_RECOVERY) is awaited, then ready; if it never comes the link is treated as expired", async () => {
  const kv = new MemoryStore(); R.markRecoveryPending(kv, Date.now());       // captured from the URL, not yet verified
  const auth = fakeAuth({ session: as("u-late") });
  setTimeout(() => R.markRecoveryPending(kv, Date.now(), "u-late"), 20);  // installRecoveryListener on PASSWORD_RECOVERY
  assert.deepEqual(await R.bootstrapRecovery(auth, { kind: "session_in_url" }, kv, { waitMs: 1000 }), { status: "ready", userId: "u-late", email: "u-late@example.com" });
  const kv2 = new MemoryStore(); R.markRecoveryPending(kv2, Date.now());
  assert.deepEqual(await R.bootstrapRecovery(fakeAuth({ session: null }), { kind: "session_in_url" }, kv2, { waitMs: 60 }), { status: "invalid", problem: "expired" });
  assert.equal(R.getRecoveryState(kv2), "none", "a dead recovery does not linger as pending");
});

test("bootstrap — token-hash link: verified exactly once, binds the recovery to the verified user, session established", async () => {
  const kv = new MemoryStore();
  const auth = fakeAuth();
  const r = await R.bootstrapRecovery(auth, { kind: "token_hash", tokenHash: "pkce_0123456789abcdef" }, kv, { now: NOW });
  assert.deepEqual(r, { status: "ready", userId: "u-owner", email: "owner@example.com" });
  assert.deepEqual(auth.calls.filter((c: any) => c.fn === "verifyOtp").map((c: any) => c.arg), [{ token_hash: "pkce_0123456789abcdef", type: "recovery" }]);
  assert.equal(R.getRecoveryState(kv, NOW), "active");
  assert.equal(R.getRecoveryUserId(kv), "u-owner");
});

// ── a recovery link must never expose an UNRELATED signed-in user's password ──

test("bootstrap — SIGNED-IN user opens a forged / broken recovery link: auth-js keeps their session, but they get NO password form and are not signed out", async () => {
  // auth-js 2.x: "Don't remove existing session on URL login failure" — so after #access_token=<forged>&type=recovery the browser still holds A.
  const kv = new MemoryStore(); R.markRecoveryPending(kv, Date.now());       // captured from the URL; Supabase never verified it
  const auth = fakeAuth({ session: as("u-a", "a@example.com") });
  const r = await R.bootstrapRecovery(auth, { kind: "session_in_url" }, kv, { waitMs: 80 });
  assert.deepEqual(r, { status: "invalid", problem: "invalid" });
  assert.ok(!fns(auth).includes("updateUser") && !fns(auth).includes("signOut"), "A's password is untouchable and A's ordinary login is left alone");
  assert.equal(R.getRecoveryState(kv), "none", "no redirect keeps forcing A onto the reset page");
});

test("bootstrap — a recovery verified for B while the browser session is A (e.g. another tab switched accounts) is refused", async () => {
  const kv = boundStore("u-b", Date.now());
  const r = await R.bootstrapRecovery(fakeAuth({ session: as("u-a") }), { kind: "session_in_url" }, kv, { waitMs: 80 });
  assert.deepEqual(r, { status: "invalid", problem: "invalid" });
});

test("submit — the password changes ONLY for the verified recovering user: a different current session, or a marker bound to someone else, is refused", async () => {
  const pw = "a brand new password";
  const swapped = fakeAuth({ session: as("u-a") });                        // the session changed to A after B's recovery was verified
  const r1 = await R.submitNewPassword(swapped, boundStore("u-b"), "u-b", pw, pw);
  assert.equal(r1.ok, false); assert.equal(r1.linkProblem, "expired");
  assert.ok(!fns(swapped).includes("updateUser"));
  const rebound = fakeAuth({ session: as("u-b") });                        // B's session, but the pending recovery now belongs to C
  assert.equal((await R.submitNewPassword(rebound, boundStore("u-c"), "u-b", pw, pw)).ok, false);
  assert.ok(!fns(rebound).includes("updateUser"));
  const unbound = fakeAuth({ session: as("u-b") });                        // nothing was ever verified
  assert.equal((await R.submitNewPassword(unbound, new MemoryStore(), "", pw, pw)).ok, false);
  assert.ok(!fns(unbound).includes("updateUser"));
});

// ── expired / invalid / reused links ─────────────────────────────────────

test("bootstrap — expired, reused (or scanner-consumed) and invalid links produce a friendly state and never reach updateUser", async () => {
  const kv = new MemoryStore();
  const used = fakeAuth({ verifyError: { code: "otp_expired", message: "Email link is invalid or has expired" } });
  assert.deepEqual(await R.bootstrapRecovery(used, { kind: "token_hash", tokenHash: "pkce_0123456789abcdef" }, kv, { now: NOW }), { status: "invalid", problem: "expired" });
  assert.equal(R.getRecoveryState(kv, NOW), "none");
  const a1 = fakeAuth();
  assert.deepEqual(await R.bootstrapRecovery(a1, { kind: "error", code: "otp_expired" }, kv, { now: NOW }), { status: "invalid", problem: "expired" });
  assert.deepEqual(await R.bootstrapRecovery(a1, { kind: "error", code: "access_denied" }, kv, { now: NOW }), { status: "invalid", problem: "expired" });
  assert.deepEqual(await R.bootstrapRecovery(a1, { kind: "error", code: "invalid_token" }, kv, { now: NOW }), { status: "invalid", problem: "invalid" });
  assert.deepEqual(fns(a1), [], "an error redirect makes no auth call at all");
  assert.deepEqual(await R.bootstrapRecovery(fakeAuth(), { kind: "code_in_url" }, kv, { now: NOW }), { status: "invalid", problem: "invalid" });
});

test("bootstrap — ALREADY SIGNED IN without a recovery link: the reset page does not let a normal session change the password", async () => {
  const kv = new MemoryStore();                                         // nothing pending: this is an ordinary visit to /reset-password
  const auth = fakeAuth({ session: as("u-signed-in") });
  const r = await R.bootstrapRecovery(auth, { kind: "none" }, kv, { now: NOW });
  assert.deepEqual(r, { status: "invalid", problem: "missing" });
  assert.ok(!fns(auth).includes("updateUser") && !fns(auth).includes("getSession"), "no session is consulted, nothing is changed");
  // a real recovery link: Supabase replaced the session with the link's user and verified it — that user, shown on the form, is the one reset
  const withLink = await R.bootstrapRecovery(fakeAuth({ session: as("u-rec", "recovering@example.com") }), { kind: "session_in_url" }, boundStore("u-rec"), { now: NOW });
  assert.deepEqual(withLink, { status: "ready", userId: "u-rec", email: "recovering@example.com" });
});

test("bootstrap — a recovery left unfinished past its TTL is abandoned: the recovery session is signed out, not kept as a login", async () => {
  const kv = boundStore("u-owner");
  const auth = fakeAuth({ session: as("u-owner") });
  const r = await R.bootstrapRecovery(auth, { kind: "session_in_url" }, kv, { now: NOW + R.RECOVERY_TTL_MS + 5 });
  assert.deepEqual(r, { status: "invalid", problem: "expired" });
  assert.deepEqual(auth.calls.filter((c: any) => c.fn === "signOut").map((c: any) => c.arg), [{ scope: "local" }]);
  assert.equal(R.getRecoveryState(kv, NOW), "none");
});

// ── validation + confirmation ────────────────────────────────────────────

test("validation — required, minimum length, only-spaces, maximum bytes, and the confirmation must match", () => {
  const v = R.validateNewPassword;
  assert.deepEqual(v("", ""), { password: "Enter a new password.", confirm: "Confirm your new password." });
  assert.equal(v("short", "short").password, "Password must be at least 8 characters.");
  assert.equal(v("        ", "        ").password, "Your password can't be only spaces.");
  assert.match(v("a".repeat(73), "a".repeat(73)).password, /72 characters or fewer/);
  assert.match(v("é".repeat(40), "é".repeat(40)).password, /72 characters or fewer/, "the 72 limit is in BYTES (bcrypt)");
  assert.deepEqual(v("correct horse battery", "correct horse batterX"), { confirm: "Passwords don't match." });
  assert.deepEqual(v("correct horse battery", "correct horse battery"), {});
  assert.deepEqual(v("exactly8!", ""), { confirm: "Confirm your new password." });
});

// ── the update ───────────────────────────────────────────────────────────

test("submit — invalid input never touches the network or the session", async () => {
  const kv = boundStore("u-o"); const auth = fakeAuth({ session: as("u-o") });
  const r = await R.submitNewPassword(auth, kv, "u-o", "short", "different");
  assert.equal(r.ok, false);
  assert.ok(r.fieldErrors.password);
  assert.deepEqual(fns(auth), []);
  assert.equal((await R.submitNewPassword(auth, kv, "u-o", "long enough pw", "another long pw")).fieldErrors.confirm, "Passwords don't match.");
  assert.deepEqual(fns(auth), []);
});

test("submit — updateUser runs ONLY after a recovery session exists; success signs the user OUT everywhere (no auto-login) and clears the marker", async () => {
  const kv = boundStore("u-o");
  const auth = fakeAuth({ session: as("u-o") });
  const r = await R.submitNewPassword(auth, kv, "u-o", "a brand new password", "a brand new password");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(fns(auth), ["getSession", "updateUser", "signOut"], "session checked first, then the update, then sign-out");
  assert.deepEqual(auth.calls.find((c: any) => c.fn === "updateUser").arg, { password: "a brand new password" });
  assert.deepEqual(auth.calls.find((c: any) => c.fn === "signOut").arg, { scope: "global" });
  assert.equal(R.getRecoveryState(kv, NOW), "none");
  assert.equal((await auth.getSession()).data.session, null, "no session remains after a successful reset");
});

test("submit — no recovery session (expired in the meantime / fresh tab) -> link problem, updateUser is NOT called", async () => {
  const kv = boundStore("u-o");
  const auth = fakeAuth({ session: null });
  const r = await R.submitNewPassword(auth, kv, "u-o", "a brand new password", "a brand new password");
  assert.equal(r.ok, false);
  assert.equal(r.linkProblem, "expired");
  assert.ok(!fns(auth).includes("updateUser"));
  assert.equal(R.getRecoveryState(kv, NOW), "none");
});

test("submit — provider errors become friendly messages; raw provider text is never shown; an expired session is surfaced as an expired link", async () => {
  const run = async (err: any) => R.submitNewPassword(fakeAuth({ session: as("u-o"), updateError: err }), boundStore("u-o"), "u-o", "a brand new password", "a brand new password");
  const same = await run({ code: "same_password", message: "New password should be different from the old password SENTINEL" });
  assert.equal(same.message, "Choose a password you haven't used before.");
  assert.equal((await run({ code: "weak_password", message: "Password is known to be weak SENTINEL" })).message, "That password is too easy to guess. Try a longer or less common one.");
  const exp = await run({ message: "invalid JWT: token is expired SENTINEL", status: 401 });
  assert.equal(exp.linkProblem, "expired");
  assert.equal((await run({ status: 429, message: "rate SENTINEL" })).message, "Too many attempts. Wait a minute and try again.");
  assert.match((await run({ message: "Failed to fetch" })).message, /couldn't reach the server/);
  const generic = await run({ message: "something unexpected SENTINEL" });
  assert.equal(generic.message, "We couldn't update your password. Please try again.");
  for (const r of [same, exp, generic]) assert.ok(!JSON.stringify(r).includes("SENTINEL"), "raw provider text leaked");
});

test("submit — if the global sign-out fails the local one still runs; a thrown sign-out never undoes a successful password change", async () => {
  const a = fakeAuth({ session: as("u-o"), signOutGlobalError: { message: "boom" } });
  assert.deepEqual(await R.submitNewPassword(a, boundStore("u-o"), "u-o", "a brand new password", "a brand new password"), { ok: true });
  assert.deepEqual(a.calls.filter((c: any) => c.fn === "signOut").map((c: any) => c.arg), [{ scope: "global" }, { scope: "local" }]);
  const b = fakeAuth({ session: as("u-o") });
  b.signOut = async () => { throw new Error("network"); };
  assert.deepEqual(await R.submitNewPassword(b, boundStore("u-o"), "u-o", "a brand new password", "a brand new password"), { ok: true });
});

test("cancel — backing out clears the marker and signs the recovery session out", async () => {
  const kv = boundStore("u-o");
  const auth = fakeAuth({ session: as("u-o") });
  await R.cancelRecovery(auth, kv);
  assert.equal(R.getRecoveryState(kv, NOW), "none");
  assert.deepEqual(auth.calls.filter((c: any) => c.fn === "signOut").map((c: any) => c.arg), [{ scope: "local" }]);
});

// ── Forgot Password submission ───────────────────────────────────────────

test("forgot password — resetPassword() asks Supabase for a link to the dedicated page on the canonical production host", async () => {
  const sent: any[] = [];
  (globalThis as any).__sb = { auth: { resetPasswordForEmail: async (email: string, o: any) => { sent.push({ email, o }); return { error: null }; } } };
  const at = (origin: string, hostname: string) => { (globalThis as any).window = { location: { origin, hostname } }; };
  at("https://connect.renometa.com", "connect.renometa.com");
  await R.resetPassword("owner@example.com");
  assert.deepEqual(sent[0], { email: "owner@example.com", o: { redirectTo: "https://connect.renometa.com/reset-password" } });
  at("http://localhost:5173", "localhost");
  await R.resetPassword("dev@example.com");
  assert.equal(sent[1].o.redirectTo, "http://localhost:5173/reset-password");
  at("https://deploy-preview-12--renometa.netlify.app", "deploy-preview-12--renometa.netlify.app");
  await R.resetPassword("qa@example.com");
  assert.equal(sent[2].o.redirectTo, "https://deploy-preview-12--renometa.netlify.app/reset-password");
  // an unknown / lookalike host can never become the destination of a recovery link
  for (const [origin, host] of [["https://connect.renometa.com.evil.test", "connect.renometa.com.evil.test"], ["https://evil.test", "evil.test"], ["https://netlify.app.evil.test", "netlify.app.evil.test"]]) {
    at(origin, host);
    await R.resetPassword("x@example.com");
    assert.equal(sent[sent.length - 1].o.redirectTo, "https://connect.renometa.com/reset-password", origin);
  }
  assert.ok(sent.every((s) => !/\?|#|auth\/callback/.test(s.o.redirectTo)), "no query, no fragment, no old callback route");
  (globalThis as any).__sb = { auth: { resetPasswordForEmail: async () => ({ error: new Error("rate limited") }) } };
  await assert.rejects(R.resetPassword("x@example.com"), /rate limited/);
  delete (globalThis as any).window;
});

test("forgot password page — still shows the same confirmation whether or not the email exists, and links back to sign-in", () => {
  const page = read("src/routes/forgot-password.tsx");
  assert.match(page, /resetPassword\(email\)/);
  assert.match(page, /Don't reveal whether the email exists/);
  assert.match(page, /catch \(err: any\) \{[\s\S]*setSent\(true\);/);
  assert.match(page, /to="\/signin"/);
});

// ── the view ─────────────────────────────────────────────────────────────

const html = (state: any) => R.renderToStaticMarkup(R.createElement(R.ResetPasswordView, { state, onSubmit: async () => ({ ok: true }), onCancel() {}, onRequestNewLink() {}, onSignIn() {} }));

test("view — ready: New Password + Confirm Password (masked, new-password autocomplete), the account being reset, a submit button, a cancel path", () => {
  const out = html({ kind: "ready", email: "owner@example.com" });
  assert.match(out, /Choose a new password/);
  assert.match(out, /<label[^>]*for="new-password"[^>]*>New password<\/label>/);
  assert.match(out, /<label[^>]*for="confirm-password"[^>]*>Confirm new password<\/label>/);
  assert.equal((out.match(/type="password"/g) ?? []).length, 2);
  assert.equal((out.match(/autoComplete="new-password"|autocomplete="new-password"/gi) ?? []).length, 2);
  assert.match(out, /owner@example\.com/);
  assert.match(out, /At least 8 characters/);
  assert.match(out, /Update password/);
  assert.match(out, /Cancel/);
  assert.match(out, /aria-label="Show password"/);
});

test("view — invalid links: expired / invalid / missing each get a clear message and a way to request a new link or return to sign-in", () => {
  for (const problem of ["expired", "invalid", "missing"]) {
    const out = html({ kind: "invalid", problem });
    assert.match(out, /Reset link problem/);
    assert.ok(out.replace(/&#x27;|&apos;/g, "'").includes(R.LINK_PROBLEM_MESSAGES[problem]), problem);
    assert.match(out, /Request a new link/);
    assert.match(out, /Back to sign in/);
  }
  assert.match(R.LINK_PROBLEM_MESSAGES.expired, /expired or has already been used/);
});

test("view — success: confirmation, tells the user they were signed out, and offers only 'Back to sign in' (no auto-login, no dashboard link)", () => {
  const out = html({ kind: "done" });
  assert.match(out, /Password updated/);
  assert.match(out, /signed out on all devices/);
  assert.match(out, /Back to sign in/);
  assert.ok(!/href="\/"/.test(out) && !/dashboard/i.test(out));
  assert.match(html({ kind: "checking" }), /Verifying your link/);
});

// ── static: open redirects, token handling, single point of password change ──

test("static — no open redirect, no token logging, and the password is changed in exactly one place", () => {
  const files = ["src/lib/password-recovery.ts", "src/routes/reset-password.tsx", "src/components/auth/reset-password-view.tsx"];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(src), `${f} must not log`);
    assert.ok(!/searchParams\.get\(["'](redirect|next|returnTo|return_to|callback|url)["']\)/i.test(src), `${f} must not read a redirect parameter`);
    assert.ok(!/window\.location\.(href|assign|replace)\s*=|location\.(assign|replace)\(/.test(src), `${f} must not navigate by URL`);
  }
  const page = read("src/routes/reset-password.tsx");
  assert.match(page, /replaceState\(null, "", "\/reset-password"\)/, "tokens / error params are scrubbed from the address bar");
  assert.match(page, /to: "\/signin"/);
  assert.match(page, /let bootstrapOnce/, "a one-time token is verified once even if the effect runs twice");
  // supabase.auth.updateUser is called from password-recovery.ts only
  const callers: string[] = [];
  for (const f of ["src/routes/reset-password.tsx", "src/routes/signin.tsx", "src/routes/signup.tsx", "src/routes/forgot-password.tsx", "src/routes/auth.callback.tsx", "src/lib/auth.ts"]) {
    if (/auth\.updateUser\(|\.updateUser\(\{ password/.test(read(f))) callers.push(f);
  }
  assert.deepEqual(callers, []);
  assert.match(read("src/lib/password-recovery.ts"), /auth\.updateUser\(\{ password \}\)/);
});

test("static — the Supabase client captures the recovery intent before it is created and binds PASSWORD_RECOVERY right after; existing sign-in behavior is untouched", () => {
  const sb = read("src/lib/supabase.ts");
  const iCreate = sb.indexOf("export const supabase = createClient");
  assert.ok(sb.indexOf("captureRecoveryIntent();") > 0 && sb.indexOf("captureRecoveryIntent();") < iCreate);
  assert.ok(sb.indexOf("installRecoveryListener(supabase.auth);") > iCreate, "the listener is registered synchronously after the client is created");
  assert.match(sb, /createClient\(supabaseUrl, supabaseAnonKey\);/, "client options (flow type, session handling) are unchanged");
  assert.ok(!/password-recovery/.test(read("src/lib/auth-session.ts")), "the shared session cache is untouched");
  assert.match(read("src/routes/reset-password.tsx"), /submitNewPassword\(auth, kv\(\), recoveringUserId\.current,/, "the page submits for the verified user only");
  const auth = read("src/lib/auth.ts");
  assert.match(auth, /signInWithPassword/);
  assert.match(auth, /emailRedirectTo: `\$\{window\.location\.origin\}\/auth\/callback`/, "sign-up confirmation links are unchanged");
  assert.match(auth, /redirectTo: `\$\{window\.location\.origin\}\/auth\/callback`/, "OAuth redirects are unchanged");
  assert.ok(!/type=recovery/.test(auth.replace(/\/\/.*$/gm, "")), "the old recovery redirect is gone");
});
