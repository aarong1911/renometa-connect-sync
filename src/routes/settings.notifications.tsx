import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsSettings,
});

type Channel = "email" | "sms" | "inApp";
type Pref = { id: string; label: string; description: string; channels: Record<Channel, boolean> };

const DEFAULTS: Pref[] = [
  {
    id: "new-lead",
    label: "New lead",
    description: "When a contact is added or a form is submitted",
    channels: { email: true, sms: false, inApp: true },
  },
  {
    id: "deal-stage",
    label: "Deal stage change",
    description: "When a deal moves between pipeline stages",
    channels: { email: false, sms: false, inApp: true },
  },
  {
    id: "invoice-paid",
    label: "Invoice paid",
    description: "When a payment is received",
    channels: { email: true, sms: true, inApp: true },
  },
  {
    id: "invoice-overdue",
    label: "Invoice overdue",
    description: "When a milestone passes its due date",
    channels: { email: true, sms: false, inApp: true },
  },
  {
    id: "mention",
    label: "@mentions",
    description: "When a teammate mentions you in a note or task",
    channels: { email: true, sms: false, inApp: true },
  },
  {
    id: "weekly-digest",
    label: "Weekly digest",
    description: "Monday morning summary of pipeline & cashflow",
    channels: { email: true, sms: false, inApp: false },
  },
];

function NotificationsSettings() {
  const [prefs, setPrefs] = useState<Pref[]>(DEFAULTS);

  function toggle(id: string, channel: Channel) {
    setPrefs((all) =>
      all.map((p) =>
        p.id === id ? { ...p, channels: { ...p.channels, [channel]: !p.channels[channel] } } : p,
      ),
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-base font-semibold">Notifications</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose how you want to be notified
          </p>
        </div>
        <Button size="sm" className="h-8" onClick={() => toast.success("Preferences saved")}>
          Save changes
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Event</th>
            <th className="w-20 px-2 text-center font-medium">Email</th>
            <th className="w-20 px-2 text-center font-medium">SMS</th>
            <th className="w-20 px-2 text-center font-medium">In-app</th>
          </tr>
        </thead>
        <tbody>
          {prefs.map((p) => (
            <tr key={p.id} className="border-b border-border last:border-b-0">
              <td className="px-4 py-3">
                <div className="font-medium">{p.label}</div>
                <div className="text-xs text-muted-foreground">{p.description}</div>
              </td>
              {(["email", "sms", "inApp"] as Channel[]).map((c) => (
                <td key={c} className="px-2 text-center">
                  <Switch checked={p.channels[c]} onCheckedChange={() => toggle(p.id, c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
