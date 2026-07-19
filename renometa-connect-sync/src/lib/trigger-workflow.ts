// src/lib/trigger-workflow.ts
// Client-side helper that fires a workflow trigger via the execution engine.
// Fire-and-forget — errors are logged but never surface to the UI.

import { supabase } from "@/lib/supabase";
import type { TriggerType } from "@/lib/workflow-types";

export async function triggerWorkflow(
  triggerType: TriggerType,
  triggerData: Record<string, any>,
  contactId?: string,
): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Best-effort — don't await the full response so callers aren't blocked
    fetch("/.netlify/functions/execute-workflow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ triggerType, triggerData, contactId }),
    }).catch((err) => console.warn("[trigger-workflow] fetch error:", err));
  } catch (err) {
    console.warn("[trigger-workflow] error:", err);
  }
}
