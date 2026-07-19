// src/lib/contact-activity.ts
// Fetches real activity timeline for a contact from Supabase.
// Replaces the mock buildActivity() function in contacts.tsx.

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";

export type ActivityKind = "email-out" | "email-in" | "sms-out" | "sms-in" | "call" | "note" | "deal" | "invoice" | "appointment" | "lead";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  body: string;
  at: string; // ISO
  by: string;
};

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return membership?.org_id ?? null;
}

function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  return ` · ${m} min`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useContactActivity(contactId: string | null): {
  items: ActivityItem[];
  loading: boolean;
} {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contactId || !UUID_RE.test(contactId)) {
      setItems([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      const orgId = await getOrgId();
      if (!orgId || cancelled) {
        setLoading(false);
        return;
      }

      const activity: ActivityItem[] = [];

      // ── Voice calls ──
      const { data: calls } = await supabase
        .from("voice_calls")
        .select("id, started_at, duration_sec, summary, direction, voice_agents(name)")
        .eq("contact_id", contactId)
        .eq("tenant_id", orgId)
        .order("started_at", { ascending: false })
        .limit(20);

      if (calls) {
        for (const c of calls as any[]) {
          const dir = c.direction === "outbound" ? "Outbound" : "Inbound";
          activity.push({
            id: `call-${c.id}`,
            kind: "call",
            title: `${dir} call${formatDuration(c.duration_sec)}`,
            body: c.summary || "Voice call completed.",
            at: c.started_at,
            by: c.voice_agents?.name || "Voice AI",
          });
        }
      }

      // ── Deals ──
      const { data: deals } = await supabase
        .from("deals")
        .select("id, title, value, status, created_at, pipeline_stages(name)")
        .eq("contact_id", contactId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(10);

      if (deals) {
        for (const d of deals as any[]) {
          const stage = d.pipeline_stages?.name || d.status || "New";
          const value = d.value ? ` · $${Number(d.value).toLocaleString()}` : "";
          activity.push({
            id: `deal-${d.id}`,
            kind: "deal",
            title: `Deal created`,
            body: `${d.title}${value} — Stage: ${stage}`,
            at: d.created_at,
            by: "System",
          });
        }
      }

      // ── Leads ──
      const { data: leads } = await supabase
        .from("leads")
        .select("id, source, status, notes, estimated_value, custom_fields, created_at")
        .eq("contact_id", contactId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(10);

      if (leads) {
        for (const l of leads as any[]) {
          const service = l.custom_fields?.service || "";
          const value = l.estimated_value ? ` · $${Number(l.estimated_value).toLocaleString()}` : "";
          activity.push({
            id: `lead-${l.id}`,
            kind: "lead",
            title: `Lead captured`,
            body: `Source: ${l.source || "—"}${service ? ` · ${service}` : ""}${value}`,
            at: l.created_at,
            by: "System",
          });
        }
      }

      // ── Appointments ──
      const { data: appointments } = await supabase
        .from("appointments")
        .select("id, service, scheduled_at, status, source, duration_min, created_at")
        .eq("contact_id", contactId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(10);

      if (appointments) {
        for (const a of appointments as any[]) {
          const dateStr = new Date(a.scheduled_at).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          activity.push({
            id: `appt-${a.id}`,
            kind: "appointment",
            title: `Appointment ${a.status === "scheduled" ? "booked" : a.status}`,
            body: `${a.service || "Consultation"} — ${dateStr}`,
            at: a.created_at,
            by: a.source || "—",
          });
        }
      }

      // ── Estimates (client_id is the FK to contacts) ──
      const { data: estimates } = await supabase
        .from("estimates")
        .select("id, title, number, status, total, created_at")
        .eq("client_id", contactId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(10);

      if (estimates) {
        for (const e of estimates as any[]) {
          const amount = e.total ? ` · $${Number(e.total).toLocaleString()}` : "";
          activity.push({
            id: `est-${e.id}`,
            kind: "invoice" as ActivityKind,
            title: `Estimate ${e.status || "created"}`,
            body: `${e.title || e.number || "Estimate"}${amount}`,
            at: e.created_at,
            by: "System",
          });
        }
      }

      // Sort all by date descending
      activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      if (!cancelled) {
        setItems(activity);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [contactId]);

  return { items, loading };
}