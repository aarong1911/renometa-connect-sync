---
name: ai-center
description: >
  Authoritative architecture and development guidance for the RenoMeta Connect
  AI Center. Use for all work involving AI agents, orchestration, agent routing,
  agent tools, permissions, CRM context, handoffs, human takeover, AI runs,
  approvals, agent configuration, AI channels, Vapi voice integration,
  AI-assisted CRM workflows, or files under the AI Center implementation.
  Also applies to Reception Agent, Lead Qualification, Speed-to-Lead,
  Scheduling, Estimate Assistant, Estimate Follow-Up, Project Support,
  Project Risk, Billing, Collections, Follow-Up, Review Agent, Inbox Triage,
  Internal Copilot, Conversation Summary, CRM Update, Task Extractor,
  Proposal Writer, AI Insights, and future custom agents.
---

# RenoMeta Connect — AI Center

## Purpose

AI Center is the shared AI operating layer for RenoMeta Connect.

It is NOT:

* a collection of unrelated Claude prompts
* a Vapi-only voice-agent implementation
* a collection of Make scenarios
* a separate standalone application
* a second CRM database
* a collection of agents that directly query Supabase independently

AI Center provides one common architecture for intelligent work across RenoMeta
Connect.

Agents eventually operate across:

* Voice
* SMS
* Email
* Web chat
* Facebook Messenger
* Instagram
* WhatsApp
* Internal RenoMeta Connect UI

All channels share the same:

* agent definitions
* CRM context
* tools
* permissions
* routing
* handoffs
* policies
* audit trail
* model-provider layer

---

# Core Architecture

The high-level runtime is:

```text
Channels / Events
        |
        v
Channel Adapter
        |
        v
Identity Resolver
        |
        v
Context Builder
        |
        v
Router
        |
        v
Policy / Permission Engine
        |
        v
Selected Agent
        |
        v
Model Provider
        |
        v
Tool Registry
        |
        +-------- CRM
        +-------- Leads
        +-------- Projects
        +-------- Tasks
        +-------- Calendar
        +-------- Estimates
        +-------- Billing
        +-------- Communications
        |
        v
Handoff / Human Escalation
```

The orchestration engine belongs to RenoMeta Connect.

The LLM provider supplies reasoning and language generation.

---

# Fundamental Design Rule

Agents are configuration running on a common engine.

Do NOT create a separate implementation such as:

```text
runReceptionAgent()
runLeadAgent()
runSchedulingAgent()
runBillingAgent()
```

Prefer:

```text
orchestrate(event)
```

with the orchestrator loading the selected agent's:

* version
* instructions
* tools
* permissions
* channels
* policies
* handoff rules
* organization configuration

This avoids creating a separate mini-application for every agent.

---

# Model Provider Architecture

AI Center must not be architecturally dependent on Anthropic, OpenAI, Gemini,
or another specific LLM vendor.

Use a provider abstraction.

Conceptually:

```typescript
export interface ModelProvider {
  run(request: ModelRequest): Promise<ModelResponse>;
}
```

Possible implementations:

```text
AnthropicProvider
OpenAIProvider
FutureProvider
```

Initially RenoMeta Connect may use Anthropic because existing infrastructure
already supports it, but business logic must not depend on Anthropic-specific
response formats outside the provider adapter.

Do NOT hard-code model IDs throughout agent implementations.

Model choice belongs in configuration or provider-level defaults.

---

# Supporting Platforms

## Claude / Anthropic or other LLM

Provides:

* reasoning
* classification
* language generation
* structured decisions
* tool selection

Does NOT own:

* CRM state
* permissions
* agent routing
* agent definitions
* business rules
* handoff state

## Vapi

Vapi is a voice transport/runtime integration.

Vapi may handle:

* phone connectivity
* audio
* speech recognition
* text-to-speech
* interruptions
* call lifecycle

Vapi should eventually call into the RenoMeta AI Center.

Do not build the core agent architecture inside Vapi.

## Make

Make is for deterministic workflows and integrations.

Examples:

```text
Estimate accepted
-> wait 2 days
-> check payment
-> send reminder
```

Make is NOT the central AI orchestrator.

Agents and workflows should eventually be able to invoke one another.

## Supabase

Supabase stores:

* CRM source-of-truth data
* agent configuration
* agent versions
* routing configuration
* handoff configuration
* permissions
* runtime state
* runs
* tool calls
* approvals
* audit events
* derived AI memory where appropriate

---

# CRM Is the Source of Truth

Do not duplicate CRM data into AI-specific tables.

Reuse existing RenoMeta Connect entities including:

```text
organizations
profiles / users
contacts
leads
conversations
messages
projects
tasks
appointments / calendar
estimates
invoices
files
pipeline / opportunities
campaigns
```

AI-specific tables should store configuration, state, audit information, and
derived AI data.

Structured CRM fields always override AI-derived memory.

---

# CRM Context Architecture

Agents should NOT receive unrestricted organization data.

The Context Builder assembles only information relevant to the current
interaction.

Example:

```json
{
  "organization": {},
  "contact": {},
  "lead": {},
  "project": {},
  "conversation": {},
  "channel": "sms"
}
```

Context is determined from:

* organization
* authenticated user where applicable
* channel identity
* contact
* lead
* project
* conversation
* workflow/event
* currently active agent

Never expose unrelated customer or organization records to an agent.

---

# Agent Categories

Initial system agents may include:

## Customer Service

### Reception & Routing

Responsibilities:

* greet inbound contacts
* identify intent
* answer allowed basic questions
* resolve identity
* route to appropriate agent
* escalate to human

### Inbox Triage

Responsibilities:

* classify conversations
* identify urgency
* summarize
* suggest next actions
* route conversations

---

## Sales

### Lead Qualification

Responsibilities:

* qualify inbound leads
* collect job details
* update CRM lead information
* determine next step
* hand off to Scheduling where appropriate

### Speed-to-Lead

Responsibilities:

* respond rapidly to new leads
* establish contact
* gather initial information
* hand off to Lead Qualification

### Follow-Up / Nurture

Responsibilities:

* follow up with inactive leads
* understand objections or timing
* update CRM
* schedule future follow-up

---

## Scheduling

### Scheduling Agent

Responsibilities:

* retrieve availability
* propose appointments
* book appointments when permitted
* reschedule
* cancel when permitted
* hand off unusual cases

---

## Estimates

### Estimate Assistant

Responsibilities:

* gather scope
* inspect project/lead context
* prepare estimate drafts
* identify missing information

### Estimate Follow-Up

Responsibilities:

* follow up on sent estimates
* classify customer response
* update CRM
* create tasks
* route objections or accepted work

### Estimate Reviewer

Responsibilities:

* review draft estimates
* identify omissions
* flag inconsistencies
* suggest adjustments

High-risk actions such as sending or materially changing financial documents
must follow approval policy.

---

## Projects

### Project Support

Responsibilities:

* answer customer questions from approved project information
* explain schedules
* retrieve tasks
* provide project updates
* escalate issues

### Project Risk

Responsibilities:

* detect delays
* identify overdue tasks
* flag communication gaps
* escalate risks

---

## Finance

### Billing

Responsibilities:

* answer invoice questions
* retrieve balances
* provide approved payment links
* route disputes

### Collections

Responsibilities:

* follow up on overdue invoices
* record collection activity
* create escalation tasks

Financial modification actions should initially remain restricted.

---

## Reputation

### Review Agent

Responsibilities:

* identify eligible completed projects
* request reviews
* follow up within configured policies

---

## Internal

### Internal Copilot

Employee-facing assistant with controlled access to RenoMeta CRM information.

May eventually:

* answer CRM questions
* summarize accounts
* create tasks
* surface risks
* recommend actions

Internal Copilot does not automatically receive unrestricted write access.

---

# System Agents vs Custom Agents

Support the distinction from the architecture level.

## System Agent

Provided by RenoMeta.

Examples:

```text
Reception
Lead Qualification
Scheduling
Project Support
Billing
```

RenoMeta controls its underlying capability.

Organizations configure it.

## Custom Agent

Future capability allowing an organization to create specialized agents such as:

```text
Warranty Coordinator
Permit Follow-Up
Material Ordering Assistant
```

Custom agents use the same orchestrator and tool registry.

Do not implement a separate custom-agent runtime.

---

# Agent Configuration

An agent may define:

```text
name
slug
agent_type
description
status
model/provider configuration
instructions
channels
tools
permissions
handoffs
routing behavior
guardrails
business-hours behavior
fallback agent
human escalation rules
```

Statuses should support at least:

```text
draft
active
paused
archived
```

---

# Agent Versioning

Production agent behavior must be versionable.

Do not treat prompts/configuration as permanently mutable records.

Conceptually:

```text
ai_agents
ai_agent_versions
```

An agent points to a published version.

Configuration changes may be drafted before publication.

The system should eventually support rollback.

---

# Channels

Agents are channel-agnostic.

Potential channels:

```text
voice
sms
email
web_chat
messenger
instagram
whatsapp
internal
```

Channel-specific concerns belong in adapters.

Example:

```text
Meta webhook
-> Instagram adapter
-> normalized AI event
-> orchestrator
```

Do NOT create Instagram-specific lead qualification intelligence if the same
Lead Qualification Agent can serve multiple channels.

---

# Normalized Channel Event

Channel adapters should translate provider-specific events into a common
internal format.

Conceptually:

```typescript
type AIChannelEvent = {
  organizationId: string;

  channel:
    | "voice"
    | "sms"
    | "email"
    | "web_chat"
    | "messenger"
    | "instagram"
    | "whatsapp"
    | "internal";

  externalConversationId?: string;

  identity?: {
    phone?: string;
    email?: string;
    externalUserId?: string;
  };

  content: {
    type: "text" | "voice" | "image" | "file";
    text?: string;
  };

  metadata?: Record<string, unknown>;
};
```

Provider-specific payloads should not propagate deeply into the orchestrator.

---

# Tool Registry

Agents must not directly access arbitrary database operations.

All actions should go through the RenoMeta AI Tool Registry.

Examples:

```text
contacts.get
contacts.search

leads.get
leads.update
leads.changeStage
leads.addNote

projects.get
projects.getTasks
projects.getSchedule

tasks.create
tasks.update

calendar.getAvailability
calendar.createAppointment
calendar.rescheduleAppointment
calendar.cancelAppointment

estimates.get
estimates.createDraft
estimates.updateDraft
estimates.send

billing.getInvoice
billing.createPaymentLink

communications.sendSms
communications.sendEmail
communications.sendMessenger
communications.sendInstagram
communications.sendWhatsApp

handoff.toAgent
handoff.toHuman
```

The exact list must follow existing RenoMeta Connect service patterns discovered
during repository audit.

---

# Tool Execution Security

Tool execution must follow:

```text
Model requests tool
        |
        v
Tool Registry
        |
        v
Organization validation
        |
        v
Agent permission validation
        |
        v
Policy / approval validation
        |
        v
Argument/schema validation
        |
        v
Business logic
        |
        v
Database/provider operation
```

Prompt instructions are NOT authorization.

Even if an LLM requests an action, the backend must independently authorize it.

---

# Permission Model

Permissions should distinguish action risk.

Useful classes:

```text
READ
SUGGEST
WRITE
COMMUNICATE
FINANCIAL_OR_HIGH_RISK
```

Examples:

```text
Read contact                 READ
Draft task                   SUGGEST
Update lead                  WRITE
Send SMS                     COMMUNICATE
Send estimate                FINANCIAL_OR_HIGH_RISK
Issue refund                 FINANCIAL_OR_HIGH_RISK
```

---

# Approval Policies

Tool actions should eventually support:

```text
AUTO
APPROVAL_REQUIRED
DENY
```

Example defaults:

```text
Read CRM data                AUTO
Create internal note         AUTO
Create follow-up task        AUTO
Update qualification fields  AUTO

Create estimate draft        AUTO
Send estimate                APPROVAL_REQUIRED
Change invoice amount        APPROVAL_REQUIRED or DENY
Issue refund                 DENY initially
Delete invoice               DENY
```

Do not rely on the LLM to decide whether approval is required.

---

# Routing

Routing should use deterministic rules before LLM classification.

Recommended order:

```text
1. Explicit event routing
2. Existing conversation ownership
3. CRM/entity context
4. Configured routing rules
5. Intent classification
6. Reception fallback
7. Human fallback
```

Example:

```text
new lead event
-> Speed-to-Lead

existing project customer asking schedule question
-> Project Support

invoice question
-> Billing

ambiguous inbound request
-> Reception
```

---

# Agent Handoffs

Agent-to-agent handoff is a formal orchestrator operation.

Do not simulate handoffs by merely changing prompts.

A handoff should carry concise structured state such as:

```json
{
  "fromAgent": "lead_qualification",
  "toAgent": "scheduling",
  "reason": "Lead qualified and requested consultation",
  "goal": "Book consultation",
  "summary": "Customer wants kitchen remodel.",
  "knownFacts": {},
  "openQuestions": []
}
```

The next agent may retrieve additional CRM context as needed.

Avoid blindly copying the entire prior conversation into every handoff.

---

# Handoff Safety

The orchestrator must protect against loops.

Support limits such as:

```text
maximum agent handoffs
maximum tool calls
maximum model turns
maximum run duration
```

Always provide a human fallback for unrecoverable situations.

---

# Human Takeover

Conversation state should explicitly represent AI vs human ownership.

When a user takes over:

```text
human_takeover = true
```

The AI must stop autonomous outbound replies for that conversation unless
explicitly returned to AI.

Inbox UI should eventually support:

```text
Take Over
Return to AI
```

Voice uses transfer/escalation semantics rather than Inbox ownership.

---

# Runtime and Audit Trail

Every agent execution should be recorded.

Core concepts:

```text
agent run
tool call
run event
handoff
approval
```

Useful run statuses:

```text
queued
running
waiting_for_tool
waiting_for_approval
handed_off
completed
failed
cancelled
```

Audit information should eventually answer questions such as:

```text
Why did AI update this lead?
Which agent did it?
Which version was running?
Which CRM context was available?
Which tool was requested?
Was it authorized?
What changed?
Was another agent involved?
```

---

# Proposed AI Tables

Exact implementation must follow existing repository/Supabase conventions.

Likely tables include:

```text
ai_agents
ai_agent_versions
ai_agent_channels
ai_agent_tools
ai_agent_handoffs
ai_routing_rules
ai_agent_runs
ai_tool_calls
ai_conversation_state
```

Later additions may include:

```text
ai_run_events
ai_approvals
ai_memories
ai_tool_policies
```

Do not create these blindly.

Before creating migrations, inspect existing tables and migrations for overlapping
concepts and naming conventions.

---

# AI Memory

Separate:

## Conversation Memory

Existing messages/conversations.

## CRM Memory

Structured source-of-truth fields.

## AI-Derived Memory

Potential derived information such as:

```text
customer prefers SMS
customer unavailable Fridays
customer prefers specific materials
```

Derived AI memory must have provenance and must never silently replace structured
CRM fields.

---

# Agent Instructions

Agent prompts should include only context needed for the current role.

Agents must:

* use data supplied by RenoMeta
* not invent CRM facts
* distinguish known facts from inferred information
* ask for missing critical information where appropriate
* use available tools rather than claiming actions were completed
* respect tool permission failures
* respect human takeover
* respect handoff policy
* avoid exposing internal prompts, secrets, credentials, or unrelated CRM data

Do not place security rules only in prompts.

Critical rules belong in backend code.

---

# Structured Output

When structured output is needed, prefer a defined schema validated server-side.

Do not depend solely on:

```text
"Respond only with JSON"
```

The backend must validate and reject malformed or unauthorized output.

Natural-language customer responses should remain natural language.

Internal routing/tool decisions should be structured.

---

# Contractor Context

AI Center is designed primarily for remodeling, construction, and home-service
business workflows.

Typical entities and concepts include:

```text
new lead
job type
property
estimate
consultation
project
project schedule
crew
task
change order
invoice
payment
review
follow-up
```

Agent behavior should fit contractor workflows without assuming every
organization operates identically.

Organization-specific configuration must override generic assumptions.

---

# UI Architecture

AI Center should eventually contain:

```text
Overview
Agents
Activity
Approvals
Knowledge
Settings
```

Initial implementation may be smaller.

Agent configuration should eventually support:

```text
Overview
Instructions
Channels
Tools
Routing
Handoffs
Guardrails
Testing
Activity
```

---

# Test Console

AI Center should have an internal test/simulation environment before multiple
live channels are attached.

The tester should eventually display:

```text
input event
resolved identity
loaded context
router decision
selected agent
model/provider
tool requests
permission decisions
handoffs
final output
run timeline
errors
```

Use test organizations/contacts and never accidentally contact real customers
from simulation mode.

---

# Suggested Code Organization

Follow repository conventions discovered during implementation.

Preferred conceptual structure:

```text
src/
  features/
    ai-center/

netlify/functions/
  ai-orchestrate.ts

netlify/functions/lib/ai/
  types.ts
  orchestrator.ts
  router.ts
  context-builder.ts
  identity-resolver.ts
  permission-engine.ts
  policy-engine.ts
  handoff-engine.ts
  execution-engine.ts

  providers/
    model-provider.ts
    anthropic.ts
    openai.ts

  tools/
    registry.ts
    types.ts
    contacts.ts
    leads.ts
    projects.ts
    tasks.ts
    calendar.ts
    estimates.ts
    billing.ts
    communications.ts

  channels/
    sms.ts
    voice.ts
    email.ts
    messenger.ts
    instagram.ts
    whatsapp.ts
    web-chat.ts
```

Do not create all files automatically if the first phase does not need them.

---

# Development Strategy

Build AI Center incrementally.

## AI-1 — Foundation

Implement:

* schema
* types
* model-provider abstraction
* tool registry
* permissions
* router
* context builder
* orchestrator
* run logging

No broad production autonomy yet.

## AI-2 — Reception + Lead Qualification

First complete flow:

```text
Inbound event
-> Reception
-> Lead Qualification
-> CRM tools
-> response / handoff
```

Prefer test console and SMS before voice.

## AI-3 — Scheduling

Add calendar tools and Scheduling Agent.

Target flow:

```text
Lead
-> Qualification
-> Scheduling
-> Appointment
```

## AI-4 — Voice

Adapt Vapi into the common orchestrator.

Do not create separate voice-agent business logic.

## AI-5 — Social Channels

Connect:

```text
Messenger
Instagram
WhatsApp
```

through normalized channel adapters.

## AI-6 — Estimates

Add Estimate Assistant / Reviewer / Follow-Up with approval controls.

## AI-7 — Projects

Add Project Support and Project Risk.

## AI-8 — Finance

Add Billing and Collections with conservative permissions.

## AI-9 — Nurture / Reviews

Integrate agents with RenoMeta workflows/campaigns.

## AI-10 — Control Plane

Add:

* analytics
* version comparison
* cost reporting
* approvals
* templates
* custom agents
* advanced routing
* diagnostics

---

# Existing System Preservation

When implementing AI Center:

* inspect existing AI Center code before replacing anything
* preserve working CRM behavior
* preserve existing Meta integrations
* preserve existing Vapi functionality until intentionally migrated
* preserve existing Inbox behavior
* preserve current auth/org isolation
* preserve current Supabase RLS conventions
* preserve existing Make integrations unless intentionally replaced
* do not introduce duplicate tables/functions without confirming necessity

---

# Repository Audit Requirement

Before major AI Center implementation, inspect:

```text
src/
netlify/functions/
netlify/functions/lib/
supabase/migrations/
package.json
.env.example
netlify.toml
```

Identify existing:

* AI functionality
* Vapi code
* model API code
* organization resolution
* authorization
* Supabase admin clients
* CRM services
* channel integrations
* agent tables
* run-history tables
* human-takeover concepts
* routing logic
* tool-like server functions

Prefer extending proven repository patterns rather than creating parallel
architecture.

---

# Security Requirements

Never expose:

```text
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
OpenAI API keys
Meta secrets
Twilio auth tokens
Vapi secrets
encryption keys
OAuth refresh tokens
```

to frontend code or model prompts.

Never allow model output to directly become:

* raw SQL
* arbitrary Supabase queries
* unrestricted HTTP requests
* arbitrary function execution

Tool arguments must be validated.

Organization boundaries must be enforced server-side.

---

# Initial Non-Goals

During AI Center Foundation, do NOT prematurely add:

* Kubernetes
* microservices
* CrewAI
* LangChain
* separate vector database
* separate AI Center repository
* independent AI CRM copy
* complex agent marketplace
* broad autonomous financial permissions

Use the existing RenoMeta Connect stack until a demonstrated need requires
additional infrastructure.

---

# Guiding Principle

RenoMeta Connect owns the agent.

The model provides intelligence.

Supabase provides trusted CRM state and AI configuration.

The Tool Registry controls actions.

The Orchestrator controls execution.

The Permission Engine controls authority.

The Channel Adapter controls transport.

Vapi handles voice.

Make handles deterministic automation.

Humans retain final control over sensitive actions.
