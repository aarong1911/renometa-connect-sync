// src/components/automation/agent-configure-dialog.tsx
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import {
  DEFAULT_AGENT_CONFIG,
  clearAgentConfig,
  loadAgentConfig,
  saveAgentConfig,
  type AgentConfig,
} from "@/lib/agent-config";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  triggers: string[];
  channels: string[];
};

const TONE_OPTIONS: { value: AgentConfig["tone"]; label: string; hint: string }[] = [
  { value: "professional", label: "Professional", hint: "Polished, concise, business-first" },
  { value: "friendly", label: "Friendly", hint: "Warm and approachable" },
  { value: "casual", label: "Casual", hint: "Conversational, like a text from a friend" },
  { value: "formal", label: "Formal", hint: "Buttoned-up and traditional" },
];

function buildDefaults(triggers: string[], channels: string[]): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    triggersEnabled: Object.fromEntries(triggers.map((t) => [t, true])),
    channelsEnabled: Object.fromEntries(channels.map((c) => [c, true])),
  };
}

export function AgentConfigureDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  triggers,
  channels,
}: Props) {
  const defaults = useMemo(
    () => buildDefaults(triggers, channels),
    [triggers, channels],
  );
  const [config, setConfig] = useState<AgentConfig>(defaults);

  useEffect(() => {
    if (!open) return;
    const saved = loadAgentConfig(agentId);
    setConfig(
      saved
        ? {
            ...defaults,
            ...saved,
            triggersEnabled: { ...defaults.triggersEnabled, ...saved.triggersEnabled },
            channelsEnabled: { ...defaults.channelsEnabled, ...saved.channelsEnabled },
          }
        : defaults,
    );
  }, [open, agentId, defaults]);

  const update = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setConfig((c) => ({ ...c, [k]: v }));

  const handleSave = () => {
    saveAgentConfig(agentId, config);
    toast.success(`${agentName} settings saved`);
    onOpenChange(false);
  };

  const handleReset = () => {
    clearAgentConfig(agentId);
    setConfig(defaults);
    toast.info(`${agentName} restored to defaults`);
  };

  const autonomyLabel =
    config.autonomy >= 80
      ? "High — acts independently"
      : config.autonomy >= 40
        ? "Balanced — checks in on edge cases"
        : "Low — drafts for human approval";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Configure {agentName}</DialogTitle>
          <DialogDescription className="text-xs">
            Tune how this agent communicates, when it runs, and what it can do without a human.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="behavior" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="behavior" className="text-xs">Behavior</TabsTrigger>
            <TabsTrigger value="triggers" className="text-xs">Triggers</TabsTrigger>
            <TabsTrigger value="channels" className="text-xs">Channels</TabsTrigger>
            <TabsTrigger value="guardrails" className="text-xs">Guardrails</TabsTrigger>
          </TabsList>

          <div className="mt-3 max-h-[55vh] overflow-y-auto pr-1">
            <TabsContent value="behavior" className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Tone of voice</Label>
                <Select
                  value={config.tone}
                  onValueChange={(v) => update("tone", v as AgentConfig["tone"])}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TONE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">
                        <div className="flex flex-col">
                          <span className="font-medium">{o.label}</span>
                          <span className="text-[10px] text-muted-foreground">{o.hint}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Autonomy</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {config.autonomy}%
                  </span>
                </div>
                <Slider
                  value={[config.autonomy]}
                  onValueChange={([v]) => update("autonomy", v)}
                  min={0}
                  max={100}
                  step={5}
                />
                <p className="text-[10px] text-muted-foreground">{autonomyLabel}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Max runs / day</Label>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={config.maxRunsPerDay}
                    onChange={(e) =>
                      update("maxRunsPerDay", Math.max(1, Number(e.target.value) || 1))
                    }
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Hand off after</Label>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={config.handoffThreshold}
                    onChange={(e) =>
                      update("handoffThreshold", Math.max(1, Number(e.target.value) || 1))
                    }
                    className="h-9 text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">messages without resolution</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Custom instructions</Label>
                <Textarea
                  value={config.instructions}
                  onChange={(e) => update("instructions", e.target.value)}
                  placeholder="e.g. Always mention our 10-year workmanship warranty on kitchens."
                  className="min-h-[90px] text-xs"
                />
              </div>
            </TabsContent>

            <TabsContent value="triggers" className="space-y-2">
              {triggers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No triggers defined for this agent.</p>
              ) : (
                triggers.map((t) => {
                  const enabled = config.triggersEnabled[t] ?? true;
                  return (
                    <div
                      key={t}
                      className="flex items-center justify-between rounded-md border border-border bg-secondary/30 p-2.5"
                    >
                      <span className="text-xs">{t}</span>
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) =>
                          update("triggersEnabled", { ...config.triggersEnabled, [t]: v })
                        }
                      />
                    </div>
                  );
                })
              )}
            </TabsContent>

            <TabsContent value="channels" className="space-y-2">
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">No channels defined for this agent.</p>
              ) : (
                channels.map((c) => {
                  const enabled = config.channelsEnabled[c] ?? true;
                  return (
                    <div
                      key={c}
                      className="flex items-center justify-between rounded-md border border-border bg-secondary/30 p-2.5"
                    >
                      <span className="text-xs">{c}</span>
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) =>
                          update("channelsEnabled", { ...config.channelsEnabled, [c]: v })
                        }
                      />
                    </div>
                  );
                })
              )}
            </TabsContent>

            <TabsContent value="guardrails" className="space-y-3">
              <GuardrailRow
                title="Require human approval"
                description="Every outbound message must be approved before sending."
                checked={config.requireApproval}
                onChange={(v) => update("requireApproval", v)}
              />
              <GuardrailRow
                title="Business hours only"
                description="Only act between 8am and 6pm in the org's timezone."
                checked={config.businessHoursOnly}
                onChange={(v) => update("businessHoursOnly", v)}
              />
              <GuardrailRow
                title="Run on weekends"
                description="Allow the agent to act on Saturdays and Sundays."
                checked={config.weekendsEnabled}
                onChange={(v) => update("weekendsEnabled", v)}
              />
            </TabsContent>
          </div>
        </Tabs>

        <Separator />

        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" className="h-8" onClick={handleReset}>
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="text-xs">Reset to defaults</span>
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => onOpenChange(false)}>
              <span className="text-xs">Cancel</span>
            </Button>
            <Button size="sm" className="h-8" onClick={handleSave}>
              <Save className="h-3.5 w-3.5" />
              <span className="text-xs">Save settings</span>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardrailRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-secondary/30 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">{title}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}