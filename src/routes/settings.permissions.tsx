// src/routes/settings.permissions.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useTeam, memberInitials, ROLE_LABELS, type Role, type TeamMember } from "@/lib/organization";

export const Route = createFileRoute("/settings/permissions")({ component: PermissionsPage });

// ── Feature definitions ───────────────────────────────────────────────────────

type Action  = "view" | "create" | "edit" | "delete";
const ACTIONS: Action[] = ["view", "create", "edit", "delete"];

type Feature = { id: string; label: string; description: string };
type Section = { label: string; features: Feature[] };

const SECTIONS: Section[] = [
  { label: "CRM", features: [
    { id: "contacts",      label: "Contacts",      description: "Client & vendor profiles" },
    { id: "companies",     label: "Companies",      description: "Business accounts" },
    { id: "leads",         label: "Leads",          description: "Top-of-funnel pipeline" },
    { id: "pipeline",      label: "Pipeline",       description: "Sales stages" },
  ]},
  { label: "Projects", features: [
    { id: "projects",      label: "Projects",       description: "Jobs & scopes" },
    { id: "tasks",         label: "Tasks",          description: "Checklists & schedules" },
    { id: "calendar",      label: "Calendar",       description: "Scheduling & dispatch" },
    { id: "files",         label: "Files",          description: "Documents & assets" },
  ]},
  { label: "Inbox", features: [
    { id: "conversations", label: "Conversations",  description: "Client & team messages" },
    { id: "templates",     label: "Templates",      description: "Message templates" },
    { id: "broadcasts",    label: "Broadcasts",     description: "Bulk messaging" },
  ]},
  { label: "Automation", features: [
    { id: "workflows",     label: "Workflows",      description: "Automated sequences" },
    { id: "ai_center",     label: "AI Center",      description: "AI tools & agents" },
    { id: "triggers",      label: "Triggers",       description: "Event-based actions" },
  ]},
  { label: "Financials", features: [
    { id: "estimates",     label: "Estimates",      description: "Proposals & bids" },
    { id: "invoices",      label: "Invoices",       description: "Billing & collections" },
    { id: "payments",      label: "Payments",       description: "Transactions & receipts" },
  ]},
  { label: "Insights", features: [
    { id: "analytics",     label: "Analytics",      description: "Business reporting" },
    { id: "reputation",    label: "Reputation",     description: "Reviews & ratings" },
  ]},
];

// ── Role action defaults ──────────────────────────────────────────────────────
// Which features each role can access by route, and default actions within them

const ROLE_FEATURE_ACCESS: Record<Role, string[]> = {
  owner:          ["*"],
  admin:          ["*"],
  office_manager: ["contacts","companies","leads","pipeline","projects","tasks","calendar","files","conversations","templates","broadcasts","estimates","invoices","payments"],
  estimator:      ["contacts","companies","leads","pipeline","conversations","templates","estimates"],
  sales:          ["contacts","companies","leads","pipeline","conversations","templates","broadcasts","estimates"],
  project_manager:["contacts","companies","projects","tasks","calendar","files","conversations","templates","estimates"],
  field_worker:   [],
  accountant:     ["contacts","companies","estimates","invoices","payments","analytics"],
  viewer:         [],
};

const ROLE_ACTION_DEFAULTS: Record<Role, Record<Action, boolean>> = {
  owner:          { view: true,  create: true,  edit: true,  delete: true  },
  admin:          { view: true,  create: true,  edit: true,  delete: true  },
  office_manager: { view: true,  create: true,  edit: true,  delete: false },
  estimator:      { view: true,  create: true,  edit: true,  delete: false },
  sales:          { view: true,  create: true,  edit: true,  delete: false },
  project_manager:{ view: true,  create: true,  edit: true,  delete: false },
  field_worker:   { view: false, create: false, edit: false, delete: false },
  accountant:     { view: true,  create: false, edit: false, delete: false },
  viewer:         { view: false, create: false, edit: false, delete: false },
};

function getRoleDefault(role: Role, featureId: string, action: Action): boolean {
  const access = ROLE_FEATURE_ACCESS[role];
  const hasAccess = access[0] === "*" || access.includes(featureId);
  if (!hasAccess) return false;
  return ROLE_ACTION_DEFAULTS[role][action];
}

// ── Override lookup key ───────────────────────────────────────────────────────

type OverrideMap = Map<string, boolean>; // `${feature}:${action}` -> granted
function overrideKey(feature: string, action: Action) { return `${feature}:${action}`; }

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ on, inherited, onChange }: {
  on: boolean; inherited: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-block h-5 w-9 shrink-0 rounded-full border-none transition-colors duration-200 cursor-pointer",
        on
          ? inherited ? "bg-[#97C459] opacity-70" : "bg-[#378ADD]"
          : inherited ? "bg-[#888780] opacity-50" : "bg-[#B4B2A9]"
      )}
      title={inherited ? "Role default (click to override)" : "Custom override (click to change)"}
    >
      <span className={cn(
        "absolute top-0.75 h-3.5 w-3.5 rounded-full transition-[left] duration-200",
        on ? "left-4.75" : "left-0.75",
        on ? "bg-white" : inherited ? "bg-[#d3d1c7]" : "bg-[#f0efeb]",
      )} />
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function PermissionsPage() {
  const team = useTeam();
  const [orgId, setOrgId]               = useState<string | null>(null);
  const [selected, setSelected]         = useState<TeamMember | null>(null);
  const [overrides, setOverrides]       = useState<OverrideMap>(new Map());
  const [loading, setLoading]           = useState(false);
  const [saving, setSaving]             = useState<string | null>(null);

  // Get org ID
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle()
        .then(({ data }) => setOrgId(data?.organization_id ?? null));
    });
  }, []);

  // Select first non-owner member by default
  useEffect(() => {
    if (team.length > 0 && !selected) {
      const first = team.find(m => m.role !== "owner") ?? team[0];
      setSelected(first);
    }
  }, [team]);

  // Load overrides when member changes
  useEffect(() => {
    if (!selected || !orgId) return;
    setLoading(true);
    supabase.from("member_permissions")
      .select("feature, action, granted")
      .eq("org_id", orgId)
      .eq("member_id", selected.id)
      .then(({ data }) => {
        const map = new Map<string, boolean>();
        for (const row of data ?? []) map.set(overrideKey(row.feature, row.action as Action), row.granted);
        setOverrides(map);
        setLoading(false);
      });
  }, [selected?.id, orgId]);

  const handleToggle = async (featureId: string, action: Action, newValue: boolean) => {
    if (!selected || !orgId) return;
    const key        = overrideKey(featureId, action);
    const roleDefault = getRoleDefault(selected.role, featureId, action);
    setSaving(key);

    // If toggling back to role default → delete the override
    if (newValue === roleDefault) {
      await supabase.from("member_permissions")
        .delete()
        .eq("org_id", orgId).eq("member_id", selected.id)
        .eq("feature", featureId).eq("action", action);
      setOverrides(prev => { const m = new Map(prev); m.delete(key); return m; });
    } else {
      // Upsert the override
      await supabase.from("member_permissions").upsert({
        org_id: orgId, member_id: selected.id,
        feature: featureId, action, granted: newValue,
        updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,member_id,feature,action" });
      setOverrides(prev => new Map(prev).set(key, newValue));
    }
    setSaving(null);
  };

  const handleReset = async () => {
    if (!selected || !orgId) return;
    await supabase.from("member_permissions")
      .delete().eq("org_id", orgId).eq("member_id", selected.id);
    setOverrides(new Map());
    toast.success("Reset to role defaults");
  };

  const overrideCount = overrides.size;

  const getToggleState = (featureId: string, action: Action): { on: boolean; inherited: boolean } => {
    const key         = overrideKey(featureId, action);
    const roleDefault = getRoleDefault(selected?.role ?? "viewer", featureId, action);
    if (overrides.has(key)) return { on: overrides.get(key)!, inherited: false };
    return { on: roleDefault, inherited: true };
  };

  const isOverridden = (featureId: string, action: Action) =>
    overrides.has(overrideKey(featureId, action));

  return (
    <div>
      <div className="mb-5">
        <h3 className="text-sm font-semibold">Permissions</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Override role defaults for individual team members. Owner-only feature.</p>
      </div>

      <div className="grid grid-cols-[200px_1fr] gap-4">
        {/* Member list */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">Team members</p>
          <div className="space-y-0.5">
            {team.map(m => (
              <button key={m.id} onClick={() => setSelected(m)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors",
                  selected?.id === m.id ? "bg-primary/10" : "hover:bg-secondary"
                )}>
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback className="text-[10px] font-medium bg-primary/10 text-primary">
                    {memberInitials(m.name && m.name !== m.email ? m.name : m.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{m.name && m.name !== m.email ? m.name : m.email}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{ROLE_LABELS[m.role]}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Matrix */}
        <div>
          {!selected ? (
            <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              Select a team member to manage permissions
            </div>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
                <div className="flex items-center gap-2.5">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-[10px] font-medium bg-primary/10 text-primary">
                      {memberInitials(selected.name && selected.name !== selected.email ? selected.name : selected.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-semibold">{selected.name && selected.name !== selected.email ? selected.name : selected.email}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {ROLE_LABELS[selected.role]}
                      {overrideCount > 0 && ` · ${overrideCount} override${overrideCount > 1 ? "s" : ""} active`}
                    </p>
                  </div>
                </div>
                {overrideCount > 0 && (
                  <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleReset}>
                    <RotateCcw className="h-3 w-3" />Reset to defaults
                  </Button>
                )}
              </div>

              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-secondary/60">
                    <tr>
                      <th className="py-2 pl-4 pr-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Feature</th>
                      {ACTIONS.map(a => (
                        <th key={a} className="py-2 px-3 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-20">{a}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SECTIONS.map(section => (
                      <>
                        <tr key={`section-${section.label}`} className="bg-secondary/30">
                          <td colSpan={5} className="py-1.5 pl-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-t border-border">
                            {section.label}
                          </td>
                        </tr>
                        {section.features.map(feature => (
                          <tr key={feature.id} className="border-b border-border last:border-0 hover:bg-secondary/20">
                            <td className="py-2.5 pl-4 pr-3">
                              <div className="flex items-center gap-2">
                                <div>
                                  <p className="text-xs font-medium">{feature.label}</p>
                                  <p className="text-[10px] text-muted-foreground">{feature.description}</p>
                                </div>
                                {ACTIONS.some(a => isOverridden(feature.id, a)) && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-blue-200 bg-blue-50 text-blue-700 ml-1">Override</Badge>
                                )}
                              </div>
                            </td>
                            {ACTIONS.map(action => {
                              const { on, inherited } = getToggleState(feature.id, action);
                              const key = overrideKey(feature.id, action);
                              return (
                                <td key={action} className="py-2.5 px-3 text-center">
                                  {saving === key
                                    ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
                                    : <Toggle on={on} inherited={inherited} onChange={v => handleToggle(feature.id, action, v)} />
                                  }
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Legend */}
              <div className="flex gap-4 px-4 py-2.5 border-t border-border bg-secondary/30">
                {[
                  { color: "bg-[#378ADD]", label: "Override (manually set)" },
                  { color: "bg-[#97C459] opacity-70", label: "Role default (on)" },
                  { color: "bg-[#888780] opacity-50", label: "Role default (off)" },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-1.5">
                    <div className={cn("h-2.5 w-2.5 rounded-full", item.color)} />
                    <span className="text-[10px] text-muted-foreground">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}