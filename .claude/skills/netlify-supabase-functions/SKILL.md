---
name: netlify-supabase-functions
description: >
  Patterns and boilerplate for writing Netlify serverless functions that use
  Supabase — including auth validation, service role client setup, CORS headers,
  error handling, and common query patterns. Use whenever writing or editing any
  file in netlify/functions/ that interacts with Supabase, handles webhooks,
  sends email via nodemailer/SMTP, processes Stripe payments, or sends SMS via
  Twilio. Also triggers for portal-action, portal-invite, invite-member, run-agent,
  run-tool, or any similar serverless function pattern.
---

# Netlify + Supabase Functions Skill

## Standard Template

```typescript
/// <reference types="node" />
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  // Use reqBody not body (conflicts with response field)
  let reqBody: { /* typed fields */ };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
```

## Auth Validation

```typescript
const authToken = event.headers.authorization?.slice(7);
if (!authToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid token" }) };
const { data: profile } = await supabaseAdmin
  .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
const orgId = profile?.organization_id;
```

## Portal Token Validation (token OR slug)

```typescript
let inv: any = null;
if (token) {
  const { data } = await supabaseAdmin.from("invitations").select("*")
    .eq("token", token).in("status", ["pending","roster_only","accepted"]).maybeSingle();
  inv = data;
}
if (!inv && reqBody.slug) {
  const { data } = await supabaseAdmin.from("invitations").select("*")
    .eq("portal_slug", reqBody.slug).in("status", ["pending","roster_only","accepted"]).maybeSingle();
  inv = data;
}
if (!inv || inv.role !== "viewer")
  return { statusCode: 403, headers, body: JSON.stringify({ error: "Access denied" }) };
```

## Email (nodemailer)

```typescript
import nodemailer from "nodemailer";
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 587, secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }, // SMTP_PASSWORD not SMTP_PASS
});
await transporter.sendMail({ from: `"${orgName}" <${process.env.SMTP_USER}>`, to, subject, html });
```

## Twilio SMS

```typescript
const smsBody = "Your message here";
await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
  method: "POST",
  headers: {
    "Authorization": `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER!, To: toPhone, Body: smsBody }).toString(),
});
```

## Stripe Checkout

```typescript
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" });
const session = await stripe.checkout.sessions.create({
  payment_method_types: ["card"],
  line_items: [{ price_data: { currency: "usd", product_data: { name }, unit_amount: amountInCents }, quantity: 1 }],
  mode: "payment",
  success_url: `${PORTAL_URL}/portal?token=${token}&paid=1`,
  cancel_url: `${PORTAL_URL}/portal?token=${token}`,
});
```

## Claude API (AI Center)

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5",  // haiku for speed, sonnet for reasoning
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  }),
});
const data = await response.json();
const text = data.content[0].text;
// For JSON output: add "Respond ONLY with valid JSON. No markdown." to system prompt
```

## Gotchas

| Issue | Fix |
|---|---|
| `message` variable | Conflicts DOM global → use `clientMessage` or `msgText` |
| `body` variable | Conflicts Netlify response field → use `reqBody` |
| `SMTP_PASSWORD` | NOT `SMTP_PASS` |
| Stripe API version | `"2026-04-22.dahlia"` |
| Portal invites | Always have `project_id` set; team invites have it null |
| Photo bucket | `project-photos` not `project-files` |
| CORS for portal | Always include `Access-Control-Allow-Origin: *` |
