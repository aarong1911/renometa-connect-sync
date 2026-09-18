# Test safety rules — read before writing any `.tmp-test/*.mjs` script

Established 2026-09-17 after a real incident: a disposable test org
(`WA-OAuth-Test-5`, created by a WhatsApp OAuth test via a plain
`organizations` insert) triggered at least one real "Welcome to RenoMeta —
Your Free Trial Is Active" email to a live inbox. No code in this
repository sent that email — the exact external mechanism (most likely a
Supabase Database Webhook or a Make.com scenario watching `organizations`,
given a live, repo-code-unused `RESEND_API_KEY` sits in `.env`) lives
outside this repo's tracked code and was never fully confirmed. See
`scripts/test-network-guard.mjs`'s header and the incident report for the
full trace.

## Hard rules

1. **Never insert into `organizations` from an automated test.** Reuse
   the existing dedicated test org (`6f488e04-8976-4ffd-84dc-b99ce7b5a514`
   as of this writing) for every test that just needs a valid `org_id` to
   satisfy a foreign key. If a test genuinely needs to prove cross-org
   isolation, that needs a deliberate, reviewed design decision (e.g.
   mocking the org-resolution query itself) — not a fresh `organizations`
   row, until the external trigger is confirmed and safely
   handled/allowlisted for test data.

2. **Install `installNetworkGuard()` from `scripts/test-network-guard.mjs`
   at the very top of every test script**, before any dynamic import of
   application code, with explicit mocks for exactly the providers that
   specific test needs to exercise (Graph API, Twilio, etc.). Any other
   outbound `fetch()` call — including to Anthropic/OpenAI, Vapi, Stripe,
   or a Make.com webhook — now THROWS instead of silently reaching the
   real network. This replaces the old pattern (mock one named host,
   `return realFetch(url)` for everything else) — that pattern is
   retired; never reintroduce it.

3. **If the test imports anything that could send email**
   (`send-inbox-message.ts`, or any future email-sending code), also call
   `installNodemailerGuard()` — nodemailer's SMTP transport is a raw
   TCP/TLS connection, not `fetch`, so the network guard above does not
   catch it. When bundling a test script with esbuild that imports
   nodemailer (directly or via `installNodemailerGuard()`), add
   `--external:nodemailer` to the esbuild command — nodemailer is CJS
   with a dynamic `require`, which esbuild cannot bundle cleanly; let
   Node resolve it from `node_modules` at runtime instead.

4. **Never call a real LLM provider in an automated test** unless the
   test explicitly mocks that specific call. A real Anthropic/OpenAI call
   is a real external side effect (cost, latency, and — per this
   incident — an unknown blast radius of what else might be watching for
   new rows/executions) even though it isn't a customer-facing message.
   An earlier AI-2E test suite treated a real `orchestrateAI()` call as
   "acceptable" on the reasoning that only provider *send* calls needed
   mocking — that reasoning is superseded by this rule.

5. **Tests may clean up ONLY rows they created and recorded by exact
   id.** No deletes by name pattern, org, product, timestamp, or email.
   This was already the convention before this incident and remains
   unchanged — the incident was never about over-broad cleanup, it was
   about the CREATE step itself having a side effect cleanup could never
   have undone in time anyway (the email had already sent before cleanup
   ran).

6. **`.tmp-test/` is deleted at the end of every task.** This safety
   module deliberately lives in the checked-in `scripts/` directory
   instead, so it survives across sessions and every future test script
   inherits it automatically — don't move it into `.tmp-test/`.

## What's still NOT fully solved

The exact external trigger on `organizations` inserts (Database Webhook
vs. Make.com poll vs. something else) has not been confirmed from inside
this repo/session — that requires checking the Supabase Dashboard
(Database → Webhooks) and the Make.com scenario list directly, neither of
which this session has access to. Rule 1 above is the safe mitigation
regardless of which mechanism turns out to be real: no new `organizations`
row, no possible trigger.
