---
name: secure-backend
description: >
  General trust-boundary and tenant-security rules for RenoMeta Connect's
  Netlify functions — never trust browser-supplied org_id, same-org
  validation on every referenced entity, service-role key handling, Stripe
  amount/webhook trust, and OAuth/Meta token storage. Use whenever writing
  or editing a trusted backend write path (any netlify/functions/*.ts that
  performs a write), or reviewing one for security. Pairs with
  netlify-supabase-functions for boilerplate/patterns and
  accounting-integrity for money-specific trust rules.
---

# Secure Backend — RenoMeta Connect

This skill is the general trust-boundary ruleset. For request/response boilerplate and integration snippets (email, SMS, Stripe Checkout setup, Claude API), see `netlify-supabase-functions`. For money-specific amount/idempotency rules, see `accounting-integrity`.

## Tenant security

- Never trust a browser-provided `org_id`. Resolve authenticated user → organization **server-side**, every time (`resolveOrgFromBearerToken` in `netlify/functions/lib/resolve-org.ts` — reuse it, don't re-derive org resolution per function).
- Validate that every entity a request references — project, contact, vendor, invoice, bill, payment, account — belongs to the **same org** as the resolved caller, server-side, before using it for anything. Cross-org reference bugs are the single most common way multi-tenant SaaS leaks data.
- RLS policies are the read-path tenant boundary; they are not a substitute for validating write-path references server-side, and they are not reachable at all for `service_role`-only tables (most financial tables) — the Netlify function IS the entire boundary there.

## Supabase service role

- `SUPABASE_SERVICE_ROLE_KEY` never reaches browser code — not in a response body, not in a client-side env var, not logged.
- Service-role writes belong exclusively in trusted Netlify functions (or SQL migrations run manually by the user). React never gets a service-role client.

## Stripe

- Never trust a browser-supplied charge/payment amount. The server loads the canonical invoice/payment amount and uses that.
- Verify webhook signatures — don't process an unverified payload as if it were real.
- Treat every webhook delivery as potentially repeated; the same event ID can arrive more than once. Idempotency is via provider IDs (`payment_intent`, `charge`, `refund` ids) plus a DB uniqueness constraint, not "we haven't seen this yet in memory."
- Never log `client_secret`, secret API keys, or raw sensitive payment data.

## OAuth / Meta / Google

- Tokens stay server-side, encrypted at rest (see the AES-256-GCM pattern in `netlify/lib/` for gcal/gmail/Meta token handling).
- Never expose refresh or access tokens to browser storage (`localStorage`, cookies readable by JS, or a JSON response body).
- Follow the existing encrypted-token storage architecture rather than inventing a new one per integration — check `meta-integrations` skill before touching `meta_connections` or any `meta-*` function.

## Netlify function conventions

- Reuse the existing helpers rather than re-deriving the same logic per function:
  - bearer token → user → org: `resolveOrgFromBearerToken`
  - JSON responses: the `json(statusCode, body)` helper pattern already used throughout `netlify/functions/*.ts`
  - service-role client construction: the same `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })` shape every function already uses
- Don't duplicate auth/org-resolution logic inline in a new function when a shared helper already exists — if the logic needs to change, it should change in one place.

## Related skills

- `netlify-supabase-functions` — request/response boilerplate, email/SMS/Stripe/Claude API snippets
- `accounting-integrity` — money-specific amount trust, idempotency, and reversal rules
- `database-migrations` — `SECURITY DEFINER`/RLS/grant hardening on the DB side of these same trust boundaries
