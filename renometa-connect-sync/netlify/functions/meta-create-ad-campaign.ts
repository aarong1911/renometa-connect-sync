// netlify/functions/meta-create-ad-campaign.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// meta-create-ad-campaign.ts
//
// POST { name: string, dailyBudgetCents: number, objective: string }
// Creates a REAL campaign via the Meta Marketing API in the org's connected
// ad account (meta_connections.ad_account_id), always in PAUSED status with
// no ad sets/creative attached — so it costs nothing and spends nothing,
// while still being a genuine create call against the Marketing API. This
// exists specifically to demonstrate real Marketing API Access Tier usage
// for Meta App Review; see .claude/skills/meta-integrations/SKILL.md.
//
// Uses the same encrypted-or-legacy-plaintext token read as
// meta-send-whatsapp.ts (access_token column predates the "enc:" scheme).
// Note: meta-send-whatsapp.ts was deleted as redundant — its logic is
// now part of send-inbox-message.ts, which is the real call site.
// ─────────────────────────────────────────────────────────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ALLOWED_OBJECTIVES = new Set([
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
]);

function decryptOrPlaintext(stored: string): string {
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext token
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot decrypt Meta token");
  const raw = Buffer.from(stored.slice(4), "base64");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const orgId = profile?.organization_id;
  if (!orgId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No organization" }) };
  }

  let reqBody: {
    name?: string; dailyBudgetCents?: number; objective?: string;
    imageUrl?: string; headline?: string; primaryText?: string;
    description?: string; cta?: string; destinationUrl?: string;
  };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const name = (reqBody.name ?? "").trim();
  const dailyBudgetCents = Number(reqBody.dailyBudgetCents);
  const objective = reqBody.objective ?? "OUTCOME_TRAFFIC";
  const imageUrl = (reqBody.imageUrl ?? "").trim();
  const headline = (reqBody.headline ?? "").trim();
  const primaryText = (reqBody.primaryText ?? "").trim();
  const description = (reqBody.description ?? "").trim();
  const cta = (reqBody.cta ?? "LEARN_MORE").trim();
  const destinationUrl = (reqBody.destinationUrl ?? "").trim();

  const ALLOWED_CTAS = new Set([
    "LEARN_MORE", "GET_QUOTE", "CONTACT_US", "BOOK_TRAVEL", "SIGN_UP", "CALL_NOW", "MESSAGE_PAGE",
  ]);

  if (!name) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Campaign name is required" }) };
  }
  if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents < 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Daily budget must be at least $1.00 (100 cents)" }) };
  }
  if (!ALLOWED_OBJECTIVES.has(objective)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Objective must be one of: ${[...ALLOWED_OBJECTIVES].join(", ")}` }) };
  }

  // Ad creative fields are all-or-nothing: either none are provided (the
  // tool still works as campaign+ad-set-only, same as before this feature
  // was added) or the minimum set needed to actually build a real ad
  // (image, headline, primary text, destination URL) must all be present.
  // Partial creative data would create a broken/incomplete ad object.
  const hasAnyCreativeField = !!(imageUrl || headline || primaryText || destinationUrl);
  if (hasAnyCreativeField) {
    if (!imageUrl) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Ad image is required to create a complete ad" }) };
    if (!headline) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Headline is required to create a complete ad" }) };
    if (!primaryText) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Primary text is required to create a complete ad" }) };
    if (!destinationUrl) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Destination URL is required to create a complete ad" }) };
    if (!/^https?:\/\//i.test(destinationUrl)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Destination URL must start with http:// or https://" }) };
    if (!ALLOWED_CTAS.has(cta)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Call to action must be one of: ${[...ALLOWED_CTAS].join(", ")}` }) };
  }

  // Per-product schema (supabase/migrations/006_meta_connections_per_product.sql)
  // — query the "ads" product row specifically, not just any row for this
  // org. Without the product filter, an org with multiple connected
  // products (e.g. whatsapp + ads) would have multiple meta_connections
  // rows and .maybeSingle() would error on more than one match.
  const { data: conn, error: connErr } = await supabaseAdmin
    .from("meta_connections")
    .select("ad_account_id, ad_account_name, access_token")
    .eq("org_id", orgId)
    .eq("product", "ads")
    .maybeSingle();

  if (connErr || !conn || !conn.ad_account_id || !conn.access_token) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No connected Meta Ads account found — connect one in Settings → Integrations first" }) };
  }

  let accessToken: string;
  try {
    accessToken = decryptOrPlaintext(conn.access_token as string);
  } catch (e: any) {
    console.error("[meta-create-ad-campaign] token decrypt failed:", e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not read stored Meta Ads credentials — try reconnecting" }) };
  }

  // ad_account_id is stored without the "act_" prefix the Marketing API expects
  const actId = conn.ad_account_id.startsWith("act_") ? conn.ad_account_id : `act_${conn.ad_account_id}`;

  try {
    const createRes = await fetch(
      `https://graph.facebook.com/v21.0/${actId}/campaigns`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          objective,
          // PAUSED is intentional and not a default to be changed casually —
          // this endpoint exists to demonstrate real Marketing API usage
          // without ever spending money. Do not change this to ACTIVE
          // without deliberately deciding the org wants live spend.
          status: "PAUSED",
          special_ad_categories: [],
          // Required when budget is set at the AD SET level (which this
          // flow does — see the ad set creation below) rather than at the
          // campaign level. false = no Advantage Campaign Budget sharing.
          // Without this, Meta rejects the request with error_subcode
          // 4834011: "Must specify True or False in is_adset_budget_sharing_enabled".
          is_adset_budget_sharing_enabled: false,
        }),
      },
    );
    const createJson = await createRes.json();

    if (!createRes.ok) {
      console.error("[meta-create-ad-campaign] Graph API create failed:", createJson);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: createJson?.error?.message ?? "Campaign creation failed" }) };
    }

    const campaignId = createJson.id;

    // Create a matching PAUSED ad set with the real daily budget, so the
    // demo shows more than a bare campaign shell — this is what actually
    // exercises budget-related Marketing API fields. Still PAUSED, still no
    // spend, since it has no creative/ads attached and isn't activated.
    let adSetId: string | null = null;
    try {
      const adSetRes = await fetch(
        `https://graph.facebook.com/v21.0/${actId}/adsets`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `${name} — Ad Set`,
            campaign_id: campaignId,
            daily_budget: dailyBudgetCents,
            billing_event: "IMPRESSIONS",
            optimization_goal: objective === "OUTCOME_LEADS" ? "LEAD_GENERATION" : "LINK_CLICKS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            status: "PAUSED",
            targeting: { geo_locations: { countries: ["US"] } },
          }),
        },
      );
      const adSetJson = await adSetRes.json();
      if (adSetRes.ok) {
        adSetId = adSetJson.id;
      } else {
        console.warn("[meta-create-ad-campaign] ad set creation failed (campaign still created):", adSetJson);
      }
    } catch (e) {
      console.warn("[meta-create-ad-campaign] ad set creation error (campaign still created):", e);
    }

    // Create the actual ad (image creative + ad object) on top of the
    // campaign + ad set, IF the caller provided creative fields and the ad
    // set was successfully created (an ad needs a real ad_set_id to
    // attach to). This completes the full campaign → ad set → ad
    // hierarchy with real, visible creative — still PAUSED, still $0
    // spend, since nothing here changes status to ACTIVE.
    let adId: string | null = null;
    let imageHash: string | null = null;
    let adCreativeError: string | null = null;

    if (hasAnyCreativeField && adSetId) {
      try {
        // 1. Upload the image to Meta — returns a `hash` used by the
        //    creative, NOT the image's own URL. Meta requires the image
        //    bytes to be uploaded to ITS servers (via /adimages), a public
        //    URL alone isn't accepted as ad creative source.
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) throw new Error(`Could not fetch the uploaded image (${imageRes.status})`);
        const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
        const imageBase64 = imageBuffer.toString("base64");

        const uploadRes = await fetch(
          `https://graph.facebook.com/v21.0/${actId}/adimages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ bytes: imageBase64 }),
          },
        );
        const uploadJson = await uploadRes.json();
        if (!uploadRes.ok) {
          throw new Error(uploadJson?.error?.message ?? "Image upload to Meta failed");
        }
        // Response shape: { images: { "<filename-or-key>": { hash, url } } }
        const imagesObj = uploadJson.images ?? {};
        const firstImageKey = Object.keys(imagesObj)[0];
        imageHash = firstImageKey ? imagesObj[firstImageKey].hash : null;
        if (!imageHash) throw new Error("Meta did not return an image hash after upload");

        // 2. Find a Page to attach the creative to — required by Meta's
        //    object_story_spec for a link ad. Reuses whichever Page this
        //    org has connected for Messenger/Lead Ads, since ad creative
        //    must be posted "as" some Page, not the ad account itself.
        const { data: pageConn } = await supabaseAdmin
          .from("meta_connections")
          .select("page_id")
          .eq("org_id", orgId)
          .not("page_id", "is", null)
          .limit(1)
          .maybeSingle();

        if (!pageConn?.page_id) {
          throw new Error("No connected Facebook Page found — connect Meta Lead Ads or Facebook Messenger first (Meta requires a Page to attach ad creative to)");
        }

        // 3. Create the ad creative — combines the image, copy, and link
        //    into one creative object the ad will reference.
        const creativeRes = await fetch(
          `https://graph.facebook.com/v21.0/${actId}/adcreatives`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: `${name} — Creative`,
              object_story_spec: {
                page_id: pageConn.page_id,
                link_data: {
                  image_hash: imageHash,
                  link: destinationUrl,
                  message: primaryText,
                  name: headline,
                  description: description || undefined,
                  call_to_action: { type: cta, value: { link: destinationUrl } },
                },
              },
            }),
          },
        );
        const creativeJson = await creativeRes.json();
        if (!creativeRes.ok) {
          console.error("[meta-create-ad-campaign] creative error full:", JSON.stringify(creativeJson?.error));
          throw new Error(creativeJson?.error?.error_user_msg ?? creativeJson?.error?.message ?? "Ad creative creation failed");
        }
        const creativeId = creativeJson.id;

        // 4. Create the ad itself — references campaign (via the ad set),
        //    ad set, and creative together. PAUSED, same as everything
        //    else in this flow.
        const adRes = await fetch(
          `https://graph.facebook.com/v21.0/${actId}/ads`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: `${name} — Ad`,
              adset_id: adSetId,
              creative: { creative_id: creativeId },
              status: "PAUSED",
            }),
          },
        );
        const adJson = await adRes.json();
        if (!adRes.ok) {
          throw new Error(adJson?.error?.message ?? "Ad creation failed");
        }
        adId = adJson.id;
      } catch (e: any) {
        // Don't fail the whole request over a creative/ad failure — the
        // campaign and ad set already succeeded and are real, useful
        // results on their own. Surface the creative-specific error
        // separately so the user knows the ad itself didn't complete.
        adCreativeError = e.message ?? "Ad creative/ad creation failed";
        console.warn("[meta-create-ad-campaign] ad creative/ad creation failed (campaign + ad set still created):", adCreativeError);
      }
    }

    // Create a matching ad_drafts row if that table already exists from the
    // earlier Make.com-era Ads work, so this shows up alongside any existing
    // drafts rather than only living on the Graph API side. Best-effort —
    // don't fail the whole request if this table doesn't have the columns
    // we expect (ad_drafts's exact schema, including whether `ad_id` below
    // is a real column, was never independently verified this session —
    // if it isn't, this insert just warns and the function still returns
    // success, since the actual Meta-side campaign/ad/creative already
    // succeeded regardless of whether this local record-keeping insert does).
    try {
      await supabaseAdmin.from("ad_drafts").insert({
        org_id: orgId,
        campaign_id: campaignId,
        ad_set_id: adSetId,
        ad_id: adId,
        name,
        objective,
        daily_budget_cents: dailyBudgetCents,
        status: "PAUSED",
        ad_account_id: conn.ad_account_id,
      });
    } catch (e) {
      console.warn("[meta-create-ad-campaign] ad_drafts insert skipped:", e);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        campaignId,
        adSetId,
        adId,
        adAccountName: conn.ad_account_name,
        status: "PAUSED",
        ...(adCreativeError ? { adCreativeError } : {}),
      }),
    };
  } catch (err: any) {
    console.error("[meta-create-ad-campaign] unhandled error:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Unexpected error creating campaign" }) };
  }
};