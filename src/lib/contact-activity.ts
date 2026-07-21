// src/lib/contact-activity.ts
// Builds a Contact timeline from real Supabase records, including detailed
// Deal activity entries created from the Deal drawer.

import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

export type ActivityKind =
  | "email-out"
  | "email-in"
  | "sms-out"
  | "sms-in"
  | "call"
  | "note"
  | "deal"
  | "invoice"
  | "appointment"
  | "lead";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  body: string;
  at: string;
  by: string;
};

type DealRow = {
  id: string;
  title: string;
  value: number | null;
  status: string | null;
  created_at: string;
  pipeline_stages:
    | { name: string | null }
    | Array<{ name: string | null }>
    | null;
};

type DealActivityRow = {
  id: string;
  deal_id: string;
  activity_type: string;
  title: string;
  description: string | null;
  actor_name: string | null;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getOrgId(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.organization_id) {
    return profile.organization_id;
  }

  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();

  return membership?.org_id ?? null;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";

  const minutes = Math.floor(seconds / 60);
  return ` · ${minutes} min`;
}

function relatedStageName(row: DealRow): string {
  if (Array.isArray(row.pipeline_stages)) {
    return row.pipeline_stages[0]?.name || row.status || "New";
  }

  return row.pipeline_stages?.name || row.status || "New";
}

function dealActivityKind(type: string): ActivityKind {
  if (type === "note_added") return "note";
  return "deal";
}

function dealActivityBody(activity: DealActivityRow): string {
  if (activity.description?.trim()) {
    return activity.description.trim();
  }

  const metadata = activity.metadata ?? {};
  const field = metadata.field_label;
  const previous = metadata.previous_value;
  const next = metadata.new_value;

  if (
    typeof field === "string" &&
    previous !== undefined &&
    next !== undefined
  ) {
    return `${field}: ${String(previous)} → ${String(next)}`;
  }

  return "Deal activity recorded.";
}

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
    let activeDealIds: string[] = [];
    let orgId: string | null = null;

    async function loadActivity() {
      orgId = await getOrgId();

      if (!orgId || cancelled) {
        setLoading(false);
        return;
      }

      const activity: ActivityItem[] = [];

      const [
        { data: calls },
        { data: dealRows },
        { data: leads },
        { data: appointments },
        { data: estimates },
      ] = await Promise.all([
        supabase
          .from("voice_calls")
          .select(
            "id, started_at, duration_sec, summary, direction, " +
              "voice_agents(name)",
          )
          .eq("contact_id", contactId)
          .eq("tenant_id", orgId)
          .order("started_at", { ascending: false })
          .limit(20),

        supabase
          .from("deals")
          .select(
            "id, title, value, status, created_at, pipeline_stages(name)",
          )
          .eq("contact_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(25),

        supabase
          .from("leads")
          .select(
            "id, source, status, notes, estimated_value, " +
              "custom_fields, created_at",
          )
          .eq("contact_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(10),

        supabase
          .from("appointments")
          .select(
            "id, service, scheduled_at, status, source, " +
              "duration_min, created_at",
          )
          .eq("contact_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(10),

        supabase
          .from("estimates")
          .select("id, title, number, status, total, created_at")
          .eq("client_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      if (calls) {
        for (const call of calls as Array<Record<string, any>>) {
          const direction =
            call.direction === "outbound" ? "Outbound" : "Inbound";

          activity.push({
            id: `call-${call.id}`,
            kind: "call",
            title: `${direction} call${formatDuration(
              call.duration_sec,
            )}`,
            body: call.summary || "Voice call completed.",
            at: call.started_at,
            by: call.voice_agents?.name || "Voice AI",
          });
        }
      }

      const deals = (dealRows as DealRow[] | null) ?? [];
      activeDealIds = deals.map((deal) => deal.id);

      for (const deal of deals) {
        const amount = deal.value
          ? ` · $${Number(deal.value).toLocaleString()}`
          : "";

        activity.push({
          id: `deal-${deal.id}`,
          kind: "deal",
          title: "Deal created",
          body: `${deal.title}${amount} — Stage: ${relatedStageName(deal)}`,
          at: deal.created_at,
          by: "System",
        });
      }

      if (activeDealIds.length > 0) {
        const { data: detailedDealActivity } = await supabase
          .from("deal_activities")
          .select(
            "id, deal_id, activity_type, title, description, " +
              "actor_name, occurred_at, metadata",
          )
          .eq("org_id", orgId)
          .in("deal_id", activeDealIds)
          .order("occurred_at", { ascending: false })
          .limit(100);

        for (
          const dealActivity of
            (detailedDealActivity as DealActivityRow[] | null) ?? []
        ) {
          activity.push({
            id: `deal-activity-${dealActivity.id}`,
            kind: dealActivityKind(dealActivity.activity_type),
            title: dealActivity.title,
            body: dealActivityBody(dealActivity),
            at: dealActivity.occurred_at,
            by: dealActivity.actor_name || "System",
          });
        }
      }

      if (leads) {
        for (const lead of leads as Array<Record<string, any>>) {
          const service = lead.custom_fields?.service || "";
          const amount = lead.estimated_value
            ? ` · $${Number(lead.estimated_value).toLocaleString()}`
            : "";

          activity.push({
            id: `lead-${lead.id}`,
            kind: "lead",
            title: "Lead captured",
            body:
              `Source: ${lead.source || "—"}` +
              `${service ? ` · ${service}` : ""}${amount}`,
            at: lead.created_at,
            by: "System",
          });
        }
      }

      if (appointments) {
        for (
          const appointment of
            appointments as Array<Record<string, any>>
        ) {
          const date = new Date(
            appointment.scheduled_at,
          ).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });

          activity.push({
            id: `appointment-${appointment.id}`,
            kind: "appointment",
            title:
              appointment.status === "scheduled"
                ? "Appointment booked"
                : `Appointment ${appointment.status}`,
            body: `${appointment.service || "Consultation"} — ${date}`,
            at: appointment.created_at,
            by: appointment.source || "System",
          });
        }
      }

      if (estimates) {
        for (const estimate of estimates as Array<Record<string, any>>) {
          const amount = estimate.total
            ? ` · $${Number(estimate.total).toLocaleString()}`
            : "";

          activity.push({
            id: `estimate-${estimate.id}`,
            kind: "invoice",
            title: `Estimate ${estimate.status || "created"}`,
            body:
              `${estimate.title || estimate.number || "Estimate"}` +
              amount,
            at: estimate.created_at,
            by: "System",
          });
        }
      }

      activity.sort((a, b) => {
        return new Date(b.at).getTime() - new Date(a.at).getTime();
      });

      if (!cancelled) {
        setItems(activity);
        setLoading(false);
      }
    }

    setLoading(true);
    void loadActivity();

    const channel = supabase
      .channel(`contact-activity-${contactId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deal_activities",
        },
        (payload) => {
          const row = (payload.new || payload.old) as {
            deal_id?: string;
            org_id?: string;
          };

          if (
            row.org_id === orgId &&
            row.deal_id &&
            activeDealIds.includes(row.deal_id)
          ) {
            void loadActivity();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deals",
          filter: `contact_id=eq.${contactId}`,
        },
        () => {
          void loadActivity();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [contactId]);

  return { items, loading };
}