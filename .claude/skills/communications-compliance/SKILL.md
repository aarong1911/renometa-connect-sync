---
name: communications-compliance
description: >
  Rules for communication eligibility, opt-out, suppression, and
  re-subscription across SMS, email, WhatsApp, Messenger, Instagram, and
  future outbound channels — including the current RenoMeta
  marketing_contact_preferences model, STOP/START/HELP handling, and why
  compliance decisions must be deterministic rather than model-decided. Use
  whenever writing or reviewing any code that sends a customer-facing
  message, checks consent/opt-out, or handles an inbound compliance
  keyword. Pairs with `channel-integrations` and `ai-center`.
---

# Communications Compliance — RenoMeta Connect

## Current RenoMeta SMS consent model

Table: `marketing_contact_preferences`

Known fields (verify against the live schema before relying on this list —
it is documented here, not guaranteed to be exhaustive or unchanged):

- `org_id`
- `contact_id`
- `email_unsubscribed`
- `email_suppressed`
- `sms_status`

Known `sms_status` values: `"unknown"` | `"eligible"` | `"opted_out"` |
`"suppressed"` (see `src/lib/marketing-audience.ts`'s `SmsStatus` type).

### Current safety semantics

- SMS eligibility is **fail-closed**: only `sms_status === "eligible"` may
  pass outbound SMS eligibility.
- `"unknown"` (no preference row, or an unrecognized value) is NOT treated
  as eligible — it blocks, exactly like an explicit opt-out.
- `"opted_out"` blocks.
- `"suppressed"` blocks.
- `enforceOptOut` is a server-owned policy flag that is effectively always
  enforced — it is not something client/model input can turn off (see
  `src/lib/agentic/policies.ts`'s `resolveAgentPolicy()`).
- Email consent uses its own fields (`email_unsubscribed`,
  `email_suppressed`) — never cross-apply SMS status to email eligibility or
  vice versa; they are independent checks on independent fields.

The canonical enforcement point today is `checkOutboundConsent()` in
`src/lib/agentic/action-executor.ts`, which calls
`splitByChannelEligibility()` in `src/lib/marketing-audience.ts`. Reuse these
— do not re-implement eligibility logic in a handler, channel adapter, or UI
component.

## MUST

- Treat compliance decisions (opt-out, re-subscribe, suppression) as
  **deterministic code**, never something an LLM decides. A STOP-family
  message must never be handed to a model as if it were a normal
  conversational turn.
- Use **exact matching** for compliance keywords (the entire trimmed,
  lowercased message body equals a known keyword) unless a specific
  provider requirement documented in code says otherwise. Do not
  substring-match ordinary conversation text (a customer saying "please
  stop texting me at work, my cell is better" is not a STOP command).
- Process STOP/opt-out **before** any AI orchestration is dispatched for
  that message — structurally, not just by ordering convention (i.e. the
  code path that handles a compliance keyword should never call the
  function that dispatches AI at all).
- Ensure an opt-out message can never result in an AI reply proposal or an
  `agent_approval_requests` row.
- Scope every consent lookup to the resolved org (`org_id` +
  `contact_id`) — never a global/cross-tenant lookup.
- Fail closed when eligibility data is missing, a lookup errors, or a
  contact id doesn't resolve to a real contact in the caller's org — never
  default to "allowed" on uncertainty.
- Fail closed for any channel that has no real consent mechanism in the
  current schema (e.g. WhatsApp/Messenger/Instagram/voice, as of this
  writing) rather than assuming SMS/email-style consent transfers.
- Recheck consent at **actual execution time** (when an approved action is
  about to run), not only when the approval/proposal was first created — a
  contact can opt out while an approval is sitting pending.
- Use a generic, safe error message when consent blocks an action — e.g.
  "Current communication policy does not allow this action." Never surface
  the specific reason (opted_out vs. suppressed vs. unknown) to an
  end-user-facing error, and never reveal it in a way that lets a caller
  probe consent state for a contact they shouldn't be able to see.

## MUST NOT

- Invent consent. A phone number or email existing in the CRM is NOT
  automatically communication consent.
- Let a human approval bypass opt-out. Emergency Pause and communication
  consent are two separate, independently-enforced controls — approving an
  action does not grant an exemption from either.
- Silently restore `"suppressed"` back to eligible through a customer-facing
  re-subscribe flow unless a specific, deliberate compliance/provider rule
  supports it. `"opted_out" -> "eligible"` re-subscription must be explicit
  and go through the same kind of trusted, dedicated write path opt-out
  itself uses (not casual, incidental code).
- Block internal-only actions (reading CRM context, adding an internal
  note) on customer opt-out — opt-out governs outbound customer
  communication, not internal record-keeping.

## Marketing vs. transactional communication

`marketing_contact_preferences` originated for marketing-campaign
workflows. It may not perfectly represent every nuance of transactional or
AI-agent-initiated communication. Until a more precise, purpose-built
consent model exists:

- Use the current table as the source of truth anyway, conservatively.
- When in doubt about whether a message counts as "marketing" or
  "transactional" for consent purposes, fail closed rather than assuming a
  transactional exemption exists.
- Any future expansion of the consent model (a transactional-specific flag,
  a channel-specific table, etc.) should be a deliberate, reviewed schema
  decision — not something quietly bolted on inside a single feature's
  handler.

## Compliance persistence

- Use the existing canonical message table for a channel's inbound/outbound
  compliance-related messages where that table already exists (e.g.
  `sms_meta_messages` for SMS) — do not create a parallel table just for
  compliance messages.
- Preserve the provider's message id (e.g. Twilio `MessageSid`) on
  persisted rows for dedupe and audit.
- Do not create a second, parallel consent/preference store without an
  explicit architectural decision — `marketing_contact_preferences` is the
  one current source of truth for SMS/email eligibility.
- Compliance-relevant messages (a STOP, a re-subscribe) should remain
  auditable — visible in the same conversation history a human would check,
  not silently swallowed.

## Provider-managed compliance

- Do not assume Twilio, Meta, or any other provider automatically handles
  STOP/START/HELP on RenoMeta's behalf — verify the actual account/number
  configuration before relying on provider-side behavior.
- If provider-level auto-replies for compliance keywords are active for a
  given number/account, avoid sending a second, duplicate confirmation from
  RenoMeta's own code for the same event.
- If you cannot verify what a provider's account is actually configured to
  do, say so explicitly rather than asserting a specific provider behavior
  you haven't confirmed.

## Related skills

- `channel-integrations` — where inbound compliance keywords are detected,
  and where the canonical inbound/outbound flow this plugs into is defined
- `ai-center` — orchestration this must never be bypassed by
- `server-authorization` — trust rules for any endpoint that changes
  consent state
