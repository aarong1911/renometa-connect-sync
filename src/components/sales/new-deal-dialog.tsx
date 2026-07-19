// src/components/sales/new-deal-dialog.tsx
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { addDeal as storeAddDeal, usePipelineStages, type AddDealInput } from "@/lib/deals-store";
import { formatPhone } from "@/lib/format";
import { useTeam } from "@/lib/organization";

const BLANK_DEAL = { name: "", contactName: "", value: "", ownerId: "", stage: "", address: "", phone: "", email: "" };

/**
 * Shared "Add Deal" dialog — used by the Pipeline page and reused from
 * Command Center Quick Actions so both trigger the real addDeal() mutation.
 */
export function NewDealDialog({
  open,
  onOpenChange,
  initialValues,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues?: Partial<typeof BLANK_DEAL>;
  onCreated?: () => void;
}) {
  const teamMembers = useTeam();
  const dbStages = usePipelineStages();
  const stages = dbStages.filter((s) => s.id !== "won" && s.id !== "lost");

  const [newDeal, setNewDeal] = useState({ ...BLANK_DEAL, ...initialValues });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open && initialValues) setNewDeal((d) => ({ ...d, ...initialValues }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleCreate() {
    const ownerMember = teamMembers.find((m) => m.id === newDeal.ownerId)
      ?? teamMembers.find((m) => m.status === "active");
    const input: AddDealInput = {
      name: newDeal.name.trim(),
      contactName: newDeal.contactName.trim(),
      email: newDeal.email.trim(),
      phone: newDeal.phone.trim(),
      address: newDeal.address.trim(),
      value: Number(newDeal.value) || 0,
      stage: newDeal.stage || stages[0]?.id || "new",
      ownerId: ownerMember?.id ?? "",
      ownerName: ownerMember?.name ?? "Unassigned",
    };
    setCreating(true);
    try {
      await storeAddDeal(input);
      setNewDeal(BLANK_DEAL);
      onOpenChange(false);
      onCreated?.();
      toast.success(`Deal "${input.name}" created`);
    } catch {
      toast.error("Failed to create deal. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onInteractOutside={(e) => {
        const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
        if (target?.closest?.(".pac-container")) e.preventDefault();
      }}>
        <DialogHeader>
          <DialogTitle>Add Deal</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Deal name</Label>
            <Input value={newDeal.name} onChange={(e) => setNewDeal((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Kitchen remodel" />
          </div>
          <div className="space-y-1.5">
            <Label>Contact name</Label>
            <Input value={newDeal.contactName} onChange={(e) => setNewDeal((d) => ({ ...d, contactName: e.target.value }))} placeholder="e.g. John Smith" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={newDeal.email} onChange={(e) => setNewDeal((d) => ({ ...d, email: e.target.value }))} placeholder="john@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input type="tel" value={newDeal.phone} onChange={(e) => setNewDeal((d) => ({ ...d, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Address</Label>
            <AddressAutocomplete
              value={newDeal.address}
              onChange={(v) => setNewDeal((d) => ({ ...d, address: v }))}
              onSelect={(parts) =>
                setNewDeal((d) => ({
                  ...d,
                  address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                }))
              }
              placeholder="123 Main St, City, ST"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Value ($)</Label>
            <Input type="number" value={newDeal.value} onChange={(e) => setNewDeal((d) => ({ ...d, value: e.target.value }))} placeholder="25000" />
          </div>
          <div className="space-y-1.5">
            <Label>Starting stage</Label>
            <Select value={newDeal.stage} onValueChange={(v) => setNewDeal((d) => ({ ...d, stage: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="First stage (default)" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Owner</Label>
            <Select value={newDeal.ownerId} onValueChange={(v) => setNewDeal((d) => ({ ...d, ownerId: v }))}>
              <SelectTrigger>
                <SelectValue placeholder="Select team member" />
              </SelectTrigger>
              <SelectContent>
                {teamMembers.filter((m) => m.status === "active").map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>Cancel</Button>
          <Button disabled={!newDeal.name.trim() || creating} onClick={handleCreate}>
            {creating ? "Creating…" : "Create Deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}