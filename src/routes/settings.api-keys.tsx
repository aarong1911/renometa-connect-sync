import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysSettings,
});

type ApiKey = {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsed: string | null;
};

const SEED: ApiKey[] = [
  { id: "k1", label: "Zapier integration", prefix: "rk_live_8a32", createdAt: "2026-02-12", lastUsed: "2026-04-15" },
  { id: "k2", label: "Internal reporting", prefix: "rk_live_b194", createdAt: "2025-11-04", lastUsed: null },
];

function generatePrefix() {
  return "rk_live_" + Math.random().toString(16).slice(2, 6);
}

function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKey[]>(SEED);
  const [newLabel, setNewLabel] = useState("");

  function create() {
    if (!newLabel.trim()) return;
    const prefix = generatePrefix();
    const created: ApiKey = {
      id: `k${Date.now()}`,
      label: newLabel.trim(),
      prefix,
      createdAt: new Date().toISOString().slice(0, 10),
      lastUsed: null,
    };
    setKeys((k) => [created, ...k]);
    setNewLabel("");
    navigator.clipboard?.writeText(`${prefix}_${Math.random().toString(36).slice(2, 18)}`).catch(() => {});
    toast.success("API key created", {
      description: "Full key copied to clipboard. You won't see it again.",
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold">Create API key</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Use API keys to integrate with external services
        </p>
        <div className="mt-4 flex max-w-xl gap-3">
          <div className="flex-1">
            <Label className="text-xs">Label</Label>
            <Input
              className="mt-1.5 h-9"
              placeholder="e.g. Zapier integration"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button size="sm" className="h-9" onClick={create} disabled={!newLabel.trim()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Generate
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border p-4">
          <h2 className="text-base font-semibold">Active keys</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {keys.length} key{keys.length === 1 ? "" : "s"}
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Label</th>
              <th className="px-4 py-2 text-left font-medium">Prefix</th>
              <th className="px-4 py-2 text-left font-medium">Created</th>
              <th className="px-4 py-2 text-left font-medium">Last used</th>
              <th className="w-20 px-4"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="h-12 border-b border-border last:border-b-0">
                <td className="px-4">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">{k.label}</span>
                  </div>
                </td>
                <td className="px-4 font-mono text-xs">{k.prefix}…</td>
                <td className="px-4 text-xs text-muted-foreground">{formatDate(k.createdAt)}</td>
                <td className="px-4 text-xs text-muted-foreground">
                  {k.lastUsed ? (
                    formatDate(k.lastUsed)
                  ) : (
                    <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
                      Never
                    </Badge>
                  )}
                </td>
                <td className="px-4 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => {
                        navigator.clipboard?.writeText(k.prefix).catch(() => {});
                        toast.success("Prefix copied");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setKeys((all) => all.filter((x) => x.id !== k.id));
                        toast.success("API key revoked");
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
