// src/components/financials/NewVendorModal.tsx — Phase 13.8D.
//
// `vendors` is a CRM-relational table (company_id/contact_id FKs into the
// existing companies/contacts tables), NOT a flat name/email/phone record —
// see src/lib/vendors.ts's header comment. This modal therefore links a
// vendor profile to an existing Company (required) and, optionally, one of
// that company's Contacts, rather than collecting duplicate identity fields
// vendors.* doesn't have. Reuses the existing companies-store/contacts-store
// reactive stores (same ones Settings/CRM pages already use) instead of a
// parallel company-picker implementation.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCompanies, fetchCompanies } from "@/lib/companies-store";
import { useContacts, refreshContacts } from "@/lib/contacts-store";
import { createVendor } from "@/lib/vendors";

const VENDOR_TYPES = [
  { value: "subcontractor", label: "Subcontractor" },
  { value: "supplier", label: "Supplier" },
  { value: "material_supplier", label: "Material Supplier" },
  { value: "service_provider", label: "Service Provider" },
  { value: "other", label: "Other" },
];

type Props = { open: boolean; onClose: () => void; orgId: string | null; onCreated: (id: string) => void };

export function NewVendorModal({ open, onClose, orgId, onCreated }: Props) {
  const companies = useCompanies();
  const contacts = useContacts();
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("none");
  const [vendorType, setVendorType] = useState("subcontractor");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [insuranceExpiry, setInsuranceExpiry] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetchCompanies();
    void refreshContacts();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCompanyId(""); setContactId("none"); setVendorType("subcontractor");
    setLicenseNumber(""); setInsuranceExpiry(""); setNotes("");
  }, [open]);

  // Contacts belonging to the selected company surface first — a vendor is
  // usually reached through a specific point of contact at that company —
  // but any contact remains selectable in case the right person isn't
  // linked to the company record yet.
  const companyContacts = contacts.filter((c) => c.company_id === companyId);
  const otherContacts = contacts.filter((c) => c.company_id !== companyId);

  const handleSubmit = async () => {
    if (saving) return;
    if (!orgId) { toast.error("Could not determine your organization."); return; }
    if (!companyId) { toast.error("Select a company for this vendor"); return; }
    setSaving(true);
    try {
      const { id } = await createVendor(orgId, {
        companyId,
        contactId: contactId === "none" ? undefined : contactId,
        vendorType,
        licenseNumber,
        insuranceExpiry: insuranceExpiry || undefined,
        notes,
      });
      const companyName = companies.find((c) => c.id === companyId)?.name ?? "Vendor";
      toast.success(`${companyName} added as a vendor`);
      onCreated(id);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create this vendor");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="text-base font-semibold">New Vendor</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Company</Label>
            <Select value={companyId} onValueChange={(v) => { setCompanyId(v); setContactId("none"); }}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select an existing company" /></SelectTrigger>
              <SelectContent>
                {companies.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No companies yet — add one in Contacts first.</div>}
                {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Point of contact (optional)</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No contact</SelectItem>
                {companyContacts.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                {companyContacts.length > 0 && otherContacts.length > 0 && <div className="my-1 border-t border-border" />}
                {otherContacts.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Vendor type</Label>
            <Select value={vendorType} onValueChange={setVendorType}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{VENDOR_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">License # (optional)</Label>
              <Input className="h-9" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Insurance expiry (optional)</Label>
              <Input className="h-9" type="date" value={insuranceExpiry} onChange={(e) => setInsuranceExpiry(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : "Add vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
