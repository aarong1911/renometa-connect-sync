# Test safety rules — read before writing any `.tmp-test/*.mjs` script

Established 2026-09-17 after a real incident: a disposable test org
(`WA-OAuth-Test-5`, created by a WhatsApp OAuth test via a plain
`organizations` insert) triggered at least one real "Welcome to RenoMeta —
Your Free Trial Is Active" email to a live inbox. **The exact external
mechanism/provider that sent that email is UNCONFIRMED** — do not name a
specific provider (e.g. Resend) as the cause without direct proof; a live,
repo-code-unused `RESEND_API_KEY` in `.env` is circumstantial evidence at
most. What IS confirmed: no code in this repository sent it, and the
trigger fires on the bare row existing (something outside this repo's
tracked code — Database Webhook, Make.com poll, or otherwise — reacts to
`organizations` inserts). See `scripts/test-network-guard.mjs`'s header
and the incident report for the full trace.

**CORRECTION (2026-09-18):** an earlier version of this file told tests to
reuse org `6f488e04-8976-4ffd-84dc-b99ce7b5a514` as a "dedicated test
org." That was wrong — this org has been used for real RenoMeta live
SMS/AI verification and must be treated as production-like. It may be
used for a READ-ONLY snapshot/comparison (e.g. proving a change never
touched it), but automated tests must never write to it, and it is not a
safe fixture for FK satisfaction either.

## Hard rules

1. **Never insert into `organizations` from an automated test, and never
   write to any real/customer org — including `6f488e04-8976-4ffd-84dc-
   b99ce7b5a514`, which is production-like, not disposable.** If DB-
   dependent logic needs a row with an `org_id` foreign key (e.g.
   `meta_connections`, `meta_whatsapp_pending_selections`), prefer
   extracting that logic into a function that takes an already-constructed
   `SupabaseClient` as a parameter (dependency injection — see
   `netlify/functions/lib/meta-whatsapp-selection-store.ts` for the
   pattern), then unit-test it against `scripts/fake-supabase-client.mjs`
   (an in-memory fake, no real Postgres, no FK constraints to satisfy —
   see that file's own header for exactly what it does and does NOT
   cover). If a test genuinely requires a REAL Postgres instance (to
   validate a migration's actual FK/unique/RLS enforcement), that needs a
   dedicated, isolated test-safe environment — local Supabase (`supabase
   start`, requires Docker) or a separate Supabase test project — not a
   real RenoMeta org. If neither is available, STOP and report that
   specific gap rather than using production data as a fixture.

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
