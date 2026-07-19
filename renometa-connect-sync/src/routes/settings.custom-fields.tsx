import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/custom-fields")({
  component: CustomFieldsSettings,
});

type FieldType = "text" | "number" | "date" | "select" | "checkbox";
type Entity = "Project" | "Contact" | "Company" | "Deal";
type CustomField = {
  id: string;
  label: string;
  entity: Entity;
  type: FieldType;
  required: boolean;
};

const SEED: CustomField[] = [
  { id: "f1", label: "Permit number", entity: "Project", type: "text", required: false },
  { id: "f2", label: "Square footage", entity: "Project", type: "number", required: true },
  { id: "f3", label: "Lead source", entity: "Deal", type: "select", required: false },
  { id: "f4", label: "Preferred contact", entity: "Contact", type: "select", required: false },
];

function CustomFieldsSettings() {
  const [fields, setFields] = useState<CustomField[]>(SEED);
  const [label, setLabel] = useState("");
  const [entity, setEntity] = useState<Entity>("Project");
  const [type, setType] = useState<FieldType>("text");

  function add() {
    if (!label.trim()) return;
    setFields((f) => [
      ...f,
      { id: `f${Date.now()}`, label: label.trim(), entity, type, required: false },
    ]);
    setLabel("");
    toast.success("Custom field added");
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold">Add custom field</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Capture extra data on your records
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_140px_auto]">
          <div>
            <Label className="text-xs">Label</Label>
            <Input
              className="mt-1.5 h-9"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Permit number"
            />
          </div>
          <div>
            <Label className="text-xs">Entity</Label>
            <Select value={entity} onValueChange={(v) => setEntity(v as Entity)}>
              <SelectTrigger className="mt-1.5 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["Project", "Contact", "Company", "Deal"] as Entity[]).map((e) => (
                  <SelectItem key={e} value={e}>{e}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as FieldType)}>
              <SelectTrigger className="mt-1.5 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="select">Dropdown</SelectItem>
                <SelectItem value="checkbox">Checkbox</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button size="sm" className="h-9" onClick={add} disabled={!label.trim()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border p-4">
          <h2 className="text-base font-semibold">Existing fields</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fields.length} custom field{fields.length === 1 ? "" : "s"}
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Label</th>
              <th className="px-4 py-2 text-left font-medium">Entity</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="w-10 px-4"></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id} className="h-11 border-b border-border last:border-b-0">
                <td className="px-4 font-medium">{f.label}</td>
                <td className="px-4">
                  <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
                    {f.entity}
                  </Badge>
                </td>
                <td className="px-4 text-xs capitalize text-muted-foreground">{f.type}</td>
                <td className="px-4 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      setFields((all) => all.filter((x) => x.id !== f.id));
                      toast.success("Field removed");
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
