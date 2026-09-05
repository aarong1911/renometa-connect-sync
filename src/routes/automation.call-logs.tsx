import { useState, useEffect, useCallback, Fragment } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { queryKeys } from "@/lib/query-keys";
import { useOrgId } from "@/lib/org-id";
import { ROUTES } from "@/lib/routes";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Download,
  ChevronDown,
  ChevronUp,
  Phone,
  Loader2,
  Sparkles,
  Play,
  Pause,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { useCurrentUserRole } from "@/lib/permissions";
import { useTeam } from "@/lib/organization";

export const Route = createFileRoute("/automation/call-logs")({
  head: () => ({
    meta: [
      { title: "Call Logs — RenoMeta" },
      { name: "description", content: "Voice agent call history and transcripts." },
    ],
  }),
  component: CallLogsPage,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallStatus = "completed" | "in_progress" | "no_answer" | "busy" | "failed" | "ringing";
type CallDirection = "inbound" | "outbound";

type CallLog = {
  id: string;
  vapi_call_id: string;
  started_at: string;
  ended_at: string | null;
  caller_number: string | null;
  caller_name: string | null;
  agent_name: string;
  direction: CallDirection;
  duration_sec: number | null;
  status: CallStatus;
  cost_usd: number | null;
  outcome: string | null;
  summary: string | null;
  transcript: any;
  has_recording: boolean;
};

// Some legacy voice_agents rows only ever got a bare numeric auto-name
// (e.g. "31") — never a real display name. Mirror the same display-only
// fallback voice-agent-tab.tsx uses; never written back to the database.
function displayAgentName(name: string | null | undefined): string {
  if (!name) return "Unknown Agent";
  return /^\d+$/.test(name.trim()) ? `Voice Agent ${name.trim()}` : name;
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  in_progress: "In Progress",
  no_answer: "Missed",
  busy: "Busy",
  failed: "Failed",
  ringing: "Ringing",
};

const STATUS_STYLE: Record<string, string> = {
  completed: "bg-success/15 text-success border-success/30",
  in_progress: "bg-primary/15 text-primary border-primary/30",
  no_answer: "bg-warning/15 text-warning border-warning/30",
  busy: "bg-warning/15 text-warning border-warning/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  ringing: "bg-muted text-muted-foreground border-border",
};

const OUTCOME_LABELS: Record<string, string> = {
  appointment_booked: "Appointment Booked",
  lead_captured: "Lead Saved",
  callback_requested: "Callback",
  not_interested: "Not Interested",
  voicemail: "Voicemail",
  wrong_number: "Wrong Number",
  unknown: "—",
};

const OUTCOME_STYLE: Record<string, string> = {
  appointment_booked: "bg-success/15 text-success border-success/30",
  lead_captured: "bg-primary/15 text-primary border-primary/30",
  callback_requested: "bg-warning/15 text-warning border-warning/30",
  not_interested: "bg-muted text-muted-foreground border-border",
  voicemail: "bg-muted text-muted-foreground border-border",
  wrong_number: "bg-destructive/15 text-destructive border-destructive/30",
  unknown: "bg-muted text-muted-foreground border-border",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (sec == null || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatCost(durationSec: number | null): string {
  if (durationSec == null || durationSec <= 0) return "—";
  const minutes = Math.ceil(durationSec / 60);
  return `$${(minutes * 0.35).toFixed(2)}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

// Vapi's raw artifact.messages array includes the system prompt (role:
// "system") and can include tool-call entries alongside real conversation
// turns. The customer-facing transcript (and anything sent to the
// summarizer) must only ever show actual back-and-forth speech — allowlist
// the conversational roles rather than blocklist "system", since a
// blocklist would silently let through any other non-conversational role
// Vapi's artifact format adds in the future. The full raw artifact remains
// untouched in voice_calls.raw_end_of_call for diagnostics.
const CONVERSATION_ROLES = new Set(["assistant", "bot", "user", "human", "caller"]);

function formatTranscript(transcript: any): string {
  if (!transcript) return "No transcript available.";
  if (typeof transcript === "string") return transcript;
  if (Array.isArray(transcript)) {
    const turns = transcript
      .filter((m: any) => m.role && m.message && CONVERSATION_ROLES.has(String(m.role).toLowerCase()))
      .map((m: any) => {
        const role = m.role === "assistant" || m.role === "bot" ? "Agent" : "Caller";
        return `${role}: ${m.message}`;
      });
    return turns.length > 0 ? turns.join("\n\n") : "No transcript available.";
  }
  return JSON.stringify(transcript, null, 2);
}

// AI-H1.1 — display-only backward-compat normalization for summaries
// persisted BEFORE the conversation-summary prompt was fixed to stop
// asking for a "TL;DR Summary" heading. Strips only a leading heading
// matching that legacy pattern (optionally markdown-wrapped: "##", "**",
// or plain) — never touches "Summary" appearing later as real content,
// never touches newer summaries that already start directly with prose,
// and never mutates the stored voice_calls.summary row itself.
function normalizeDisplayedSummary(summary: string | null): string | null {
  if (!summary) return summary;
  const trimmed = summary.replace(/^\s+/, "");
  const legacyHeading = /^(?:#{1,6}\s*)?\*{0,2}\s*TL;?DR\s+Summary\s*\*{0,2}\s*\n+/i;
  return trimmed.replace(legacyHeading, "");
}

// AI-H1.1 — real system state for the "Appointment" section of a generated
// summary. Built entirely from actual DB records (never AI-invented): the
// model is instructed to reproduce these lines verbatim, not embellish
// them. Returns null when there is no linked appointment, so the prompt
// omits the Appointment section entirely rather than fabricating one.
function formatLeadTime(minutesBefore: number): string {
  if (minutesBefore >= 60 && minutesBefore % 60 === 0) {
    const hours = minutesBefore / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutesBefore} minutes`;
}

function buildAppointmentFacts(
  appt: {
    status: string;
    scheduled_at: string | null;
    service: string | null;
    assigned_to: string | null;
    contact_phone: string | null;
    metadata: Record<string, unknown> | null;
  } | null,
  team: { id: string; name: string }[],
  // null = org reminder settings unknown (e.g. migration not applied yet in
  // this environment) — treated the same as disabled, never as "scheduled".
  orgReminderSettings: { enabled: boolean; minutesBefore: number } | null,
): string | null {
  if (!appt) return null;

  const dateStr = appt.scheduled_at
    ? new Date(appt.scheduled_at).toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      })
    : "an unspecified time";

  const meta = appt.metadata ?? {};

  // Real eligibility for the appointment-reminder-sms.ts worker — mirrors
  // its own eligibility check (org setting enabled, status
  // scheduled/confirmed, still in the future, has a phone) so this never
  // claims "scheduled" for an appointment the worker would actually skip.
  const isFuture = appt.scheduled_at ? new Date(appt.scheduled_at).getTime() > Date.now() : false;
  const isEligibleStatus = appt.status === "scheduled" || appt.status === "confirmed";
  const hasPhone = !!appt.contact_phone;
  const remindersEnabled = orgReminderSettings?.enabled ?? false;

  let smsLine: string;
  if (meta.sms_reminder_sent_at) {
    smsLine = "SMS reminder: sent";
  } else if (!remindersEnabled) {
    smsLine = "SMS reminder: disabled for this organization";
  } else if (hasPhone && isFuture && isEligibleStatus) {
    smsLine = `SMS reminder: scheduled for about ${formatLeadTime(orgReminderSettings!.minutesBefore)} before the appointment`;
  } else if (!hasPhone) {
    smsLine = "SMS reminder: not available — no phone number on file";
  } else {
    smsLine = "SMS reminder: not available";
  }

  // confirmation_email_sent_at is the current field; confirmation_email_sent
  // (boolean) is the legacy field written before this lifecycle was shared
  // across all appointment sources — recognize both so an appointment
  // booked before this change doesn't show as "not sent" when it was.
  const emailSent = !!meta.confirmation_email_sent_at || meta.confirmation_email_sent === true;

  const lines = [
    `- ${appt.service || "Appointment"} scheduled for ${dateStr} (status: ${appt.status})`,
    `- Confirmation email: ${emailSent ? "sent" : "not sent"}`,
    `- ${smsLine}`,
  ];

  if (appt.assigned_to) {
    const member = team.find((m) => m.id === appt.assigned_to);
    lines.push(`- Assigned to: ${member?.name ?? "an assigned team member"}`);
  } else {
    lines.push(`- Assignment: unassigned${meta.owner_notified ? " — owner notified" : ""}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function CallLogsPage() {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const role = useCurrentUserRole();
  const team = useTeam();
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  // Admin-only Call Log deletion (AI-H1.1) — UI visibility is convenience
  // only, not the security boundary; voice-call-delete.ts independently
  // re-checks owner/admin authority server-side.
  const canDeleteCallLogs = role === "owner" || role === "admin";

  const loadLogs = useCallback(async () => {
    try {
      const orgId = await getOrgId();
      if (!orgId) return;

      const { data, error } = await supabase
        .from("voice_calls")
        .select(`
          id,
          vapi_call_id,
          started_at,
          ended_at,
          caller_number,
          direction,
          duration_sec,
          status,
          cost_usd,
          outcome,
          summary,
          transcript,
          contact_id,
          recording_url,
          voice_agents ( name )
        `)
        .eq("tenant_id", orgId)
        .order("started_at", { ascending: false })
        .limit(100);

      if (error) {
        console.error("Failed to load call logs:", error);
        return;
      }

      if (!data) {
        setLogs([]);
        return;
      }

      const contactIds = data
        .map((r: any) => r.contact_id)
        .filter(Boolean) as string[];

      let contactMap: Record<string, string> = {};
      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, full_name")
          .in("id", contactIds);

        if (contacts) {
          contactMap = Object.fromEntries(
            contacts.map((c: any) => [c.id, c.full_name])
          );
        }
      }

      const mapped: CallLog[] = data.map((r: any) => ({
        id: r.id,
        vapi_call_id: r.vapi_call_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        caller_number: r.caller_number,
        caller_name: r.contact_id ? contactMap[r.contact_id] ?? null : null,
        agent_name: displayAgentName(r.voice_agents?.name),
        direction: r.direction ?? "inbound",
        duration_sec: r.duration_sec,
        status: r.status ?? "completed",
        cost_usd: r.cost_usd,
        outcome: r.outcome,
        summary: r.summary,
        transcript: r.transcript,
        has_recording: !!r.recording_url,
      }));

      setLogs(mapped);
    } catch (err) {
      console.error("Failed to load call logs:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // -- Update a log's summary in local state --
  const updateLogSummary = (logId: string, summary: string) => {
    setLogs((prev) =>
      prev.map((l) => (l.id === logId ? { ...l, summary } : l))
    );
  };

  // -- Remove a deleted log from local state (server already confirmed
  // deletion) — no full reload needed; unmounting ExpandedCallDetail also
  // tears down any active <audio> recording player for this row. --
  const handleLogDeleted = (logId: string) => {
    setLogs((prev) => prev.filter((l) => l.id !== logId));
    setExpandedId((prev) => (prev === logId ? null : prev));

    // Conversations (inbox.tsx) reads voice_calls through its own
    // TanStack Query cache (queryKeys.conversations.voice) — a plain
    // route navigation there won't necessarily see this deletion until
    // that query's own staleTime/refocus refetch happens. Invalidate it
    // here so the deleted call's Voice thread/message disappears on next
    // render with no hard refresh, without starting any broader
    // Query/realtime migration for this page.
    if (orgId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.voice(orgId) });
    }
  };

  const filtered = logs.filter((log) => {
    if (statusFilter !== "all" && log.status !== statusFilter) return false;
    if (directionFilter !== "all" && log.direction !== directionFilter) return false;
    return true;
  });

  const handleExportCSV = () => {
    const headers = [
      "Date/Time",
      "Caller",
      "Caller Name",
      "Agent",
      "Direction",
      "Duration",
      "Status",
      "Cost",
      "Outcome",
      "Summary",
    ];
    const rows = logs.map((l) => [
      l.started_at,
      l.caller_number ?? "",
      l.caller_name ?? "",
      l.agent_name,
      l.direction,
      formatDuration(l.duration_sec),
      l.status,
      formatCost(l.duration_sec),
      l.outcome ?? "",
      `"${(normalizeDisplayedSummary(l.summary) ?? "").replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to={ROUTES.AI_CENTER} search={{ tab: "voice" }}>
          <Button variant="ghost" size="sm" className="h-8">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="text-xs">Back to Voice Agents</span>
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Phone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Call Logs</h1>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All Status</SelectItem>
            <SelectItem value="completed" className="text-xs">Completed</SelectItem>
            <SelectItem value="no_answer" className="text-xs">Missed</SelectItem>
            <SelectItem value="failed" className="text-xs">Failed</SelectItem>
            <SelectItem value="in_progress" className="text-xs">In Progress</SelectItem>
          </SelectContent>
        </Select>
        <Select value={directionFilter} onValueChange={setDirectionFilter}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All Directions</SelectItem>
            <SelectItem value="inbound" className="text-xs">Inbound</SelectItem>
            <SelectItem value="outbound" className="text-xs">Outbound</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="h-8" onClick={handleExportCSV}>
          <Download className="h-3.5 w-3.5" />
          <span className="text-xs">Export CSV</span>
        </Button>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Date/Time</TableHead>
              <TableHead className="text-xs">Caller</TableHead>
              <TableHead className="text-xs">Agent</TableHead>
              <TableHead className="text-xs">Direction</TableHead>
              <TableHead className="text-xs">Duration</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs">Cost</TableHead>
              <TableHead className="text-xs">Outcome</TableHead>
              <TableHead className="w-8 text-xs"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className="cursor-pointer"
                  onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                >
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDateTime(log.started_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>{log.caller_name || log.caller_number || "Unknown Caller"}</div>
                    {log.caller_name && log.caller_number && (
                      <div className="text-[10px] text-muted-foreground">{log.caller_number}</div>
                    )}
                    {!log.caller_number && (
                      <div className="text-[10px] text-muted-foreground">Web test call</div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{log.agent_name}</TableCell>
                  <TableCell className="text-xs capitalize">{log.direction}</TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {formatDuration(log.duration_sec)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "h-5 rounded border px-1.5 text-[10px]",
                        STATUS_STYLE[log.status] ?? STATUS_STYLE.completed
                      )}
                    >
                      {STATUS_LABELS[log.status] ?? log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {formatCost(log.duration_sec)}
                  </TableCell>
                  <TableCell>
                    {log.outcome && log.outcome !== "unknown" ? (
                      <Badge
                        variant="secondary"
                        className={cn(
                          "h-5 rounded border px-1.5 text-[10px]",
                          OUTCOME_STYLE[log.outcome] ?? OUTCOME_STYLE.unknown
                        )}
                      >
                        {OUTCOME_LABELS[log.outcome] ?? log.outcome}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {expandedId === log.id ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </TableCell>
                </TableRow>
                {expandedId === log.id && (
                  <TableRow>
                    <TableCell colSpan={9} className="bg-secondary/30 p-4">
                      <ExpandedCallDetail
                        log={log}
                        onSummaryUpdate={(s) => updateLogSummary(log.id, s)}
                        canDelete={canDeleteCallLogs}
                        onDeleted={() => handleLogDeleted(log.id)}
                        team={team}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-xs text-muted-foreground">
                  {logs.length === 0
                    ? "No call logs yet. Calls made through your voice agents will appear here."
                    : "No call logs match your filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded call detail with AI Summarize
// ---------------------------------------------------------------------------

function ExpandedCallDetail({
  log,
  onSummaryUpdate,
  canDelete,
  onDeleted,
  team,
}: {
  log: CallLog;
  onSummaryUpdate: (summary: string) => void;
  canDelete: boolean;
  onDeleted: () => void;
  team: { id: string; name: string }[];
}) {
  const [summarizing, setSummarizing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      if (!token) {
        toast.error("Session expired — please sign in again");
        return;
      }

      const res = await fetch("/.netlify/functions/voice-call-delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ callId: log.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || "Failed to delete call log");
        return;
      }

      toast.success("Call log deleted");
      setDeleteDialogOpen(false);
      onDeleted();
    } catch (err) {
      console.error("Failed to delete call log:", err);
      toast.error("Failed to delete call log");
    } finally {
      setDeleting(false);
    }
  };

  const transcriptText = formatTranscript(log.transcript);
  const hasTranscript = transcriptText !== "No transcript available." && transcriptText.length > 20;

  const handleSummarize = async () => {
    // Defense-in-depth against a double-invocation beyond the button's own
    // `disabled` state — this endpoint takes 12-17s, so a second click
    // slipping through would fire a redundant duplicate AI call.
    if (summarizing) return;

    if (!hasTranscript) {
      toast.error("No transcript available to summarize");
      return;
    }

    setSummarizing(true);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      if (!token) {
        toast.error("Session expired — please sign in again");
        return;
      }

      // Real system state only — never let the model invent appointment
      // status/owner/deadline. Looked up fresh (not cached) so it reflects
      // whatever actually exists right now.
      const { data: apptRow } = await supabase
        .from("appointments")
        .select("status, scheduled_at, service, assigned_to, contact_phone, metadata")
        .eq("voice_call_id", log.id)
        .maybeSingle();

      let orgReminderSettings: { enabled: boolean; minutesBefore: number } | null = null;
      const orgId = await getOrgId();
      if (orgId) {
        const { data: orgRow, error: orgErr } = await supabase
          .from("organizations")
          .select("appointment_sms_reminder_enabled, appointment_sms_reminder_minutes_before")
          .eq("id", orgId)
          .maybeSingle();
        // 42703 = column doesn't exist yet in this environment (migration
        // not applied) — treat as "settings unknown", which
        // buildAppointmentFacts already renders as disabled, never as
        // fabricated "scheduled" state.
        if (!orgErr && orgRow) {
          orgReminderSettings = {
            enabled: !!orgRow.appointment_sms_reminder_enabled,
            minutesBefore: orgRow.appointment_sms_reminder_minutes_before ?? 60,
          };
        }
      }

      const appointmentFacts = buildAppointmentFacts(apptRow ?? null, team, orgReminderSettings);

      const res = await fetch("/.netlify/functions/ai-tool-run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          toolId: "conversation-summary",
          inputs: {
            participants: log.caller_name
              ? `${log.caller_name} (caller), ${log.agent_name} (AI agent)`
              : `Caller, ${log.agent_name} (AI agent)`,
            conversationType: "Discovery Call",
            date: log.started_at?.split("T")[0] ?? new Date().toISOString().split("T")[0],
            duration: log.duration_sec ? Math.ceil(log.duration_sec / 60).toString() : "—",
            transcript: transcriptText,
            ...(appointmentFacts ? { appointmentFacts } : {}),
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("AI tool run failed:", errText);
        toast.error("Summary generation failed");
        return; // existing log.summary is untouched — nothing was cleared
      }

      const data = await res.json();

      // ai-tool-run.mjs's actual, only response shape is
      // { sections: Record<string, string> } — there is no top-level
      // `result` or `output` field (that was the previous, incorrect
      // assumption, and the reason a summary never appeared: `data.result
      // ?? data.output` was always undefined, falling through to "").
      // Every buildPrompt() template leads with its most summary-like
      // section first (Summary / Executive Summary / Top 3 Insights /
      // etc.), so — without hardcoding any specific title string, which
      // would be fragile if a prompt's heading wording ever changes — the
      // FIRST section is rendered as plain prose with no heading (matching
      // "Ron Glazer called RenoMeta requesting..." with no leading
      // "Summary" label), and every subsequent section keeps its heading.
      const sections = data?.sections ?? {};
      const sectionTitles = Object.keys(sections);
      const result = sectionTitles
        .map((title, i) => {
          const content = String(sections[title] ?? "").trim();
          return i === 0 ? content : `${title}\n${content}`;
        })
        .join("\n\n")
        .trim();

      console.log("[call-logs] summarize response", {
        callId: log.id,
        responseKeys: Object.keys(data ?? {}),
        sectionTitles,
        resultLength: result.length,
      });

      // A 200 with no usable content is an error, not a success — never
      // persist/display an empty summary, and never clear the existing one.
      if (!result) {
        console.error("[call-logs] summarize returned no usable content", { callId: log.id });
        toast.error("Summary generation returned no content — please try again");
        return;
      }

      const truncated = result.slice(0, 2000);

      const { error: dbError } = await supabase
        .from("voice_calls")
        .update({ summary: truncated })
        .eq("id", log.id);

      if (dbError) {
        console.error("[call-logs] failed to persist summary", { callId: log.id, code: dbError.code });
        toast.error("Generated a summary, but failed to save it — please try again");
        return; // existing log.summary is untouched — nothing was cleared
      }

      // Only now — after both generation AND persistence succeeded — does
      // the displayed call's summary change.
      onSummaryUpdate(truncated);
      toast.success("Conversation summary generated");
    } catch (err) {
      console.error("Summarize failed:", err);
      toast.error("Failed to generate summary");
    } finally {
      setSummarizing(false);
    }
  };

  // log.summary is the single source of truth — it comes from parent state,
  // which onSummaryUpdate only ever updates after a confirmed-successful
  // generation + DB persist, so there is no separate local override to
  // accidentally blank it out while a request is in flight or fails.
  // normalizeDisplayedSummary strips a legacy "TL;DR Summary" heading from
  // summaries persisted before the prompt fix — display-only, the stored
  // row is never rewritten.
  const displaySummary = normalizeDisplayedSummary(log.summary);

  return (
    <div>
      {log.has_recording && (
        <div className="mb-3">
          <h4 className="mb-1 text-xs font-semibold">Recording</h4>
          <CallRecordingPlayer callId={log.id} />
        </div>
      )}

      {/* Summary section */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex-1">
          <h4 className="mb-1 text-xs font-semibold">Summary</h4>
          {displaySummary ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {displaySummary}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">
              No summary yet — click "Summarize" to generate one from the transcript.
            </p>
          )}
        </div>
        {hasTranscript && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-[11px]"
            onClick={handleSummarize}
            disabled={summarizing}
          >
            {summarizing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {summarizing ? "Summarizing…" : displaySummary ? "Re-summarize" : "Summarize"}
          </Button>
        )}
      </div>

      {/* Transcript */}
      <h4 className="mb-2 text-xs font-semibold">Transcript</h4>
      <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">
        {transcriptText}
      </pre>

      {/* Admin/owner-only cleanup action (AI-H1.1) — intentionally small and
          separated from the rest of the detail, not a per-row button. */}
      {canDelete && (
        <div className="mt-4 flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-3 w-3" />
            Delete call log
          </Button>
        </div>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete call log?</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              This permanently removes this call log from RenoMeta. This does
              not delete the original call from the voice provider.
              Historical transcript, summary, recording reference, and
              related call activity stored in RenoMeta may also be removed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete call log
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recording playback (AI-H1.1 Part 20-22)
//
// Vapi's recording storage is access-controlled — the recording_url stored on
// voice_calls is not guaranteed to be directly playable. This fetches a
// short-lived signed URL from vapi-call-recording.ts (server-side, org-scoped,
// VAPI_API_KEY never leaves the backend) on demand, one request per call.
// ---------------------------------------------------------------------------

function CallRecordingPlayer({ callId }: { callId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "playing" | "error">("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handlePlay = async () => {
    if (state === "playing") {
      const el = document.getElementById(`recording-audio-${callId}`) as HTMLAudioElement | null;
      el?.pause();
      setState("ready");
      return;
    }

    if (audioUrl) {
      setState("playing");
      return;
    }

    setState("loading");
    setErrorMsg(null);

    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      if (!token) {
        setState("error");
        setErrorMsg("Session expired — please sign in again");
        return;
      }

      const res = await fetch("/.netlify/functions/vapi-call-recording", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ callId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setState("error");
        setErrorMsg(data?.error || "Recording is not available");
        return;
      }

      const data = await res.json();
      setAudioUrl(data.url);
      setState("playing");
    } catch (err) {
      console.error("Failed to load recording:", err);
      setState("error");
      setErrorMsg("Failed to load recording");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        onClick={handlePlay}
        disabled={state === "loading"}
      >
        {state === "loading" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : state === "playing" ? (
          <Pause className="h-3 w-3" />
        ) : (
          <Play className="h-3 w-3" />
        )}
        {state === "loading" ? "Loading…" : state === "playing" ? "Pause" : "Play recording"}
      </Button>
      {state === "error" && (
        <span className="text-[11px] text-muted-foreground">{errorMsg}</span>
      )}
      {audioUrl && (
        <audio
          id={`recording-audio-${callId}`}
          src={audioUrl}
          autoPlay
          onEnded={() => setState("ready")}
          onPause={() => setState((s) => (s === "playing" ? "ready" : s))}
          className="hidden"
        />
      )}
    </div>
  );
}