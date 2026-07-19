// netlify/functions/meta-oauth-callback.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// meta-oauth-callback.ts
//
// Facebook redirects here (still inside the popup window opened by
// meta-oauth-start.ts) after the user authorizes Business Asset access.
//
// IMPORTANT: meta_connections already existed before this feature (built
// for Meta Ads), with this real column shape:
//   id, org_id, user_id, meta_user_id, meta_user_name, access_token (text,
//   historically PLAINTEXT), token_type, expires_at, granted_scopes (array),
//   ad_account_id, ad_account_name, page_id, page_name, ig_actor_id,
//   is_active, connected_at, updated_at
// Extended by supabase/migrations/002_meta_connections_extend.sql with:
//   waba_id, waba_phone_number_id, waba_display_phone, ig_username,
//   meta_user_picture_url, business_id, business_name, connected_products
// Then migrated by supabase/migrations/006_meta_connections_per_product.sql
// to ONE ROW PER (org_id, product) instead of one shared row with a
// connected_products array — fixes a real bug where connecting one
// product (e.g. WhatsApp) made other products (Ads, Lead Ads) show as
// "Connected" too, since the array only ever grew and was never
// per-product-scoped. connected_products no longer exists as a column.
//
// access_token is a `text` column, not `bytea`. We write an ENCRYPTED
// base64 string into it going forward (see encryptToken below) rather than
// plaintext — any pre-existing Ads row written before this change may still
// hold a plaintext token; reader code must handle both (see
// meta-send-whatsapp.ts decryptOrPlaintext()). Note: meta-send-whatsapp.ts
// was deleted as redundant with send-inbox-message.ts's WhatsApp branch.
//
// See .claude/skills/meta-integrations/SKILL.md for the full design.
// ─────────────────────────────────────────────────────────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function verifyState(state: string, secret: string): { orgId: string; userId: string; product: string } | null {
  try {
    const [payloadB64, sig] = state.split(".");
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (sig !== expectedSig) return null;
    const parsed = JSON.parse(payload);
    if (Date.now() - parsed.ts > 10 * 60 * 1000) return null;
    if (!parsed.userId) return null;
    return { orgId: parsed.orgId, userId: parsed.userId, product: parsed.product };
  } catch {
    return null;
  }
}

// Encrypt with AES-256-GCM (key = SHA-256(ENCRYPTION_KEY)), output as a
// single base64 string: base64(iv(12) || authTag(16) || ciphertext).
// Stored directly in the `access_token` text column — prefixed with "enc:"
// so reader code can tell an encrypted value apart from a legacy plaintext
// token without needing to attempt-and-catch on every read.
function encryptToken(plaintext: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot encrypt Meta token");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "enc:" + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function popupResponse(success: boolean, message: string): { statusCode: number; headers: any; body: string } {
  const html = `<!DOCTYPE html>
<html><body>
<script>
  window.opener && window.opener.postMessage(
    { source: "meta-oauth", success: ${success ? "true" : "false"}, error: ${JSON.stringify(success ? null : message)} },
    window.location.origin
  );
  window.close();
</script>
<p>${success ? "Connected. You can close this window." : `Connection failed: ${message}`}</p>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: html };
}

export const handler: Handler = async (event) => {
  const params = event.queryStringParameters ?? {};
  const { code, state, error: fbError, error_description } = params;

  if (fbError) {
    return popupResponse(false, error_description || fbError);
  }
  if (!code || !state) {
    return popupResponse(false, "Missing code or state from Facebook redirect");
  }

  const stateSecret = process.env.META_OAUTH_STATE_SECRET || process.env.ENCRYPTION_KEY;
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!stateSecret || !appId || !appSecret) {
    return popupResponse(false, "Meta OAuth is not configured on the server");
  }

  const verified = verifyState(state, stateSecret);
  if (!verified) {
    return popupResponse(false, "Invalid or expired connection request — please try again");
  }
  const { orgId, userId, product } = verified;

  const siteUrl = process.env.URL || "https://connect.renometa.com";
  const redirectUri = `${siteUrl}/.netlify/functions/meta-oauth-callback`;

  try {
    // 1. Exchange code → short-lived user access token
    const shortTokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code=${encodeURIComponent(code)}`,
    );
    const shortTokenJson = await shortTokenRes.json();
    if (!shortTokenRes.ok || !shortTokenJson.access_token) {
      console.error("[meta-oauth-callback] short-lived token exchange failed:", shortTokenJson);
      return popupResponse(false, "Facebook did not return an access token");
    }

    // 2. Exchange short-lived → long-lived token (~60 days)
    const longTokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&fb_exchange_token=${encodeURIComponent(shortTokenJson.access_token)}`,
    );
    const longTokenJson = await longTokenRes.json();
    const accessToken: string = longTokenJson.access_token || shortTokenJson.access_token;
    const expiresInSec: number | undefined = longTokenJson.expires_in || shortTokenJson.expires_in;
    const tokenType: string = longTokenJson.token_type || shortTokenJson.token_type || "bearer";

    // 3. Business Asset User Profile Access — id, name, picture
    const meRes = await fetch(
      `https://graph.facebook.com/v21.0/me?fields=id,name,picture&access_token=${encodeURIComponent(accessToken)}`,
    );
    const me = await meRes.json();
    if (!meRes.ok || !me.id) {
      console.error("[meta-oauth-callback] /me fetch failed:", me);
      return popupResponse(false, "Could not read the connected Facebook profile");
    }

    // 4. Confirm granted scopes (Meta returns this via debug_token, but for
    //    our purposes the permissions list from /me/permissions is simpler)
    let grantedScopes: string[] = [];
    try {
      const permsRes = await fetch(
        `https://graph.facebook.com/v21.0/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
      );
      const perms = await permsRes.json();
      grantedScopes = (perms?.data ?? [])
        .filter((p: any) => p.status === "granted")
        .map((p: any) => p.permission);
    } catch (e) {
      console.warn("[meta-oauth-callback] permissions fetch failed:", e);
    }

    // 5. Discover business + product-specific assets (best-effort).
    //
    // IMPORTANT: each OAuth run only re-discovers the fields relevant to the
    // product being connected (e.g. connecting "meta-ads" doesn't touch
    // WhatsApp's waba_id). Fetch the existing row FIRST and fall back to its
    // values for every field below — otherwise connecting a second product
    // would null out everything the first product already discovered, since
    // this function upserts the whole row every time.
    // Explicitly typed here because supabaseAdmin is created via createClient()
    // with no <Database> generic anywhere in this codebase, so the Supabase
    // client can't infer a row shape for .select() and TypeScript falls back
    // to GenericStringError, which breaks property access below (e.g.
    // existingRow.business_id). This cast is the fix, not a workaround —
    // it'll keep being needed unless/until the project adopts a typed
    // `createClient<Database>(...)` with real generated Supabase types.
    //
    // With the per-product schema (see
    // supabase/migrations/006_meta_connections_per_product.sql), each
    // (org_id, product) pair has its OWN row — connecting WhatsApp can
    // never again affect what's stored for Ads or Lead Ads, so there's no
    // need to fetch-and-preserve-other-fields the way the old shared-row
    // design required. Still fetch the existing row for THIS product, in
    // case re-discovery of one field fails on a reconnect but others
    // already have good values from a prior successful connect.
    interface ExistingMetaConnectionRow {
      business_id: string | null;
      business_name: string | null;
      page_id: string | null;
      page_name: string | null;
      ig_actor_id: string | null;
      ig_username: string | null;
      waba_id: string | null;
      waba_phone_number_id: string | null;
      waba_display_phone: string | null;
      ad_account_id: string | null;
      ad_account_name: string | null;
    }

    const productKey =
      product === "whatsapp" ? "whatsapp" :
      product === "fb-messenger" ? "messenger" :
      product === "instagram-direct" ? "instagram" :
      product === "meta-ads" ? "ads" :
      "lead_ads";

    const { data: existingRow } = (await supabaseAdmin
      .from("meta_connections")
      .select(
        "business_id, business_name, page_id, page_name, ig_actor_id, ig_username, waba_id, waba_phone_number_id, waba_display_phone, ad_account_id, ad_account_name",
      )
      .eq("org_id", orgId)
      .eq("product", productKey)
      .maybeSingle()) as unknown as { data: ExistingMetaConnectionRow | null };

    let businessId: string | null = null;
    let businessName: string | null = null;
    let pageId: string | null = null;
    let pageName: string | null = null;
    let igActorId: string | null = null;
    let igUsername: string | null = null;
    let wabaId: string | null = null;
    let wabaPhoneNumberId: string | null = null;
    let wabaDisplayPhone: string | null = null;
    let adAccountId: string | null = null;
    let adAccountName: string | null = null;

    try {
      const bizRes = await fetch(
        `https://graph.facebook.com/v21.0/me/businesses?access_token=${encodeURIComponent(accessToken)}`,
      );
      const biz = await bizRes.json();
      const firstBusiness = biz?.data?.[0];
      if (firstBusiness) {
        businessId = firstBusiness.id;
        businessName = firstBusiness.name;
      }
    } catch (e) {
      console.warn("[meta-oauth-callback] business discovery failed:", e);
    }

    try {
      const pagesRes = await fetch(
        `https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(accessToken)}`,
      );
      const pages = await pagesRes.json();
      const firstPage = pages?.data?.[0];
      if (firstPage) {
        pageId = firstPage.id;
        pageName = firstPage.name;

        if (product === "instagram-direct") {
          try {
            const igRes = await fetch(
              `https://graph.facebook.com/v21.0/${firstPage.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(accessToken)}`,
            );
            const ig = await igRes.json();
            if (ig?.instagram_business_account) {
              igActorId = ig.instagram_business_account.id;
              igUsername = ig.instagram_business_account.username;
            }
          } catch (e) {
            console.warn("[meta-oauth-callback] IG account discovery failed:", e);
          }
        }
      }
    } catch (e) {
      console.warn("[meta-oauth-callback] page discovery failed:", e);
    }

    if (product === "whatsapp" && businessId) {
      try {
        const wabaListRes = await fetch(
          `https://graph.facebook.com/v21.0/${businessId}/owned_whatsapp_business_accounts?access_token=${encodeURIComponent(accessToken)}`,
        );
        const wabaList = await wabaListRes.json();
        const firstWaba = wabaList?.data?.[0];
        if (firstWaba) {
          wabaId = firstWaba.id;
          const phonesRes = await fetch(
            `https://graph.facebook.com/v21.0/${firstWaba.id}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`,
          );
          const phones = await phonesRes.json();
          const firstPhone = phones?.data?.[0];
          if (firstPhone) {
            wabaPhoneNumberId = firstPhone.id;
            wabaDisplayPhone = firstPhone.display_phone_number;
          }
        }
      } catch (e) {
        console.warn("[meta-oauth-callback] WABA discovery failed:", e);
      }
    }

    if (product === "meta-ads") {
      try {
        // /me/adaccounts returns ad accounts directly owned by/granted to this
        // user — broader and simpler than going through the business node,
        // and works for both personal and business-owned ad accounts.
        const adAccountsRes = await fetch(
          `https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status&access_token=${encodeURIComponent(accessToken)}`,
        );
        const adAccounts = await adAccountsRes.json();
        // account_status === 1 means ACTIVE — prefer an active account if
        // multiple come back, otherwise fall back to the first one
        const accounts: any[] = adAccounts?.data ?? [];
        const activeAccounts = accounts.filter((a) => a.account_status === 1);
        // Prefer a business-owned account (name contains "RenoMeta") over a
        // personal ad account — personal accounts cannot create ads when the
        // app is in Development mode, but business-owned accounts can.
        const preferred =
          activeAccounts.find((a) => /renometa/i.test(a.name)) ??
          activeAccounts[0] ??
          accounts[0];
        if (preferred) {
          adAccountId = preferred.id.startsWith("act_") ? preferred.id.slice(4) : preferred.id;
          adAccountName = preferred.name;
        }
      } catch (e) {
        console.warn("[meta-oauth-callback] ad account discovery failed:", e);
      }
    }

    // 6. Encrypt token — written as "enc:<base64>" into the existing text column
    const encryptedToken = encryptToken(accessToken);
    const expiresAt = expiresInSec
      ? new Date(Date.now() + expiresInSec * 1000).toISOString()
      : null;

    // 7. Upsert — ONE ROW PER (org_id, product). No connected_products
    //    merge logic needed anymore: this row IS the record of this one
    //    product's connection, full stop. Connecting a different product
    //    creates/updates a SEPARATE row and cannot affect this one.
    const { error: upsertErr } = await supabaseAdmin
      .from("meta_connections")
      .upsert(
        {
          org_id: orgId,
          product: productKey,
          user_id: userId,
          meta_user_id: me.id,
          meta_user_name: me.name ?? null,
          meta_user_picture_url: me.picture?.data?.url ?? null,
          business_id: businessId ?? existingRow?.business_id ?? null,
          business_name: businessName ?? existingRow?.business_name ?? null,
          page_id: pageId ?? existingRow?.page_id ?? null,
          page_name: pageName ?? existingRow?.page_name ?? null,
          ig_actor_id: igActorId ?? existingRow?.ig_actor_id ?? null,
          ig_username: igUsername ?? existingRow?.ig_username ?? null,
          waba_id: wabaId ?? existingRow?.waba_id ?? null,
          waba_phone_number_id: wabaPhoneNumberId ?? existingRow?.waba_phone_number_id ?? null,
          waba_display_phone: wabaDisplayPhone ?? existingRow?.waba_display_phone ?? null,
          ad_account_id: adAccountId ?? existingRow?.ad_account_id ?? null,
          ad_account_name: adAccountName ?? existingRow?.ad_account_name ?? null,
          access_token: encryptedToken,
          token_type: tokenType,
          expires_at: expiresAt,
          granted_scopes: grantedScopes,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_id,product" },
      );

    if (upsertErr) {
      console.error("[meta-oauth-callback] upsert failed:", upsertErr.message);
      return popupResponse(false, "Could not save the connection — please try again");
    }

    return popupResponse(true, "");
  } catch (err: any) {
    console.error("[meta-oauth-callback] unhandled error:", err.message);
    return popupResponse(false, "Unexpected error connecting to Facebook");
  }
};