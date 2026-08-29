// netlify/functions/lib/meta-messaging.ts
//
// Meta Messaging Webhook Hardening — Facebook Page Messenger and Instagram
// Direct subscription wiring. Same audit finding Phase 1B / Step 2
// discovered for Lead Ads applies here: a Page never receives ANY webhook
// delivery until the app has explicitly subscribed it via
// POST /{page_id}/subscribed_apps. Granting OAuth scopes does NOT
// auto-subscribe a Page to anything.
//
// FIELD SELECTION — audited against the actual handler in meta-webhook.ts
// (processMessengerOrInstagramPayload), not assumed:
//   - It reads entry[].messaging[] items, extracts msgEvent.message.text,
//     and skips msgEvent.message.is_echo. It does NOT read
//     msgEvent.postback, msgEvent.reaction, or any comments/mentions shape.
//   - Required Page field: "messages" only. "messaging_postbacks",
//     "message_reactions", "feed"/comments/mentions are NOT subscribed here
//     because nothing in the current handler processes them — subscribing
//     unimplemented fields would just mean silently-dropped deliveries.
//
// INSTAGRAM SUBSCRIPTION MECHANISM — this repo's OAuth flow
// (meta-oauth-callback.ts, product "instagram-direct") never obtains a
// separate Instagram-user access token; it discovers ig_actor_id by reading
// `/{page_id}?fields=instagram_business_account` using the connected FACEBOOK
// PAGE's own token, and meta-webhook.ts routes `object: "instagram"`
// deliveries through the exact same entry[].messaging[] shape as Messenger,
// keyed by `entry.id` = the linked Page's id. This is the classic
// "Instagram Messaging via a connected Facebook Page" model (as opposed to
// the newer standalone Instagram API with Instagram Login, which needs an
// IG-user-scoped token and subscribes /{ig-user-id}/subscribed_apps
// directly) — the schema and OAuth flow structurally only support the
// former. Instagram subscription below therefore uses the SAME Page-level
// /{page_id}/subscribed_apps call as Messenger, with the Page's derived
// token, not a separate Instagram-asset-level call. This has NOT been
// independently re-verified against a live Graph response this session —
// see the report's "must check manually in Meta Dashboard" section.
//
// Both helpers preserve every other already-subscribed field (e.g. Lead
// Ads' "leadgen" must survive a Messenger/Instagram reconnect) and are
// idempotent. No token is ever persisted or logged.

import { ensureMetaPageSubscriptionFromUserToken, type EnsurePageSubscriptionResult } from "./meta-page-access";

const MESSENGER_REQUIRED_FIELDS = ["messages"];
const INSTAGRAM_REQUIRED_FIELDS = ["messages"];

export async function ensureMetaMessengerSubscription(
  userAccessToken: string,
  pageId: string,
): Promise<EnsurePageSubscriptionResult> {
  return ensureMetaPageSubscriptionFromUserToken(userAccessToken, pageId, MESSENGER_REQUIRED_FIELDS);
}

export async function ensureMetaInstagramSubscription(
  userAccessToken: string,
  pageId: string,
): Promise<EnsurePageSubscriptionResult> {
  return ensureMetaPageSubscriptionFromUserToken(userAccessToken, pageId, INSTAGRAM_REQUIRED_FIELDS);
}
