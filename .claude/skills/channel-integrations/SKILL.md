---
name: channel-integrations
description: >
  Canonical architecture for connecting an external communication provider
  (Twilio SMS, Vapi voice, Meta Messenger/Instagram/WhatsApp, email, and any
  future provider) into RenoMeta AI Center. Use whenever writing or editing a
  provider webhook, a channel adapter, an inbound/outbound message handler,
  or any code that normalizes a provider payload into an AIChannelEvent or
  sends through a provider's API. Pairs with `ai-center` (orchestration
  architecture), `communications-compliance` (consent/opt-out), and
  `server-authorization`/`secure-backend` (trust boundaries).
---

# Channel Integrations — RenoMeta Connect

## Core rule

**Providers are transports. AI Center owns reasoning and orchestration.**

This applies identically to Twilio SMS, Vapi voice, Messenger, Instagram,
WhatsApp, email, and any future provider. A provider's SDK, webhook, or
console configuration must never become a second place business logic lives.

## Canonical inbound flow

```
Provider webhook
  -> provider authenticity verification
  -> tenant/org resolution
  -> normalize provider payload
  -> canonical persistence
  -> dedupe/idempotency
  -> AIChannelEvent (netlify/functions/lib/ai/types.ts)
  -> AI Center orchestrator (orchestrateAI())
  -> routing/handoffs/tools
  -> central action/policy layer (executeStep()/executeApprovedStep())
  -> provider output, if allowed
```

## Canonical outbound flow

```
AI/tool intent
  -> trusted server binding (recipient resolved from trusted context, never from model output)
  -> Gen-2 action executor (executeStep()/executeApprovedStep(), src/lib/agentic/action-executor.ts)
  -> emergency pause check
  -> communication consent/opt-out check
  -> autonomy/approval decision
  -> idempotency claim
  -> provider transport (a handler in src/lib/agentic/handlers.ts)
  -> canonical outbound persistence
```

Inspect the live SMS implementation (`netlify/functions/ai-twilio-sms-inbound.ts`,
`ai-twilio-sms-orchestrate-background.ts`, `src/lib/agentic/handlers.ts`'s
`sendSms`) as the current reference example of both flows before building a
new channel — verify these files still exist and still work this way; do not
assume this document over current code.

## MUST

- Verify webhook authenticity/signatures wherever the provider supports it
  (e.g. Twilio's `X-Twilio-Signature`, HMAC-SHA1 over the exact externally-
  visible URL + sorted form params — see `netlify/functions/lib/twilio-
  signature.ts`).
- When reconstructing the externally-visible URL for signature validation,
  prefer `x-forwarded-proto`/`x-forwarded-host` over a raw/local request URL
  — a reverse proxy or local tunnel (ngrok, `netlify dev`) can terminate TLS
  and forward over plain HTTP, producing a scheme mismatch if the forwarded
  headers aren't checked first.
- Resolve tenant/org server-side from a trusted mapping (e.g. the receiving
  phone number matched against `organizations.integration_settings.twilio.
  phoneNumber`) — a claimed org id in the payload is never trusted directly.
- Resolve contact/lead/project ids server-side, scoped to the resolved org
  (`.eq("org_id", orgId)` on every lookup) — never trust a provider-supplied
  identifier as already belonging to the right tenant.
- Give inbound provider message ids (Twilio `MessageSid`, a Vapi call id, a
  Meta message id, etc.) durable dedupe protection — prefer an atomic
  unique/conditional write (e.g. a unique index and an insert that treats a
  23505 conflict as "already processed") over check-then-insert.
- Give a background/async worker its OWN durable idempotency guard,
  independent of the public webhook's own dedupe, whenever infrastructure
  could retry the worker invocation itself (not just the original webhook
  delivery). A conditional `UPDATE ... WHERE claim_column IS NULL` on the
  row the worker is processing is a proven, minimal pattern already used in
  this codebase (`sms_meta_messages.meta` claims, `appointments`' own
  reminder-claim columns) — prefer it over a new queue table.
- Persist the inbound message before dispatching AI processing, where the
  data model allows it, so an AI/model failure can never erase a real
  customer communication.
- Reuse the existing canonical message table for a channel's
  inbound/outbound history (`sms_meta_messages` for SMS/WhatsApp/Messenger/
  Instagram as of this writing — confirm current schema before assuming).
  Do not create a second, parallel conversation store for a new channel that
  already has a canonical one.
- Bind the outbound recipient (phone/email/contact) from trusted server
  context (a resolved `contactId`), never from a model's tool-call argument
  or a request body field.
- Keep provider API calls inside a Gen-2 action handler
  (`src/lib/agentic/handlers.ts`), reached only through
  `executeStep()`/`executeApprovedStep()` — never call a provider's REST API
  directly from orchestrator/agent/model code.
- Cap one inbound event to a bounded number of AI responses (one, in the
  current SMS design) — no reply loops, no multi-message bursts, unless a
  future design deliberately changes this.
- Prefer dispatching AI orchestration to an async/background path (e.g. a
  Netlify Background Function) when model latency could exceed the
  provider's webhook timeout window — check the provider's real timeout and
  the platform's function-timeout behavior before assuming synchronous
  orchestration is safe.
- Return the provider's expected response shape quickly (e.g. Twilio expects
  a fast TwiML/empty response) regardless of how AI processing turns out.
- Keep every real-channel AI run observable through the existing
  `agent_executions` / Run Inspector path — set a real, distinguishing
  `actor.source` (e.g. `"twilio_inbound_sms"`) rather than reusing an
  unrelated source value.
- Persist a provider message id for audit/dedupe when the schema has a
  column for it; never persist an auth token, webhook signature, or other
  secret into an execution/audit record.

## MUST NOT

- Make a provider (Twilio, Vapi, Meta, etc.) the decision-maker — no
  business logic, routing, or reply content generation inside a webhook
  handler.
- Duplicate AI Center's routing/orchestration logic inside a channel
  adapter.
- Trust `orgId`/`contactId`/`leadId`/`projectId` supplied by a public
  webhook payload unless independently resolved against a trusted
  server-side mapping — a provider-specific identifier (phone number, page
  ID, call id) may only be used to LOOK UP a trusted internal entity, never
  used directly as one.
- Let a public webhook's failure mode cause endless retries that could
  duplicate a side effect — if AI processing fails, still return the
  provider's expected safe response rather than a 5xx that triggers a retry
  storm, once the inbound message itself is safely persisted/deduped.
- Expose raw provider secrets or raw provider error bodies in a response,
  log line intended for the client, or execution summary.
- Let a model choose an arbitrary org, contact, phone number, email address,
  or provider identifier for an outbound send — the input schema for an
  outbound action should not even offer that as a field where avoidable
  (see `send_sms`'s `{contactId, body}` shape, no phone field, as the
  current pattern).
- Blindly retry a send when the external provider already accepted it — if
  the external side effect succeeded but local persistence/audit
  afterward failed, do not re-invoke the provider; fix/record the local
  failure without duplicating the external action. Distinguish "failed
  before the external call" from "external call succeeded, something after
  it failed" whenever diagnosing an incident.

## Channel adapter responsibilities

A channel adapter (a provider-specific webhook + its background dispatcher,
if any) MAY:

- authenticate the provider request
- resolve the tenant/org
- normalize the provider payload into an `AIChannelEvent`
- resolve trusted CRM ids (contact/lead/project) for that org
- persist the inbound record and enforce dedupe
- dispatch to the shared orchestrator
- bind the trusted recipient/action context for an eventual outbound action

A channel adapter MUST NOT:

- invent business strategy or reply content itself
- perform semantic/keyword-based routing in place of the orchestrator's
  deterministic router or model-driven routing
- bypass the policy engine (emergency pause, consent) for an outbound send
- bypass the approval requirement an action is configured with
- bypass opt-out/consent checks
- call a model/LLM directly outside the canonical orchestrator path

## Provider-specific code should be thin

Provider-specific code should end at:

- **verification** (signature/authenticity check)
- **normalization** (provider payload -> `AIChannelEvent` / provider REST
  call shape)
- **transport** (the actual HTTP call to the provider)

Everything else — routing, reasoning, policy, approval, persistence
semantics — is shared, channel-agnostic code. If a new channel's adapter
starts growing business rules, that logic almost certainly belongs one
layer up, in orchestration/policy code shared across channels.

## Before extending or adding a channel

Inspect the current live implementation of at least one working channel
adapter and confirm field/table/function names still match this document —
this file describes the pattern, not a frozen contract. If what you find in
the repository differs from what's described here, trust the repository and
update your approach accordingly (and flag the drift rather than silently
building against a stale assumption).

## Related skills

- `ai-center` — overall orchestration architecture this flow feeds into
- `communications-compliance` — consent/opt-out rules for outbound sends
- `server-authorization` / `secure-backend` — trust-boundary rules for the
  Netlify functions a channel adapter lives in
- `database-migrations` — schema changes to canonical message/dedupe tables
