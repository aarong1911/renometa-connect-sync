---
name: server-authorization
description: >
  Canonical authorization rules for privileged RenoMeta Connect server
  actions — owner/admin role resolution, tenant scoping, and the standard
  HTTP status semantics for authenticated Netlify functions. Use whenever
  writing or reviewing a Netlify function that performs a privileged
  action: approval/rejection endpoints, team/member administration, delete
  actions, settings changes, accounting/admin operations, or any
  owner/admin-only server action. Pairs with `secure-backend` (general
  trust-boundary rules) and `netlify-supabase-functions` (request
  boilerplate).
---

# Server Authorization — RenoMeta Connect

## Canonical authority helper

Use `resolveOrgAndAuthority()` from `netlify/functions/lib/resolve-org.ts`
for any endpoint that needs to know whether the caller is an org owner or
admin. Do not write a new inline role-resolution function in an endpoint —
reuse this one. If it's missing a capability you need, extend it there
rather than duplicating its logic elsewhere.

(`resolveOrgFromBearerToken()`, in the same file, is the lighter-weight
sibling for endpoints that only need "which org does this authenticated
user belong to," with no role/authority requirement — use that one when
authority isn't the question.)

## The current authoritative model

- Organization role comes from **`org_memberships.role`**, scoped to the
  specific org (`member_id` + `org_id`).
- `profiles.organization_id` being non-null means the user has an org
  context — it is **NOT** proof of owner/admin authority. Ordinary,
  non-privileged roles (viewer, project_manager, etc.) also have
  `profiles.organization_id` populated. Treating "`profiles.organization_id
  != null`" as "this user is the owner" is a real bug pattern that has
  shipped in this codebase before — never reintroduce it.
- Frontend role state (`useCurrentUserRole()`, route guards, hidden
  buttons) is a UX convenience only. It is never the actual security
  boundary — a normal member calling a privileged endpoint directly, with a
  valid session but the wrong role, must still be rejected server-side.

## MUST

- Authenticate first: resolve the caller from the bearer token
  (`supabaseAdmin.auth.getUser(token)`) before doing anything else with the
  request.
- Resolve org and role **server-side**, from `resolveOrgAndAuthority()` (or
  `resolveOrgFromBearerToken()` where role doesn't matter) — never from a
  request body field.
- Scope every target lookup and mutation to the resolved org
  (`.eq("org_id", orgId)` / `.eq("organization_id", orgId)` as appropriate)
  — a resource id alone is never sufficient to act on it.
- Make a cross-org resource lookup behave like "not found" (404) rather
  than revealing that it exists under a different org.
- Use service-role DB access only AFTER authentication and authorization
  have both passed.
- Reuse the canonical helper instead of adding a new inline owner/admin
  resolver — see above.
- Match "owner-only" vs. "owner/admin" to the ACTUAL current product
  permission model, not an assumption. When unclear, inspect
  `src/lib/permissions.ts` (`ROLE_ALLOWED_ROUTES`, `canAccessSettings()`)
  and how the corresponding frontend page is actually gated — a page or
  action reachable only by `owner` in the UI implies the backend
  equivalent should probably also be owner-only, not owner-or-admin.
- Prefer an authenticated server endpoint over a direct browser write for
  any high-impact settings/action whenever RLS-level authority cannot be
  positively proven (e.g. no way to inspect live `pg_policies` from the
  current environment) — see `netlify/functions/ai-emergency-pause.ts` as
  the existing example of this reasoning.

## MUST NOT

- Accept a trusted `orgId`, `userId`, `role`, `isAdmin`, `isOwner`, or any
  other authority-shaped flag from a browser/request body and use it to
  decide access. If such a field appears in a request schema, its presence
  should be rejected as invalid input, not silently ignored (a silently-
  ignored field still looks like it's honored to anyone reading a captured
  request).
- Weaken RLS to make a privileged frontend write more convenient. If direct
  browser writes aren't provably safe, add a backend endpoint instead of
  loosening the policy.
- Expose a raw Supabase/Postgres error message, stack trace, or internal
  detail in an API response.
- Rely on frontend hiding (a hidden tab, a disabled button) as the actual
  authorization mechanism — it is UX only.

## Standard HTTP semantics

- `400` — malformed input (bad JSON, missing required field, wrong type)
- `401` — unauthenticated (no token, or `auth.getUser()` fails)
- `403` — authenticated, but insufficient authority (wrong role, or org
  could not be resolved for this user)
- `404` — resource not found within the caller's own tenant (including a
  resource that exists, but in a different org)
- `405` — unsupported HTTP method

## Privileged JSONB settings

For a jsonb settings column such as `organizations.ai_center_settings`:

- Do not accept an arbitrary JSON object from the client and write it
  wholesale.
- Accept only explicitly supported, individually-validated keys/types for
  that endpoint (e.g. `{ emergencyPaused: boolean }` — reject anything
  else, including extra keys).
- When writing, merge onto the CURRENT stored value
  (`{...existingSettings, knownKey: newValue}`) so unrelated
  existing/future keys are preserved — never replace the whole object with
  only the keys this one endpoint knows about.
- Never allow the client to select which org's row gets updated — the org
  id is always the server-resolved one.
- Validate exact types before writing (a boolean field must actually be a
  boolean, not a truthy string).
- Log safely — ids and booleans are fine to log; never log a secret or raw
  provider credential that might live elsewhere in the same settings blob.

## Approval actions

- Owner/admin authorization for approving/rejecting a pending action must
  remain server-side (see `resolveOrgAndAuthority()` above) — this is not
  optional even if the UI already hides the control from other roles.
- An approvals UI must never write to `agent_approval_requests` directly
  from the browser — it calls the canonical approval endpoint
  (`netlify/functions/agent-approve-action.ts`) and lets that endpoint own
  the actual state transition.
- The canonical approval endpoint must recheck current policy (emergency
  pause) and consent at the moment it actually executes the approved
  action — not only at the moment the approval was first proposed.
- A duplicate/retried approval request for the same underlying action must
  be idempotent — it must not re-run a side effect (e.g. re-send an SMS)
  that already completed. Give the executed action a real idempotency key
  scoped to the specific execution, not just the action type.
- Approving one specific, hash-verified action must never be treated as
  granting broader authority than that single validated action — an
  approval is not a standing permission grant.
- When verifying that an approved action actually succeeded before marking
  it executed, check that action's OWN real proof-of-success field (e.g. a
  created task's id, a provider's message id) — do not assume a generic
  "status says succeeded" is sufficient for every action type, and do not
  silently treat an action with no defined verification rule as verified.

## Audit checklist

Before shipping a new privileged endpoint (or after materially changing
one), verify:

- [ ] Unauthenticated request -> `401`
- [ ] Authenticated but insufficient role -> `403`
- [ ] A resource belonging to a different org is inaccessible (behaves like
      not-found, not like a permission error that confirms existence)
- [ ] An `orgId` supplied in the request body is ignored or rejected, never
      honored
- [ ] A `role`/`isAdmin`/`isOwner`-shaped field supplied in the request body
      is ignored or rejected, never honored
- [ ] Malformed JSON body -> `400`
- [ ] No raw DB error, stack trace, or internal detail is ever returned to
      the client

## Related skills

- `secure-backend` — general trust-boundary rules (org resolution,
  service-role handling, OAuth/Stripe trust) this skill's role-authority
  rules sit alongside
- `netlify-supabase-functions` — request/response boilerplate patterns
- `channel-integrations` — provider webhook trust boundaries specifically
- `database-migrations` — RLS/`SECURITY DEFINER` hardening on the DB side
  of these same trust boundaries
