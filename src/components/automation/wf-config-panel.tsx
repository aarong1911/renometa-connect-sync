// src/components/automation/wf-config-panel.tsx
// Right sidebar config panel — renders per-node-type config fields.

import { useCallback } from "react";
import { X, RefreshCw, Trash2, Plus } from "lucide-react";
import { useTeam, ROLE_LABELS } from "@/lib/organization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CATEGORY_STYLE,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  NODE_META_MAP,
  VARIABLE_TOKENS,
  type WfNodeData,
  type WfNodeType,
} from "@/lib/workflow-types";
import type { WfRfNode } from "@/lib/workflow-types";

interface Props {
  node: WfRfNode;
  onUpdate: (patch: Partial<WfNodeData>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function WfConfigPanel({ node, onUpdate, onDelete, onClose }: Props) {
  const meta = NODE_META_MAP[node.data.nodeType];
  const style = CATEGORY_STYLE[node.data.category];
  const Icon = meta?.icon;

  const setConfig = useCallback(
    (patch: Record<string, any>) => {
      onUpdate({ config: { ...node.data.config, ...patch } });
    },
    [node.data.config, onUpdate],
  );

  const cfg = node.data.config;

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-l border-border bg-card">
      {/* Header */}
      <div className={cn("flex items-center gap-2.5 border-b border-border px-4 py-3", style.bg)}>
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", style.bg, style.border)}>
          {Icon && <Icon className={cn("h-4 w-4", style.text)} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn("text-[11px] font-semibold uppercase tracking-wider", style.text)}>
            {style.label.slice(0, -1)}
          </div>
          <Input
            value={node.data.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            className="mt-0.5 h-6 border-0 bg-transparent p-0 text-sm font-semibold shadow-none focus-visible:ring-0"
          />
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Config fields */}
      <div className="flex-1 overflow-y-auto p-4">
        <ConfigFields nodeType={node.data.nodeType} cfg={cfg} setConfig={setConfig} />
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-border p-3">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={() => onUpdate({ subtitle: buildSubtitle(node.data.nodeType, cfg) })}
        >
          <RefreshCw className="mr-1 h-3 w-3" /> Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Per-node-type fields ─────────────────────────────────────────────────────

function ConfigFields({
  nodeType,
  cfg,
  setConfig,
}: {
  nodeType: WfNodeType;
  cfg: Record<string, any>;
  setConfig: (patch: Record<string, any>) => void;
}) {
  const team = useTeam();
  const activeMembers = team.filter((m) => m.status === "active");

  // ── Triggers ──

  if (nodeType === "new_lead" || nodeType === "contact_created") {
    return (
      <Field label="Source filter">
        <Select value={cfg.source ?? "any"} onChange={(v) => setConfig({ source: v })}
          options={[
            { value: "any", label: "Any source" },
            { value: "Website", label: "Website" },
            { value: "Angi", label: "Angi" },
            { value: "Thumbtack", label: "Thumbtack" },
            { value: "Referral", label: "Referral" },
            { value: "Google Ads", label: "Google Ads" },
          ]}
        />
      </Field>
    );
  }

  if (nodeType === "lead_status_changed") {
    return (
      <>
        <Field label="From status">
          <Select value={cfg.from_status ?? "any"} onChange={(v) => setConfig({ from_status: v })}
            options={[{ value: "any", label: "Any" }, { value: "new", label: "New" }, { value: "contacted", label: "Contacted" }, { value: "qualified", label: "Qualified" }, { value: "converted", label: "Converted" }, { value: "lost", label: "Lost" }]}
          />
        </Field>
        <Field label="To status">
          <Select value={cfg.to_status ?? "any"} onChange={(v) => setConfig({ to_status: v })}
            options={[{ value: "any", label: "Any" }, { value: "new", label: "New" }, { value: "contacted", label: "Contacted" }, { value: "qualified", label: "Qualified" }, { value: "converted", label: "Converted" }, { value: "lost", label: "Lost" }]}
          />
        </Field>
      </>
    );
  }

  if (nodeType === "project_status_changed") {
    const stages = [
      { value: "any", label: "Any" }, { value: "estimating", label: "Estimating" }, { value: "contracted", label: "Contracted" },
      { value: "pre-construction", label: "Pre-Construction" }, { value: "in-progress", label: "In Progress" },
      { value: "punch-list", label: "Punch List" }, { value: "completed", label: "Completed" },
    ];
    return (
      <>
        <Field label="From stage"><Select value={cfg.from_stage ?? "any"} onChange={(v) => setConfig({ from_stage: v })} options={stages} /></Field>
        <Field label="To stage"><Select value={cfg.to_stage ?? "any"} onChange={(v) => setConfig({ to_stage: v })} options={stages} /></Field>
      </>
    );
  }

  if (nodeType === "invoice_overdue") {
    return (
      <Field label="Days past due">
        <Select value={String(cfg.days_overdue ?? 7)} onChange={(v) => setConfig({ days_overdue: Number(v) })}
          options={[{ value: "3", label: "3 days" }, { value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "21", label: "21 days" }, { value: "30", label: "30 days" }]}
        />
      </Field>
    );
  }

  if (nodeType === "form_submitted") {
    return (
      <Field label="Form name (leave blank for any)">
        <Input value={cfg.form_name ?? ""} onChange={(e) => setConfig({ form_name: e.target.value })} placeholder="e.g. Contact Us" className="h-8 text-sm" />
      </Field>
    );
  }

  if (nodeType === "manual" || nodeType === "estimate_approved" || nodeType === "invoice_created" || nodeType === "appointment_scheduled" || nodeType === "missed_call") {
    return <Hint>No configuration required for this trigger.</Hint>;
  }

  // ── Actions ──

  if (nodeType === "send_sms") {
    return (
      <>
        <Field label="Send to">
          <Select value={cfg.to ?? "contact_phone"} onChange={(v) => setConfig({ to: v })}
            options={[{ value: "contact_phone", label: "Contact phone" }, { value: "custom", label: "Custom number" }]}
          />
          {cfg.to === "custom" && (
            <Input value={cfg.custom_phone ?? ""} onChange={(e) => setConfig({ custom_phone: e.target.value })} placeholder="+15125551234" className="mt-1.5 h-8 text-sm" />
          )}
        </Field>
        <Field label="Message">
          <Textarea
            value={cfg.message ?? ""}
            onChange={(e) => setConfig({ message: e.target.value })}
            placeholder="Hi {contact.first_name}, …"
            className="min-h-[100px] resize-none text-sm"
          />
          <TokenBar onInsert={(t) => setConfig({ message: (cfg.message ?? "") + t })} />
        </Field>
      </>
    );
  }

  if (nodeType === "send_email") {
    return (
      <>
        <Field label="Send to">
          <Select value={cfg.to ?? "contact_email"} onChange={(v) => setConfig({ to: v })}
            options={[{ value: "contact_email", label: "Contact email" }, { value: "custom", label: "Custom email" }]}
          />
          {cfg.to === "custom" && (
            <Input value={cfg.custom_email ?? ""} onChange={(e) => setConfig({ custom_email: e.target.value })} placeholder="client@example.com" className="mt-1.5 h-8 text-sm" />
          )}
        </Field>
        <Field label="Subject">
          <Input value={cfg.subject ?? ""} onChange={(e) => setConfig({ subject: e.target.value })} placeholder="e.g. Following up from {org.name}" className="h-8 text-sm" />
          <TokenBar onInsert={(t) => setConfig({ subject: (cfg.subject ?? "") + t })} />
        </Field>
        <Field label="Body">
          <Textarea value={cfg.body ?? ""} onChange={(e) => setConfig({ body: e.target.value })} placeholder={"Hi {contact.first_name},\n\nYour message here…"} className="min-h-30 resize-none text-sm" />
          <TokenBar onInsert={(t) => setConfig({ body: (cfg.body ?? "") + t })} />
        </Field>
        <Hint>Sent via your SMTP account (support@renometa.com). Tokens like {"{org.name}"} and {"{contact.first_name}"} are filled in at send time.</Hint>
      </>
    );
  }

  if (nodeType === "create_task") {
    return (
      <>
        <Field label="Task title">
          <Input value={cfg.title ?? ""} onChange={(e) => setConfig({ title: e.target.value })} placeholder="e.g. Follow up with {contact.first_name}" className="h-8 text-sm" />
          <TokenBar onInsert={(t) => setConfig({ title: (cfg.title ?? "") + t })} />
        </Field>
        <Field label="Assign to">
          <Select
            value={cfg.assignee ?? "owner"}
            onChange={(v) => setConfig({ assignee: v, member_id: "", member_name: "" })}
            options={[
              { value: "owner", label: "Account owner (primary user)" },
              { value: "round_robin", label: "Round-robin (team)" },
              { value: "specific", label: "Specific team member" },
            ]}
          />
          {cfg.assignee === "owner" && (
            <p className="mt-1 text-[10px] text-muted-foreground">The task will be assigned to the account's owner user.</p>
          )}
          {cfg.assignee === "specific" && (
            activeMembers.length === 0 ? (
              <p className="mt-1.5 text-[10px] text-amber-600">No active team members found. Add members in Settings → Team.</p>
            ) : (
              <select
                value={cfg.member_id ?? ""}
                onChange={(e) => {
                  const m = activeMembers.find((m) => m.id === e.target.value);
                  setConfig({ member_id: e.target.value, member_name: m?.name ?? "" });
                }}
                className="mt-1.5 flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Select a team member…</option>
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} · {ROLE_LABELS[m.role] ?? m.role}</option>
                ))}
              </select>
            )
          )}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Due in">
            <Input type="number" min={1} value={cfg.due_in ?? 1} onChange={(e) => setConfig({ due_in: Number(e.target.value) })} className="h-8 text-sm" />
          </Field>
          <Field label="Unit">
            <Select value={cfg.due_unit ?? "days"} onChange={(v) => setConfig({ due_unit: v })}
              options={[{ value: "hours", label: "hours" }, { value: "days", label: "days" }, { value: "weeks", label: "weeks" }]}
            />
          </Field>
        </div>
        <Field label="Priority">
          <Select value={cfg.priority ?? "medium"} onChange={(v) => setConfig({ priority: v })}
            options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]}
          />
        </Field>
      </>
    );
  }

  if (nodeType === "update_status") {
    return (
      <>
        <Field label="Entity">
          <Select value={cfg.entity ?? "lead"} onChange={(v) => setConfig({ entity: v, field: "status", value: "" })}
            options={[{ value: "lead", label: "Lead" }, { value: "project", label: "Project" }, { value: "deal", label: "Deal" }]}
          />
        </Field>
        <Field label="Field">
          <Select value={cfg.field ?? "status"} onChange={(v) => setConfig({ field: v })}
            options={cfg.entity === "project"
              ? [{ value: "stage", label: "Stage" }, { value: "status", label: "Status" }]
              : [{ value: "status", label: "Status" }]
            }
          />
        </Field>
        <Field label="New value">
          {cfg.entity === "project" && cfg.field === "stage" ? (
            <Select value={cfg.value ?? ""} onChange={(v) => setConfig({ value: v })}
              options={[
                { value: "estimating", label: "Estimating" }, { value: "contracted", label: "Contracted" },
                { value: "pre-construction", label: "Pre-Construction" }, { value: "in-progress", label: "In Progress" },
                { value: "punch-list", label: "Punch List" }, { value: "completed", label: "Completed" },
              ]}
            />
          ) : (
            <Select value={cfg.value ?? ""} onChange={(v) => setConfig({ value: v })}
              options={[
                { value: "new", label: "New" }, { value: "contacted", label: "Contacted" },
                { value: "qualified", label: "Qualified" }, { value: "converted", label: "Converted" },
                { value: "lost", label: "Lost" },
              ]}
            />
          )}
        </Field>
      </>
    );
  }

  if (nodeType === "assign_member") {
    return (
      <>
        <Field label="Assignment strategy">
          <Select
            value={cfg.strategy ?? "round_robin"}
            onChange={(v) => setConfig({ strategy: v, member_id: "", member_name: "" })}
            options={[
              { value: "round_robin", label: "Round-robin (entire team)" },
              { value: "specific", label: "Specific team member" },
            ]}
          />
        </Field>
        {cfg.strategy === "specific" && (
          <Field label="Team member">
            {activeMembers.length === 0 ? (
              <p className="text-[10px] text-amber-600">No active team members found. Add members in Settings → Team.</p>
            ) : (
              <select
                value={cfg.member_id ?? ""}
                onChange={(e) => {
                  const m = activeMembers.find((m) => m.id === e.target.value);
                  setConfig({ member_id: e.target.value, member_name: m?.name ?? "" });
                }}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Select a team member…</option>
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} · {ROLE_LABELS[m.role] ?? m.role}</option>
                ))}
              </select>
            )}
          </Field>
        )}
      </>
    );
  }

  if (nodeType === "send_portal_invite") {
    return (
      <>
        <Hint>Sends the contact a portal link where they can approve estimates, pay invoices, and message your team.</Hint>
        <Field label="Send invite to">
          <Select
            value={cfg.send_to ?? "contact_email"}
            onChange={(v) => setConfig({ send_to: v, custom_email: "" })}
            options={[
              { value: "contact_email", label: "Contact email (from record)" },
              { value: "custom", label: "Custom email address" },
            ]}
          />
          {cfg.send_to === "custom" && (
            <Input value={cfg.custom_email ?? ""} onChange={(e) => setConfig({ custom_email: e.target.value })} placeholder="client@example.com" className="mt-1.5 h-8 text-sm" />
          )}
        </Field>
        <Field label="Personal note (optional)">
          <Textarea
            value={cfg.note ?? ""}
            onChange={(e) => setConfig({ note: e.target.value })}
            placeholder="e.g. We've set up your project portal where you can track progress and approve your estimate."
            className="min-h-20 resize-none text-sm"
          />
          <TokenBar onInsert={(t) => setConfig({ note: (cfg.note ?? "") + t })} />
        </Field>
      </>
    );
  }

  if (nodeType === "add_note") {
    return (
      <>
        <Field label="Add note to">
          <Select value={cfg.target ?? "lead"} onChange={(v) => setConfig({ target: v })}
            options={[{ value: "lead", label: "Lead" }, { value: "contact", label: "Contact" }, { value: "project", label: "Project" }]}
          />
        </Field>
        <Field label="Note content">
          <Textarea value={cfg.content ?? ""} onChange={(e) => setConfig({ content: e.target.value })} placeholder="Workflow note: …" className="min-h-[80px] resize-none text-sm" />
          <TokenBar onInsert={(t) => setConfig({ content: (cfg.content ?? "") + t })} />
        </Field>
      </>
    );
  }

  // ── Conditions ──

  if (nodeType === "if_else" || nodeType === "filter") {
    return (
      <>
        <Field label="Field">
          <Select value={cfg.field ?? ""} onChange={(v) => setConfig({ field: v })}
            options={[{ value: "", label: "Select a field…" }, ...CONDITION_FIELDS]}
          />
        </Field>
        <Field label="Operator">
          <Select value={cfg.operator ?? "equals"} onChange={(v) => setConfig({ operator: v })}
            options={CONDITION_OPERATORS}
          />
        </Field>
        {cfg.operator !== "is_empty" && cfg.operator !== "is_not_empty" && (
          <Field label="Value">
            <Input value={cfg.value ?? ""} onChange={(e) => setConfig({ value: e.target.value })} placeholder="Enter value…" className="h-8 text-sm" />
          </Field>
        )}
        {nodeType === "if_else" && (
          <Hint>Yes branch continues when condition is true. No branch continues when false.</Hint>
        )}
        {nodeType === "filter" && (
          <Hint>Workflow continues only when condition is met. Otherwise it stops here.</Hint>
        )}
      </>
    );
  }

  // ── Utilities ──

  if (nodeType === "wait") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field label="Wait for">
          <Input type="number" min={1} value={cfg.amount ?? 1} onChange={(e) => setConfig({ amount: Number(e.target.value) })} className="h-8 text-sm" />
        </Field>
        <Field label="Unit">
          <Select value={cfg.unit ?? "days"} onChange={(v) => setConfig({ unit: v })}
            options={[{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" }, { value: "weeks", label: "weeks" }]}
          />
        </Field>
      </div>
    );
  }

  if (nodeType === "ai_step") {
    return (
      <>
        <Field label="System prompt">
          <Textarea value={cfg.system_prompt ?? ""} onChange={(e) => setConfig({ system_prompt: e.target.value })} className="min-h-[80px] resize-none text-sm" />
        </Field>
        <Field label="User prompt">
          <Textarea value={cfg.user_prompt ?? ""} onChange={(e) => setConfig({ user_prompt: e.target.value })} placeholder="Summarize this lead: {lead.project_type}, budget {lead.estimated_budget}" className="min-h-[80px] resize-none text-sm" />
          <TokenBar onInsert={(t) => setConfig({ user_prompt: (cfg.user_prompt ?? "") + t })} />
        </Field>
        <Field label="Save output to variable">
          <Input value={cfg.output_variable ?? "ai_output"} onChange={(e) => setConfig({ output_variable: e.target.value })} className="h-8 text-sm" />
        </Field>
        <Hint>Uses Claude Haiku. Output is stored in the run context and can be referenced in later steps.</Hint>
      </>
    );
  }

  if (nodeType === "webhook") {
    const headers: { key: string; value: string }[] = cfg.headers ?? [];
    return (
      <>
        <Field label="URL">
          <Input value={cfg.url ?? ""} onChange={(e) => setConfig({ url: e.target.value })} placeholder="https://hooks.example.com/…" className="h-8 text-sm" />
        </Field>
        <Field label="Method">
          <Select value={cfg.method ?? "POST"} onChange={(v) => setConfig({ method: v })}
            options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }, { value: "PUT", label: "PUT" }, { value: "PATCH", label: "PATCH" }]}
          />
        </Field>
        <Field label="Headers">
          {headers.map((h, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <Input value={h.key} onChange={(e) => { const next = [...headers]; next[i] = { ...h, key: e.target.value }; setConfig({ headers: next }); }} placeholder="Key" className="h-7 flex-1 text-xs" />
              <Input value={h.value} onChange={(e) => { const next = [...headers]; next[i] = { ...h, value: e.target.value }; setConfig({ headers: next }); }} placeholder="Value" className="h-7 flex-1 text-xs" />
              <button onClick={() => setConfig({ headers: headers.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button onClick={() => setConfig({ headers: [...headers, { key: "", value: "" }] })} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
            <Plus className="h-3 w-3" /> Add header
          </button>
        </Field>
        <Field label="Body template (JSON)">
          <Textarea value={cfg.body ?? ""} onChange={(e) => setConfig({ body: e.target.value })} placeholder='{"name": "{contact.first_name}"}' className="min-h-[80px] resize-none font-mono text-xs" />
        </Field>
      </>
    );
  }

  return <Hint>No configuration available for this node type.</Hint>;
}

// ── Shared primitives ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md bg-secondary/60 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function TokenBar({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {VARIABLE_TOKENS.map((t) => (
        <button
          key={t.token}
          onClick={() => onInsert(t.token)}
          className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Subtitle builder ─────────────────────────────────────────────────────────
// Generates a human-readable subtitle from config, displayed on the canvas node.

function buildSubtitle(nodeType: WfNodeType, cfg: Record<string, any>): string {
  switch (nodeType) {
    case "new_lead":
    case "contact_created": return cfg.source === "any" ? "Any source" : `From: ${cfg.source}`;
    case "lead_status_changed": return `${cfg.from_status ?? "any"} → ${cfg.to_status ?? "any"}`;
    case "project_status_changed": return `${cfg.from_stage ?? "any"} → ${cfg.to_stage ?? "any"}`;
    case "invoice_overdue": return `${cfg.days_overdue ?? 7} days overdue`;
    case "form_submitted": return cfg.form_name || "Any form";
    case "send_sms": return `To: ${cfg.to === "custom" ? cfg.custom_phone || "?" : "contact phone"}`;
    case "send_email": return cfg.subject ? `"${cfg.subject}"` : `To: ${cfg.to === "custom" ? cfg.custom_email || "?" : "contact email"}`;
    case "create_task": return cfg.title || "Follow up with contact";
    case "update_status": return `${cfg.entity ?? "lead"} ${cfg.field ?? "status"} → ${cfg.value || "?"}`;
    case "assign_member": return cfg.strategy === "round_robin" ? "Round-robin" : (cfg.member_name || "Select member");
    case "send_portal_invite": return cfg.send_to === "custom" ? (cfg.custom_email || "Custom email") : "To contact email";
    case "wait": return `Wait ${cfg.amount ?? 1} ${cfg.unit ?? "days"}`;
    case "if_else":
    case "filter": {
      const field = CONDITION_FIELDS.find((f) => f.value === cfg.field)?.label ?? cfg.field ?? "?";
      const op = CONDITION_OPERATORS.find((o) => o.value === cfg.operator)?.label ?? cfg.operator ?? "?";
      const val = cfg.operator === "is_empty" || cfg.operator === "is_not_empty" ? "" : ` "${cfg.value ?? "?"}"`;
      return `${field} ${op}${val}`;
    }
    case "ai_step": return "Claude Haiku";
    case "webhook": return cfg.url ? `${cfg.method ?? "POST"} ${cfg.url}` : "Configure URL";
    default: return "";
  }
}
