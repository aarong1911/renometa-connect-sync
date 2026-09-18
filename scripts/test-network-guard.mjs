// scripts/test-network-guard.mjs
//
// TEST-SAFETY INCIDENT REMEDIATION (2026-09-17) — a `.tmp-test/*.mjs`
// script created disposable "WA-OAuth-Test-*" organizations by inserting
// directly into `organizations`. Even though every WhatsApp/Twilio/Graph
// API provider call in those tests was mocked at the fetch level, the
// bare `organizations` insert itself was enough to trigger a REAL
// external side effect: at least one live "Welcome to RenoMeta — Your
// Free Trial Is Active" email reached a real inbox. The exact external
// mechanism (a Supabase Database Webhook, a Make.com scenario polling
// Supabase, or similar) lives OUTSIDE this repository's tracked code and
// could not be fully confirmed from here — see this pass's own report —
// but a live, repo-code-unused RESEND_API_KEY in .env is strong
// circumstantial evidence of an external, dashboard/Make.com-configured
// watcher on new `organizations` rows.
//
// Root-causing every possible external hook is NOT a precondition for
// safety. The actual fix is structural, on BOTH ends:
//
//   1. Automated tests must NEVER insert new rows into `organizations`
//      (see TESTING RULES below) — reuse the one pre-existing, known-safe
//      dedicated test org instead.
//   2. Every OTHER outbound side effect (SMS, WhatsApp, email, webhooks,
//      Make.com, Vapi, Stripe, any LLM provider) must be blocked BY
//      DEFAULT, not allowed-by-default-except-for-named-providers. Every
//      earlier test script in this repo (AI-2D, AI-2E, the WhatsApp OAuth
//      selection tests) used the OPPOSITE pattern — mock a couple of
//      named hosts, silently pass every other fetch() through to
//      globalThis.fetch unchanged. That pattern is retired as of this
//      module; it must never be reintroduced.
//
// ── USAGE ─────────────────────────────────────────────────────────────
//
//   import { installNetworkGuard } from "../scripts/test-network-guard.mjs";
//
//   const guard = installNetworkGuard({
//     allowHosts: [],           // extra hostnames to pass through for real (rare — see below)
//     mocks: [
//       { match: (url) => url.includes("graph.facebook.com"), respond: async (url, init) => new Response(...) },
//     ],
//   });
//   try {
//     // ... test body ...
//   } finally {
//     guard.uninstall();
//   }
//
// Call installNetworkGuard() BEFORE any dynamic import of application code
// that might make a network call at import- or call-time (orchestrateAI,
// any *-transport.ts, any Netlify function handler). Every fetch() call
// made anywhere in the process after installation is checked:
//
//   1. Does it match one of `mocks`? -> return the mock's synthetic
//      response, no real network call.
//   2. Is its hostname the project's OWN Supabase project, or an
//      explicitly passed `allowHosts` entry, or localhost/127.0.0.1? ->
//      passed through to the real network (needed for the test harness's
//      own Supabase reads/writes to work at all).
//   3. Otherwise -> THROWS. No real external provider call ever
//      completes silently. An un-mocked call to Twilio, Meta, Vapi,
//      Stripe, Anthropic, OpenAI, a Make.com webhook, or anything else
//      not explicitly listed above is now a hard test FAILURE, not a
//      silent leak — this is the deny-by-default behavior this incident
//      requires.
//
// ── WHAT THIS DOES NOT COVER ─────────────────────────────────────────
//
// This guards `globalThis.fetch` only. Confirmed by repo-wide search
// (2026-09-17): every current outbound provider call in this codebase
// EXCEPT email goes through fetch (Twilio, Meta Graph API, Anthropic,
// and — if ever exercised by a test — Vapi and Stripe's HTTPS API calls
// make it here too, since Node's global fetch/undici is what all of
// those ultimately use). Email is the ONE confirmed exception — see
// installNodemailerGuard() below, which must ALSO be installed by any
// test that imports a file that could reach nodemailer.createTransport()
// (send-inbox-message.ts, any future email-sending code). If a FUTURE
// provider integration uses a raw TCP/TLS socket library or a vendor SDK
// that does its own HTTP client (bypassing global fetch) instead of
// fetch/nodemailer, this guard will NOT catch it — that integration must
// add its own explicit guard/mock, the same way installNodemailerGuard()
// does for email today.

const DEFAULT_MOCKS = [];

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isAllowedHost(hostname, allowedHosts) {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  for (const allowed of allowedHosts) {
    if (!allowed) continue;
    if (hostname === allowed || hostname.endsWith("." + allowed)) return true;
  }
  return false;
}

/**
 * Installs a deny-by-default fetch guard. Returns { uninstall(), calls }
 * — `calls` is a live array of every request the guard observed (host +
 * outcome: "mocked" | "allowed" | "blocked"), useful for a test to assert
 * on ("no blocked calls occurred" / "exactly one mocked Graph API call
 * happened").
 */
export function installNetworkGuard({ allowHosts = [], mocks = DEFAULT_MOCKS } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseHost = supabaseUrl ? hostnameOf(supabaseUrl) : "";
  const allowedHosts = [supabaseHost, ...allowHosts].filter(Boolean);

  globalThis.fetch = async (url, init) => {
    const u = typeof url === "string" ? url : url.toString();
    const hostname = hostnameOf(u);

    for (const mock of mocks) {
      if (mock.match(u, init)) {
        calls.push({ url: u, hostname, outcome: "mocked" });
        return mock.respond(u, init);
      }
    }

    if (isAllowedHost(hostname, allowedHosts)) {
      calls.push({ url: u, hostname, outcome: "allowed" });
      return realFetch(url, init);
    }

    calls.push({ url: u, hostname, outcome: "blocked" });
    throw new Error(
      `[test-network-guard] BLOCKED outbound network call to "${hostname}" (${u}). ` +
        `Automated tests must never make real external provider calls — add an explicit ` +
        `mock for this host if the test genuinely needs to exercise it, or fix the code ` +
        `path making an unexpected real call.`,
    );
  };

  return {
    calls,
    uninstall() {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Guards nodemailer specifically — the ONE confirmed non-fetch outbound
 * transport in this codebase (send-inbox-message.ts's SMTP send via
 * `nodemailer.createTransport(...).sendMail(...)`). nodemailer's SMTP
 * transport opens its own raw TCP/TLS socket; it is NOT caught by
 * installNetworkGuard()'s fetch patch. Any test that imports a module
 * which could reach nodemailer must install this guard too.
 *
 * Replaces the real `sendMail` method on every transport nodemailer
 * creates with one that throws — same deny-by-default posture as the
 * fetch guard, not a silent no-op, so an unexpected real email attempt
 * fails the test loudly instead of possibly still finding a way through.
 */
export async function installNodemailerGuard() {
  const nodemailerModule = await import("nodemailer");
  const nodemailer = nodemailerModule.default ?? nodemailerModule;
  const realCreateTransport = nodemailer.createTransport;

  nodemailer.createTransport = function guardedCreateTransport(...args) {
    const realTransport = realCreateTransport.apply(this, args);
    const realSendMail = realTransport.sendMail?.bind(realTransport);
    realTransport.sendMail = async (...sendArgs) => {
      throw new Error(
        "[test-network-guard] BLOCKED a real nodemailer.sendMail() call during an automated test. " +
          "Tests must never send real email — mock the email-sending function itself, or don't " +
          "exercise a code path that sends email in an automated test.",
      );
    };
    // Keep a reference in case a test deliberately wants to verify the
    // guard is active without triggering the throw path.
    realTransport.__realSendMailForDebugOnly = realSendMail;
    return realTransport;
  };

  return {
    uninstall() {
      nodemailer.createTransport = realCreateTransport;
    },
  };
}
