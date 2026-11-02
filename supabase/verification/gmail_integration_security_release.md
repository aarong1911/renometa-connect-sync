# Gmail + integration credential security — release runbook

Release candidate: branch `release/gmail-integration-security-rc` = PR #34 (`d638fee`) + the integration credential security fix.

Rules for every step below:

- Use only the internal test organization and test accounts.
- Never test against, or change, Skyway Chimney Fireplace or any other customer organization.
- No live customer email or SMS.

## 1. Deploy Preview checklist

Test accounts you need in the test organization: one **owner**, one **admin** and one **sales** member. You also need a second test organization with its own owner.

### Layout (repeat on desktop, tablet ~768px, 375px mobile, each in light and dark mode)

- [ ] Settings → Integrations: card grid, provider logos and the compact Google-first Gmail card render without overflow or clipped text.
- [ ] Open the Twilio drawer, the Stripe drawer (setup instructions visible) and the Gmail advanced SMTP section. Each fits the viewport and scrolls on mobile.
- [ ] Every status badge (Connected / Not connected / Reconnect needed) is readable in dark mode.

### Gmail (test mailbox only)

- [ ] Connect Gmail as owner. The OAuth consent screen shows the same scopes as PR #34. The card turns Connected.
- [ ] Reconnect from the card. No duplicate connection; sync resumes.
- [ ] Manual sync pulls new test messages into Conversations.
- [ ] Reply from Conversations to the test mailbox. The message arrives, threads correctly, and appears once in Sent.
- [ ] Send a test estimate and a test change order to the test mailbox via Gmail.
- [ ] Send a marketing campaign to a test-only list (one or two internal addresses).
- [ ] Advanced → legacy SMTP: save an App Password pasted with spaces. The save succeeds and the password is never shown back. Then remove it.
- [ ] As admin and as sales: Gmail connect, disconnect and SMTP save are refused with the owner-only message. Sending email from Conversations still works.

### Twilio and other API-key integrations (test Twilio sub-account)

- [ ] As owner, open the Twilio drawer. The Account SID and phone number pre-fill, and the Auth Token field is **empty**.
- [ ] In DevTools → Network, the `integration-config-status` response contains no `authToken`, `secretKey`, `apiKey` or `appPassword` field or value.
- [ ] Save with the Auth Token left blank. The save succeeds, and an outbound test SMS still sends, so the stored token was kept.
- [ ] Save with a deliberately wrong Account SID format. You see a clear validation error, and nothing changes.
- [ ] Disconnect Twilio, then reconnect it. Only Twilio changes; Stripe and Gmail status are untouched.
- [ ] Stripe: save a `sk_test_…` key. Status shows configured, and the key is never shown again.

### Owner-only enforcement (run from the browser console or curl with each user's access token)

- [ ] `GET /.netlify/functions/integration-config-status` returns: owner 200; admin, sales and field_worker 403; no token 401.
- [ ] `POST /.netlify/functions/integration-config-save` with `{"provider":"twilio","orgId":"<other test org>", ...}` as owner changes only the owner's own org.
- [ ] `smtp-config-save` and `smtp-disconnect` as admin or sales return 403.

### SMS (test numbers only)

- [ ] Outbound SMS from Conversations as owner and as sales.
- [ ] Inbound SMS to the test number reaches Conversations. The Twilio signature check passes; Netlify logs show no 403 from the webhook.
- [ ] STOP and START keywords on the test number still work.

### Organization settings and onboarding

- [ ] Settings → Organization: rename, phone, website, address and timezone save. The sidebar name and logo update.
- [ ] Settings → Branding logo upload; Settings → Appointments reminder toggle and minutes save.
- [ ] Sign up a brand-new test account and complete onboarding, including a logo. The organization is created and the dashboard loads.
- [ ] Estimate PDF header shows the org name, logo, email, phone and address.

### Realtime

- [ ] With the test org open as sales in one browser, change the logo as owner in another. The sales sidebar logo updates live.

### Field and Portal

- [ ] Field: open a test `/welcome?token=` link. The welcome card renders.
- [ ] Portal: open a test portal link. Branding, project data, messages and photos load, and sending a test message works.

## 2. Production release sequence

Each step has a stop condition. If it fails, stop and roll back that step only.

1. **Code deploy.**
   - Release the RC branch (after approval).
   - The code works with today's database grants, so this step alone breaks nothing.
   - Smoke test: Integrations page as owner, one test SMS, one Gmail send to the test mailbox.
   - Rollback: Netlify "Publish deploy" of the previous production deploy.
2. **Same day — preflight.**
   - Run `organizations_integration_settings_preflight.sql` and save all output.
   - Stop unless every GATE passes. Sections 7c (Realtime filters columns), 10 (RPC containment still holds) and 12 (membership containment applied) are hard gates.
3. **Apply `20261102_organizations_integration_settings_privileges.sql`.**
   - If it raises, nothing changed. Read the message and stop.
4. **Postflight.**
   - Run `organizations_integration_settings_postflight.sql`. All 12 probes must say OK and 5b must show the containment intact.
   - Then do 6a–6d with the test org, including the Realtime frame check (6b).
   - If anything breaks: run `organizations_integration_settings_rollback.sql`, or the saved preflight 1b statements.
   - If only Realtime leaks: run `organizations_integration_settings_realtime_contingency.sql` instead.
5. **Production smoke test** (test org only): repeat the Twilio, Gmail, SMS, onboarding and Portal items above.
6. **Twilio rotation** (only after 4 passes, so the new token can never be read or broadcast).
   - Issue a new auth token in the Twilio console.
   - The org owner saves it through Settings → Integrations.
   - Send a test SMS and receive an inbound test SMS.
   - Then revoke the old token in Twilio.
7. **Close out.**
   - Record the applied SQL and its output in the release notes.
   - Plan the encryption of the Twilio token at rest (see the Phones S1 drafts).
