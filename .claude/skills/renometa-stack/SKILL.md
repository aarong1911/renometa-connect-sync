---
name: renometa-stack
description: >
  Full project context for RenoMeta Connect — a CRM/project management SaaS for
  home improvement contractors. Covers the complete stack, all Supabase identifiers,
  env vars, deployment URLs, database schema, storage buckets, Netlify functions,
  Voice AI (Vapi) patterns, portal architecture, role/permission system, OAuth token
  decryption, Make.com automations, and every critical gotcha from 12+ months of
  development sessions. Use at the START of any session involving RenoMeta Connect,
  the client portal, field app, marketing site, or any feature in the platform.
  Also triggers on: home-service-hub, connect.renometa.com, portal.renometa.com,
  tbtonsdemrcqtfhoocop, Vapi Voice AI, portal invites, invoices, projects drawer,
  team members, permissions matrix, Meta Ads integration.
---

# RenoMeta Connect — Full Stack Reference

## Project Identifiers

```
Supabase:     tbtonsdemrcqtfhoocop
Supabase URL: https://tbtonsdemrcqtfhoocop.supabase.co
Org ID:       d7963ad6-4bfe-4cc2-b9c2-949a02a3fa72
Owner user:   f4ec461f-9df6-4a2f-b2e1-1b421df475c1
Connect:      https://connect.renometa.com
Portal:       https://portal.renometa.com  (portalreno.netlify.app)
Field app:    https://field.renometa.com
Marketing:    https://renometa.com  (aarong1911/renometa-website-v5)
Repo:         github.com/aarong1911/home-service-hub
Local:        C:\Users\info\OneDrive\Desktop\RenoMeta Apps\home-service-hub
GCP project:  549459729443  (Google Calendar API)
Vapi phone:   9a024622-c69e-4035-93fa-ffb6b8a3ca00
```

## Stack

- React 18 + TypeScript + Vite 7
- TanStack Router (file-based) + TanStack Query
- Supabase (auth, DB, storage, realtime)
- Netlify (hosting + serverless functions)
- shadcn/ui + Tailwind + Lucide + Sonner
- **pnpm only** — never npm/yarn

## Commands

```bash
pnpm dev        # Vite :5173
netlify dev     # :9999 (Node 20 required — crashes on Node 24)
pnpm build
pnpm tsc
```

## Environment Variables

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
SMTP_USER=support@renometa.com
SMTP_PASSWORD              # Gmail app password (NOT SMTP_PASS)
STRIPE_SECRET_KEY
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER, NOTIFY_PHONE_NUMBER
VAPI_API_KEY               # Server-side
VITE_VAPI_PUBLIC_KEY       # Client-side browser test calls
VITE_GOOGLE_PLACES_API_KEY
ENCRYPTION_KEY             # AES-256-GCM for OAuth token decryption
ANTHROPIC_API_KEY          # Claude API for AI Center
```

## Key Netlify Functions

| Function | Purpose |
|---|---|
| `invite-member.ts` | Team invite (no project_id) |
| `portal-invite.ts` | Client portal invite → slug URL |
| `portal-action.ts` | Portal: message + Twilio SMS, approve, Stripe pay |
| `portal-data.ts` | Token → project data |
| `vapi-webhook.ts` | Vapi Voice AI webhook |
| `gcal-sync.ts` | Google Calendar sync |
| `gmail-sync.ts` | Gmail sync |
| `run-agent.ts` | AI Center agent execution |
| `run-tool.ts` | AI Center tool execution |
| `meta-oauth-start/callback.ts` | Meta Ads OAuth |
| `generate-ad-variations.ts` | AI ad generation |

## Database — Key Tables

```
profiles, organizations, org_memberships, invitations
projects, project_notes, project_files, contacts, leads
invoices, invoice_items, estimates, appointments, tasks
voice_agents, voice_calls, voice_call_tools
meta_connections, ad_drafts
member_permissions    ← per-member action overrides (owner only)
workflows, workflow_nodes, workflow_edges, workflow_runs
agent_definitions, agent_instances, agent_runs
tool_definitions, tool_runs

KEY: invitations.project_id
  NULL = team invite | SET = portal invite
```

## Storage Buckets

```
project-photos  PUBLIC  ← project photos
project-files   Auth    ← documents
org-assets      Public  ← logos
proposal-pdfs   Auth
```

## Role System

```
owner          → all pages + settings (exclusive)
admin          → all except settings
office_manager → ops (no automation/insights/settings)
estimator      → leads + estimates + inbox/templates
sales          → leads + estimates + pipeline + broadcasts
project_manager→ projects + tasks + calendar + files + contacts
field_worker   → redirect https://field.renometa.com
accountant     → financials + analytics only
viewer         → redirect https://portal.renometa.com
```

## Portal Architecture

```
portal.renometa.com/p/{slug}      ← pretty URL
portal.renometa.com/portal?token= ← legacy

Invite: invitations (role:viewer + project_id + portal_slug)
Data: Supabase RPC get_portal_data(p_token?, p_slug?)
Actions: portal-action.ts — send_message, approve_estimate, create_payment
Photos: project-photos bucket (public)
Payment: Stripe Checkout (apiVersion: "2026-04-22.dahlia")
```

## Voice AI (Vapi) — Critical Patterns

```typescript
// Phone numbers: MUST send assistantId:null explicitly
{ serverUrl: WEBHOOK_URL, assistantId: null }

// Events: handle BOTH formats
"call-started" | "assistant.started"
"call-ended"   | "call.ended"

// fn.arguments: plain OBJECT not JSON string
const args = typeof fn.arguments === "string"
  ? JSON.parse(fn.arguments) : fn.arguments;

// Vapi Web SDK: window singleton
if (!window.__vapiInstance) {
  const { default: Vapi } = await import("@vapi-ai/web");
  window.__vapiInstance = new Vapi(process.env.VITE_VAPI_PUBLIC_KEY);
}

// Calendar ISO: must include UTC offset, use getUTC* methods
// Billing: $0.35/min ceiling-rounded shown to users
```

## All Gotchas

| Issue | Fix |
|---|---|
| Node 24 + netlify dev | Use Node 20 |
| `as any` on routes | Remove, run pnpm dev |
| `SMTP_PASSWORD` | NOT `SMTP_PASS` |
| `message` variable | Conflicts DOM global → `clientMessage` |
| `body` variable in fn | Conflicts response field → `reqBody` |
| Portal invites in team | `.is("project_id", null)` filter |
| Photo bucket | `project-photos` NOT `project-files` |
| Stripe API version | `"2026-04-22.dahlia"` |
| Vapi `assistantId` | Send `null` explicitly |
| Vapi `fn.arguments` | Object not JSON string |
| Calendar ISO | Must include UTC offset |
| pnpm only | Never npm/yarn |