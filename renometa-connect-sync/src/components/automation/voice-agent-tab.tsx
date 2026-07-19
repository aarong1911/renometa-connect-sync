// src/components/automation/voice-agent-tab.tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { ROUTES } from "@/lib/routes";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Phone,
  Plus,
  Pause,
  Play,
  Save,
  ScrollText,
  PhoneCall,
  PhoneOff,
  Clock,
  TrendingUp,
  Loader2,
  Trash2,
  Mic,
  MicOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/lib/supabase";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VoiceAgentStatus = "active" | "paused";

type CrmTools = {
  saveLeads: boolean;
  checkAvailability: boolean;
  bookAppointment: boolean;
  getServiceInfo: boolean;
};

type VoiceAgent = {
  id: string;
  vapi_assistant_id: string | null;
  name: string;
  tagline: string;
  status: VoiceAgentStatus;
  system_prompt: string;
  first_message: string;
  voice_id: string;
  llm_model: string;
  end_call_phrases: string;
  crm_tools: CrmTools;
  phone_numbers: { number: string; status: string; id: string }[];
  total_calls: number;
  success_rate: number;
  hours_saved: number;
};

type VapiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
};

type VapiAssistantBody = {
  name: string;
  firstMessage: string;
  serverUrl: string;
  serverMessages: string[];
  model: {
    provider: "anthropic";
    model: string;
    systemPrompt: string;
    tools: VapiToolDefinition[];
  };
  voice: {
    provider: "11labs";
    voiceId: string;
  };
  endCallPhrases: string[];
  transcriber?: {
    provider: "deepgram";
    model: string;
  };
};

const DEFAULT_CRM_TOOLS: CrmTools = {
  saveLeads: true,
  checkAvailability: true,
  bookAppointment: true,
  getServiceInfo: true,
};

const DEFAULT_END_CALL_PHRASES = "goodbye, bye, thank you bye";

const STATUS_STYLE: Record<VoiceAgentStatus, string> = {
  active: "bg-success/15 text-success border-success/30",
  paused: "bg-muted text-muted-foreground border-border",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  if (profile?.organization_id) return profile.organization_id;

  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();

  return membership?.org_id ?? null;
}

function getVapiServerUrl(): string {
  return (
    import.meta.env.VITE_VAPI_SERVER_URL ||
    "https://connect.renometa.com/.netlify/functions/vapi-webhook"
  );
}

function buildVapiTools(crmTools: CrmTools): VapiToolDefinition[] {
  const tools: VapiToolDefinition[] = [];

  if (crmTools.saveLeads) {
    tools.push({
      type: "function",
      function: {
        name: "save_lead",
        description:
          "Save the caller's contact information and project details into the CRM when the caller provides lead information.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Caller full name" },
            phone: { type: "string", description: "Caller phone number" },
            email: { type: "string", description: "Caller email address" },
            address: { type: "string", description: "Project address" },
            service: { type: "string", description: "Requested service or project type" },
            budget: { type: "string", description: "Mentioned project budget" },
            timeline: { type: "string", description: "Mentioned project timeline" },
            notes: { type: "string", description: "Important call notes" },
          },
          required: [],
        },
      },
    });
  }

  if (crmTools.checkAvailability) {
    tools.push({
      type: "function",
      function: {
        name: "check_availability",
        description:
          "Check appointment availability for a requested date and optional time before booking.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Requested appointment date, like tomorrow or next Monday",
            },
            time: {
              type: "string",
              description: "Requested appointment time, like 10am",
            },
          },
          required: ["date"],
        },
      },
    });
  }

  if (crmTools.bookAppointment) {
    tools.push({
      type: "function",
      function: {
        name: "book_appointment",
        description:
          "Book a confirmed appointment after the caller agrees to a specific date and time.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Confirmed appointment date" },
            time: { type: "string", description: "Confirmed appointment time" },
            name: { type: "string", description: "Caller full name" },
            phone: { type: "string", description: "Caller phone number" },
            email: { type: "string", description: "Caller email address" },
            address: { type: "string", description: "Project address" },
            service: { type: "string", description: "Requested service or project type" },
            budget: { type: "string", description: "Mentioned project budget" },
            timeline: { type: "string", description: "Mentioned project timeline" },
            notes: { type: "string", description: "Important appointment notes" },
          },
          required: ["date", "time"],
        },
      },
    });
  }

  if (crmTools.getServiceInfo) {
    tools.push({
      type: "function",
      function: {
        name: "get_service_info",
        description:
          "Answer basic questions about company services, project types, pricing process, or service availability.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service the caller is asking about" },
          },
          required: [],
        },
      },
    });
  }

  return tools;
}

function buildVapiAssistantBody(params: {
  name: string;
  greeting: string;
  llm: string;
  systemPrompt: string;
  voice: string;
  endPhrases: string;
  crmTools: CrmTools;
  includeCreateOnlyFields?: boolean;
}): VapiAssistantBody {
  const {
    name,
    greeting,
    llm,
    systemPrompt,
    voice,
    endPhrases,
    crmTools,
    includeCreateOnlyFields = false,
  } = params;

  const body: VapiAssistantBody = {
    name,
    firstMessage: greeting,
    serverUrl: getVapiServerUrl(),
    serverMessages: ["status-update", "tool-calls", "end-of-call-report", "hang"],
    model: {
      provider: "anthropic",
      model: llm,
      systemPrompt,
      tools: buildVapiTools(crmTools),
    },
    voice: {
      provider: "11labs",
      voiceId: voice,
    },
    endCallPhrases: endPhrases
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  };

  if (includeCreateOnlyFields) {
    body.transcriber = {
      provider: "deepgram",
      model: "nova-2",
    };
  }

  return body;
}

// Vapi Web SDK singleton
// Dynamic import keeps the SDK out of the initial bundle until user tests a call.
declare global {
  interface Window {
    __vapiInstance?: any;
  }
}

async function getVapiWeb(): Promise<any | null> {
  const publicKey = import.meta.env.VITE_VAPI_PUBLIC_KEY;

  if (!publicKey) return null;
  if (window.__vapiInstance) return window.__vapiInstance;

  try {
    const { default: Vapi } = await import("@vapi-ai/web");
    window.__vapiInstance = new Vapi(publicKey);
    return window.__vapiInstance;
  } catch (err) {
    console.error("Failed to load Vapi Web SDK", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

export function VoiceAgentTab() {
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const loadAgents = useCallback(async () => {
    try {
      const orgId = await getOrgId();
      if (!orgId) return;

      const { data, error } = await supabase
        .from("voice_agents")
        .select("*")
        .eq("tenant_id", orgId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Failed to load voice agents:", error);
        return;
      }

      if (!data || data.length === 0) {
        setAgents([]);
        return;
      }

      const agentIds = data.map((a: any) => a.id);

      const { data: phoneNumbers } = await supabase
        .from("voice_phone_numbers")
        .select("*")
        .eq("tenant_id", orgId)
        .in("agent_id", agentIds);

      const { data: callStats } = await supabase
        .from("voice_calls")
        .select("agent_id, status")
        .eq("tenant_id", orgId);

      const mapped: VoiceAgent[] = data.map((a: any) => {
        const nums = (phoneNumbers || []).filter((pn: any) => pn.agent_id === a.id);
        const calls = (callStats || []).filter((c: any) => c.agent_id === a.id);
        const totalCalls = calls.length;
        const successCalls = calls.filter((c: any) => c.status === "completed").length;

        return {
          id: a.id,
          vapi_assistant_id: a.vapi_assistant_id,
          name: a.name || "Voice Agent",
          tagline:
            a.first_message?.substring(0, 80) + "..." ||
            "Configure this agent to handle calls.",
          status: a.is_active ? "active" : "paused",
          system_prompt: a.system_prompt || "",
          first_message: a.first_message || "",
          voice_id: a.voice_id || "21m00Tcm4TlvDq8ikWAM",
          llm_model: a.llm_model || "claude-sonnet-4-20250514",
          end_call_phrases: DEFAULT_END_CALL_PHRASES,
          crm_tools: DEFAULT_CRM_TOOLS,
          phone_numbers: nums.map((pn: any) => ({
            id: pn.id,
            number: pn.number || "—",
            status: pn.agent_id ? "assigned" : "available",
          })),
          total_calls: totalCalls,
          success_rate: totalCalls > 0 ? Math.round((successCalls / totalCalls) * 100) : 0,
          hours_saved: Math.round(totalCalls * 0.15 * 10) / 10,
        };
      });

      setAgents(mapped);
    } catch (err) {
      console.error("Failed to load voice agents:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleAddAgent = async () => {
    const orgId = await getOrgId();

    if (!orgId) {
      toast.error("Could not determine organization");
      return;
    }

    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();

    const companyName = org?.name || "our company";

    const defaultSystemPrompt = `You are a friendly, professional phone assistant for ${companyName}, a home renovation and contracting company. You handle both inbound and outbound calls.

## STRICT CONVERSATION ORDER — follow every call in this exact sequence

### Phase 1 — Understand the project FULLY (do this before asking for ANY contact info)
- Ask what kind of work they need
- Ask ONE clarifying question at a time about the project:
  - Property type (house, condo, commercial?)
  - Scope: number of units, size, full replacement or repair?
  - When are they looking to get started?
  - What is their rough budget?
- Let the caller finish answering before moving to the next question

### ⛔ DO NOT ask for contact information until ALL Phase 1 questions are answered.
Never say "before we go further, let me get your info" after just one project question.

### Phase 2 — Collect contact information
Only after understanding the project, ask for:
- Full name
- Phone number (confirm if already known from caller ID)
- Email address
- Property address
→ Call save_lead immediately once you have name + phone

### Phase 3 — Schedule
- Ask what day AND time works best for a free on-site estimate
- Call check_availability with BOTH the date AND the time they mention
  - If that time is free: confirm it with the caller
  - If taken: the system suggests the closest available — offer that to the caller
  - If fully booked that day: offer the next available day

### Phase 4 — Book
- Call book_appointment with ALL collected details: date, time, name, phone, email, address, service, budget, timeline
- You MUST pass every argument — do not call book_appointment with empty arguments
- If you already collected the date and time in Phase 3, reuse them — do not ask again
- Confirm the booking back to the caller with exact date and time, and let them know an estimator will call before arriving

### Phase 5 — Close
Thank them, confirm an estimator will call before arriving, end the call.

## Rules
- Ask ONE question at a time — never combine two questions
- Keep responses to 1-2 short sentences
- Never quote specific prices — say an estimator will provide a detailed quote on-site
- Always call save_lead before ending any call, even without an appointment
- Always call book_appointment when a time is agreed — never just say you will book it
- Set "service" to the EXACT words the caller used — never summarize
  - Include the visit type: "kitchen remodel estimate", "roof inspection", "window replacement consultation"
  - NOT: "kitchen consultation", "roofing", "window estimate"
- Always pass the "time" argument to check_availability when the caller mentions a preferred time`;

    const defaultGreeting = `Hi there! Thanks for calling ${companyName}. How can I help you today?`;

    const { data, error } = await supabase
      .from("voice_agents")
      .insert({
        tenant_id: orgId,
        name: "Inbound Receptionist",
        system_prompt: defaultSystemPrompt,
        first_message: defaultGreeting,
        voice_id: "21m00Tcm4TlvDq8ikWAM",
        voice_provider: "11labs",
        llm_model: "claude-sonnet-4-20250514",
        is_active: false,
      } as any)
      .select()
      .single();

    if (error) {
      toast.error("Failed to create agent: " + error.message);
      return;
    }

    toast.success("New voice agent created");
    await loadAgents();
    setSelectedId(data.id);
  };

  const toggleStatus = async (id: string) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return;

    const newActive = agent.status !== "active";

    if (newActive) {
      const orgId = await getOrgId();
      if (orgId) {
        await supabase
          .from("voice_agents")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("tenant_id", orgId)
          .neq("id", id);
      }
    }

    const { error } = await supabase
      .from("voice_agents")
      .update({ is_active: newActive, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      toast.error("Failed to update status");
      return;
    }

    toast.success(
      newActive ? `${agent.name} activated — other agents paused` : `${agent.name} paused`,
    );

    await loadAgents();
  };

  const handleDelete = async (id: string) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return;

    if (agent.vapi_assistant_id) {
      try {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;

        if (token) {
          await fetch("/.netlify/functions/vapi-proxy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              path: `/assistant/${agent.vapi_assistant_id}`,
              method: "DELETE",
            }),
          });
        }
      } catch (err) {
        console.warn("Vapi assistant delete failed (continuing)", err);
      }
    }

    const { error } = await supabase.from("voice_agents").delete().eq("id", id);

    if (error) {
      toast.error("Failed to delete agent: " + error.message);
      return;
    }

    toast.success(`${agent.name} deleted`);
    setSelectedId(null);
    await loadAgents();
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
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Voice agents handle inbound and outbound calls with AI-powered conversations.
        </p>
        <div className="flex items-center gap-2">
          <Link to={ROUTES.CALL_LOGS}>
            <Button size="sm" variant="outline" className="h-8">
              <ScrollText className="h-3.5 w-3.5" />
              <span className="text-xs">Call Logs</span>
            </Button>
          </Link>
          <Button size="sm" className="h-8" onClick={handleAddAgent}>
            <Plus className="h-3.5 w-3.5" />
            <span className="text-xs">New Agent</span>
          </Button>
        </div>
      </div>

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-8 text-center">
          <Phone className="h-8 w-8 text-muted-foreground/50" />
          <div>
            <p className="text-sm font-medium">No voice agents yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create your first agent to start handling calls with AI.
            </p>
          </div>
          <Button size="sm" onClick={handleAddAgent}>
            <Plus className="h-3.5 w-3.5" />
            <span className="text-xs">Create Agent</span>
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <VoiceAgentCard
              key={agent.id}
              agent={agent}
              onOpen={() => setSelectedId(agent.id)}
              onToggle={() => toggleStatus(agent.id)}
              onDelete={() => handleDelete(agent.id)}
            />
          ))}
        </div>
      )}

      <VoiceAgentDrawer
        agent={selected}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onToggle={() => selected && toggleStatus(selected.id)}
        onSaved={loadAgents}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function VoiceAgentCard({
  agent,
  onOpen,
  onToggle,
  onDelete,
}: {
  agent: VoiceAgent;
  onOpen: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isLive = agent.status === "active";
  const phoneDisplay = agent.phone_numbers.length > 0 ? agent.phone_numbers[0].number : "—";

  return (
    <Card
      className={cn(
        "group cursor-pointer p-3.5 transition-all hover:shadow-md",
        isLive && "ring-1 ring-inset ring-success/20",
      )}
      onClick={onOpen}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
          <Phone className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold">{agent.name}</h3>
            {isLive && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {agent.tagline}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
        <Badge
          variant="secondary"
          className={cn(
            "h-5 rounded border px-1.5 text-[10px] capitalize",
            STATUS_STYLE[agent.status],
          )}
        >
          {agent.status}
        </Badge>
        <span className="text-[10px] text-muted-foreground">📞 {phoneDisplay}</span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <SmallStat label="Total calls" value={agent.total_calls.toString()} />
        <SmallStat label="Success" value={agent.success_rate > 0 ? `${agent.success_rate}%` : "—"} />
        <SmallStat label="Saved" value={agent.hours_saved > 0 ? `${agent.hours_saved}h` : "—"} />
      </div>

      <div
        className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          size="sm"
          variant={isLive ? "outline" : "default"}
          className="h-7 flex-1 text-[11px]"
          onClick={onToggle}
        >
          {isLive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {isLive ? "Pause" : "Activate"}
        </Button>

        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-[11px]"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </Card>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer wrapper
// ---------------------------------------------------------------------------

function VoiceAgentDrawer({
  agent,
  onOpenChange,
  onToggle,
  onSaved,
}: {
  agent: VoiceAgent | null;
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
  onSaved: () => void;
}) {
  return (
    <Sheet open={!!agent} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {agent && <VoiceAgentDetail agent={agent} onToggle={onToggle} onSaved={onSaved} />}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

function VoiceAgentDetail({
  agent,
  onToggle,
  onSaved,
}: {
  agent: VoiceAgent;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const isLive = agent.status === "active";
  const [saving, setSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  const [name, setName] = useState(agent.name);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [greeting, setGreeting] = useState(agent.first_message);
  const [voice, setVoice] = useState(agent.voice_id);
  const [llm, setLlm] = useState(agent.llm_model);
  const [endPhrases, setEndPhrases] = useState(agent.end_call_phrases);
  const [crmTools, setCrmTools] = useState<CrmTools>(agent.crm_tools);

  useEffect(() => {
    setName(agent.name);
    setSystemPrompt(agent.system_prompt);
    setGreeting(agent.first_message);
    setVoice(agent.voice_id);
    setLlm(agent.llm_model);
    setEndPhrases(agent.end_call_phrases);
    setCrmTools(agent.crm_tools);
  }, [agent]);

  const handleSave = async () => {
    setSaving(true);

    try {
      const { error } = await supabase
        .from("voice_agents")
        .update({
          name,
          system_prompt: systemPrompt,
          first_message: greeting,
          voice_id: voice,
          llm_model: llm,
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);

      if (error) {
        toast.error("Failed to save: " + error.message);
        return;
      }

      try {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;

        if (!token) {
          toast.warning("Saved locally, but could not sync Vapi because the session token is missing.");
          return;
        }

        const assistantBody = buildVapiAssistantBody({
          name,
          greeting,
          llm,
          systemPrompt,
          voice,
          endPhrases,
          crmTools,
          includeCreateOnlyFields: !agent.vapi_assistant_id,
        });

        console.log("Vapi assistant serverUrl:", assistantBody.serverUrl);

        if (agent.vapi_assistant_id) {
          const updateRes = await fetch("/.netlify/functions/vapi-proxy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              path: `/assistant/${agent.vapi_assistant_id}`,
              method: "PATCH",
              body: assistantBody,
            }),
          });

          if (!updateRes.ok) {
            const text = await updateRes.text();
            console.error("Vapi assistant update failed:", text);
            toast.warning("Agent saved locally, but Vapi sync failed. Check console.");
          }
        } else {
          const createRes = await fetch("/.netlify/functions/vapi-proxy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              path: "/assistant",
              method: "POST",
              body: assistantBody,
            }),
          });

          if (!createRes.ok) {
            const text = await createRes.text();
            console.error("Vapi assistant create failed:", text);
            toast.warning("Agent saved locally, but Vapi assistant creation failed. Check console.");
          } else {
            const vapiData = await createRes.json();
            const newAssistantId = vapiData?.id || vapiData?.assistantId;

            if (newAssistantId) {
              await supabase
                .from("voice_agents")
                .update({
                  vapi_assistant_id: newAssistantId,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", agent.id);
            }

            toast.success("Vapi assistant created and linked");
          }
        }
      } catch (vapiErr) {
        console.warn("Vapi sync failed, local save succeeded", vapiErr);
        toast.warning("Agent saved locally, but Vapi sync failed. Check console.");
      }

      toast.success("Agent saved");
      onSaved();
    } catch (err: any) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-2 px-0 text-left">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
            <Phone className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base">{agent.name}</SheetTitle>
            <Badge
              variant="secondary"
              className={cn(
                "mt-1 h-5 rounded border px-1.5 text-[10px] capitalize",
                STATUS_STYLE[agent.status],
              )}
            >
              {agent.status}
            </Badge>
          </div>
        </div>
        <SheetDescription className="text-xs leading-relaxed">{agent.tagline}</SheetDescription>
      </SheetHeader>

      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Total calls" value={agent.total_calls.toString()} icon={PhoneCall} />
        <StatCard label="Success" value={agent.success_rate > 0 ? `${agent.success_rate}%` : "—"} icon={TrendingUp} />
        <StatCard label="Saved" value={agent.hours_saved > 0 ? `${agent.hours_saved}h` : "—"} icon={Clock} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={isLive ? "outline" : "default"} className="h-8 flex-1" onClick={onToggle}>
          {isLive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="text-xs">{isLive ? "Pause" : "Activate"}</span>
        </Button>

        <Button size="sm" variant="outline" className="h-8" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span className="text-xs">{saving ? "Saving…" : "Save"}</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => {
            if (!agent.vapi_assistant_id) {
              toast.info("Save the agent first, then you can test it");
              return;
            }
            setTestOpen(true);
          }}
        >
          <Mic className="h-3.5 w-3.5" />
          <span className="text-xs">Test Agent</span>
        </Button>

        <Link to={ROUTES.CALL_LOGS}>
          <Button size="sm" variant="outline" className="h-8">
            <ScrollText className="h-3.5 w-3.5" />
            <span className="text-xs">View Call Logs</span>
          </Button>
        </Link>
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Configure
        </h3>

        <div className="space-y-1">
          <Label className="text-xs">Agent Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">System Prompt</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-[100px] text-xs"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Greeting Message</Label>
          <Textarea
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            className="min-h-[60px] text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Voice</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { label: "Rachel", value: "21m00Tcm4TlvDq8ikWAM" },
                  { label: "Sarah", value: "EXAVITQu4vr4xnSDxMaL" },
                  { label: "Emily", value: "LcfcDJNUP1GQjkzn1xUU" },
                  { label: "Josh", value: "TxGEqnHWrfWFTfGW9XjX" },
                  { label: "Adam", value: "pNInz6obpgDQGcFmaJgB" },
                  { label: "Antoni", value: "ErXwobaYiN019PkySvjV" },
                ].map((v) => (
                  <SelectItem key={v.value} value={v.value} className="text-xs">
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">LLM Model</Label>
            <Select value={llm} onValueChange={setLlm}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { label: "Claude Sonnet 4", value: "claude-sonnet-4-20250514" },
                  { label: "Claude Haiku", value: "claude-haiku-4-5-20251001" },
                  { label: "GPT-4o", value: "gpt-4o" },
                ].map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">End-Call Phrases</Label>
          <Input
            value={endPhrases}
            onChange={(e) => setEndPhrases(e.target.value)}
            className="h-8 text-xs"
            placeholder="goodbye, bye, thank you bye"
          />
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          CRM Tools
        </h3>

        {[
          {
            key: "saveLeads" as const,
            label: "Save Lead",
            desc: "Saves caller contact info to CRM",
          },
          {
            key: "checkAvailability" as const,
            label: "Check Availability",
            desc: "Checks calendar for open slots",
          },
          {
            key: "bookAppointment" as const,
            label: "Book Appointment",
            desc: "Books confirmed appointments",
          },
          {
            key: "getServiceInfo" as const,
            label: "Get Service Info",
            desc: "Retrieves pricing and service details",
          },
        ].map((tool) => (
          <div
            key={tool.key}
            className="flex items-center justify-between rounded-md border border-border bg-secondary/30 p-2.5"
          >
            <div>
              <div className="text-xs font-medium">{tool.label}</div>
              <div className="text-[10px] text-muted-foreground">{tool.desc}</div>
            </div>
            <Switch
              checked={crmTools[tool.key]}
              onCheckedChange={(checked) =>
                setCrmTools((prev) => ({ ...prev, [tool.key]: checked }))
              }
            />
          </div>
        ))}
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Phone Numbers
        </h3>

        {agent.phone_numbers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No phone numbers assigned yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Number</TableHead>
                <TableHead className="text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agent.phone_numbers.map((pn) => (
                <TableRow key={pn.id}>
                  <TableCell className="text-xs">{pn.number}</TableCell>
                  <TableCell className="text-xs capitalize">{pn.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() =>
            toast.info("Phone number assignment requires a Vapi account with Twilio numbers configured.")
          }
        >
          <Plus className="h-3 w-3" />
          Assign Number
        </Button>
      </div>

      <div className="sticky bottom-0 border-t border-border bg-background pt-3 pb-1">
        <Button className="w-full" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          <span>{saving ? "Saving…" : "Save Changes"}</span>
        </Button>
      </div>

      <TestAgentModal open={testOpen} onOpenChange={setTestOpen} agent={agent} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test Agent Modal
// ---------------------------------------------------------------------------

type CallStatus = "idle" | "connecting" | "active" | "ended";

function TestAgentModal({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: VoiceAgent;
}) {
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vapiRef = useRef<any>(null);

  useEffect(() => {
    if (!open) {
      endCall();
      setCallStatus("idle");
      setDuration(0);
      setIsMuted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startTimer = () => {
    setDuration(0);
    timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startCall = async () => {
    const vapi = await getVapiWeb();

    if (!vapi) {
      toast.error("Vapi Web SDK not available. Add VITE_VAPI_PUBLIC_KEY to your .env file.");
      return;
    }

    vapiRef.current = vapi;
    setCallStatus("connecting");

    vapi.on("call-start", () => {
      setCallStatus("active");
      startTimer();
    });

    vapi.on("call-end", () => {
      setCallStatus("ended");
      stopTimer();
    });

    vapi.on("error", (err: any) => {
      console.error("Vapi call error:", err);
      toast.error("Call error — check console for details");
      setCallStatus("ended");
      stopTimer();
    });

    try {
      await vapi.start(agent.vapi_assistant_id!);
    } catch (err) {
      console.error("Failed to start Vapi call:", err);
      toast.error("Failed to start test call");
      setCallStatus("idle");
    }
  };

  const endCall = () => {
    stopTimer();

    if (vapiRef.current) {
      try {
        vapiRef.current.stop();
      } catch {
        // already stopped
      }
    }
  };

  const toggleMute = () => {
    if (vapiRef.current) {
      vapiRef.current.setMuted(!isMuted);
      setIsMuted(!isMuted);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Test Agent</DialogTitle>
          <DialogDescription className="text-xs">
            Browser call to <span className="font-medium">{agent.name}</span>. Uses your microphone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                "flex h-16 w-16 items-center justify-center rounded-full border-2",
                callStatus === "idle" && "border-muted-foreground/30 text-muted-foreground",
                callStatus === "connecting" && "border-warning/50 text-warning animate-pulse",
                callStatus === "active" && "border-success/50 text-success",
                callStatus === "ended" && "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              {callStatus === "active" ? (
                <PhoneCall className="h-7 w-7" />
              ) : callStatus === "connecting" ? (
                <Loader2 className="h-7 w-7 animate-spin" />
              ) : (
                <Phone className="h-7 w-7" />
              )}
            </div>

            <span className="text-xs font-medium capitalize">
              {callStatus === "idle" ? "Ready" : callStatus}
            </span>

            {(callStatus === "active" || callStatus === "ended") && (
              <span className="font-mono text-lg tabular-nums">{formatTime(duration)}</span>
            )}
          </div>

          <div className="flex gap-3">
            {callStatus === "idle" || callStatus === "ended" ? (
              <Button onClick={startCall} className="gap-2">
                <PhoneCall className="h-4 w-4" />
                {callStatus === "ended" ? "Call Again" : "Start Call"}
              </Button>
            ) : (
              <>
                <Button variant="outline" size="icon" onClick={toggleMute} disabled={callStatus !== "active"}>
                  {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    endCall();
                    setCallStatus("ended");
                  }}
                  className="gap-2"
                >
                  <PhoneOff className="h-4 w-4" />
                  End Call
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon className="h-3 w-3 text-muted-foreground" />
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </Card>
  );
}
