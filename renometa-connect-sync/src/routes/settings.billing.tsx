// src/routes/settings.billing.tsx
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";

export const Route = createFileRoute("/settings/billing")({
  component: BillingSettings,
});

const plans = [
  { name: "Starter", price: 0, features: ["Up to 3 users", "1,000 contacts", "Basic pipeline"], current: false },
  { name: "Growth", price: 79, features: ["Up to 15 users", "Unlimited contacts", "Workflows", "AI Agents (basic)"], current: true },
  { name: "Pro", price: 199, features: ["Unlimited users", "Advanced AI Agents", "Custom roles", "Priority support"], current: false },
];

function BillingSettings() {
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Growth plan</h2>
              <Badge variant="secondary" className="h-5 rounded bg-primary-soft px-1.5 text-[10px] text-primary">Current</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">$79 / month · Renews May 18, 2026</p>
          </div>
          <Button variant="outline" size="sm" className="h-8">Manage subscription</Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.name} className={`p-5 ${p.current ? "border-primary" : ""}`}>
            <div className="text-sm font-semibold">{p.name}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">
              ${p.price}<span className="text-xs font-normal text-muted-foreground">/mo</span>
            </div>
            <ul className="mt-4 space-y-1.5 text-xs">
              {p.features.map((f) => (
                <li key={f} className="flex items-center gap-1.5">
                  <Check className="h-3 w-3 text-success" /> {f}
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant={p.current ? "outline" : "default"}
              disabled={p.current}
              className="mt-4 h-8 w-full"
            >
              {p.current ? "Current plan" : `Upgrade to ${p.name}`}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
