/// <reference types="node" />
// netlify/functions/estimate-expire.ts
//
// Phase 10.4 — scheduled job that moves sent/viewed estimates past their
// valid_until date to "expired". Runs hourly in production via the
// @netlify/functions `schedule()` wrapper (no netlify.toml change needed —
// the schedule is declared here). Idempotent: the query only ever matches
// rows still in sent/viewed, so an estimate is never expired twice, and
// approved/rejected/converted/cancelled/archived rows are untouched
// regardless of their valid_until date.
//
// Local/manual testing: this is still a normal HTTP-triggered function —
// `netlify dev` lets you hit it directly at
// /.netlify/functions/estimate-expire to run it on demand.
import { schedule } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function expireDueEstimates() {
  const today = new Date().toISOString().slice(0, 10);

  const { data: due, error } = await supabaseAdmin
    .from("estimates")
    .select("id, org_id, version_number, title, client_name")
    .in("status", ["sent", "viewed"])
    .lt("valid_until", today);

  if (error) {
    console.error("[estimate-expire] query failed:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  if (!due || due.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ expired: 0 }) };
  }

  const now = new Date().toISOString();
  let expiredCount = 0;

  for (const e of due) {
    // Re-check-and-set in one call scoped to the still-sent/viewed status —
    // if two overlapping runs ever raced, only the first would match a row.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("estimates")
      .update({ status: "expired", expired_at: now, updated_at: now })
      .eq("id", e.id)
      .in("status", ["sent", "viewed"])
      .select("id")
      .maybeSingle();
    if (updErr || !updated) continue;

    await supabaseAdmin.from("estimate_activities").insert({
      org_id: e.org_id, estimate_id: e.id, version_number: e.version_number,
      activity_type: "expired", actor_type: "system",
      title: "Proposal expired", description: `${e.title} passed its valid-until date without a response`,
    });

    fetch(`${process.env.URL ?? "http://localhost:8888"}/.netlify/functions/execute-workflow`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: e.org_id, triggerType: "estimate_expired", triggerData: { estimateId: e.id, title: e.title, clientName: e.client_name } }),
    }).catch(() => {});

    expiredCount++;
  }

  console.log(`[estimate-expire] expired ${expiredCount} of ${due.length} due estimates`);
  return { statusCode: 200, body: JSON.stringify({ expired: expiredCount, checked: due.length }) };
}

export const handler = schedule("0 * * * *", async () => {
  await expireDueEstimates();
  return { statusCode: 200, body: "" };
});
