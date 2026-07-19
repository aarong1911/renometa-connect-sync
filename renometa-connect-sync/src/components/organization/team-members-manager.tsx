import { useState, useEffect } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { inviteMember, removeMemberFromOrg } from "@/lib/team";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SelectGroup, SelectLabel,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Plus, Trash2, Info, Loader2, Mail, Phone, Pencil,
  MapPin, Shield, Building2, WifiOff, Eye, EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import {
  ROLE_LABELS, ROLE_GROUPS, OFFLINE_CAPABLE_ROLES, memberInitials,
  type Role, type TeamMember, type WorkerType,
} from "@/lib/organization";

export type TeamMembersManagerProps = {
  members: TeamMember[];
  onAdd: (member: Omit<TeamMember, "id">) => void;
  onUpdate: (id: string, patch: Partial<TeamMember>) => void;
  onRemove: (id: string) => void;
  inviteMode?: boolean;
  title?: string;
  subtitle?: string;
};

function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
function fmtSSN(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}
function fmtEIN(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 2) return d;
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}

type FullProfile = {
  id: string; email: string; first_name: string | null; last_name: string | null;
  phone: string | null; address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
  ssn: string | null; ein: string | null; company_name: string | null;
  worker_type: string | null;
};

// ── Sensitive input ───────────────────────────────────────────────────────────

function SensitiveInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input className="h-9 pr-9" type={show ? "text" : "password"}
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} autoComplete="new-password" />
      <button type="button" onClick={() => setShow(s => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// ── Role selector ─────────────────────────────────────────────────────────────

function RoleSelect({ value, onChange }: { value: Role; onChange: (v: Role) => void }) {
  return (
    <Select value={value} onValueChange={v => onChange(v as Role)}>
      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
      <SelectContent>
        {ROLE_GROUPS.map(g => (
          <SelectGroup key={g.label}>
            <SelectLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</SelectLabel>
            {g.roles.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TeamMember["status"] }) {
  const map = {
    active:  { cls: "bg-success/15 text-success",   label: "Active"  },
    invited: { cls: "bg-warning/15 text-warning",   label: "Invited" },
    roster:  { cls: "bg-blue-500/15 text-blue-500", label: "Roster"  },
  };
  const { cls, label } = map[status] ?? map.active;
  return <Badge variant="secondary" className={`h-5 rounded px-1.5 text-[10px] ${cls}`}>{label}</Badge>;
}

// ── pac-container props for Radix dialogs ─────────────────────────────────────

const PAC_PROPS = {
  onPointerDownOutside: (e: Event) => {
    if ((e.target as Element)?.closest?.(".pac-container")) e.preventDefault();
  },
  onInteractOutside: (e: Event) => {
    if ((e.target as Element)?.closest?.(".pac-container")) e.preventDefault();
  },
};

// ── Address fields ────────────────────────────────────────────────────────────

function AddressBlock({ addr1, addr2, city, stateFld, zip, setAddr1, setAddr2, setCity, setStateFld, setZip }: {
  addr1: string; addr2: string; city: string; stateFld: string; zip: string;
  setAddr1(v: string): void; setAddr2(v: string): void;
  setCity(v: string): void; setStateFld(v: string): void; setZip(v: string): void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2 space-y-1.5">
        <Label className="text-xs">Street</Label>
        <AddressAutocomplete className="h-9" value={addr1} onChange={setAddr1}
          onSelect={p => { setAddr1(p.street); setCity(p.city); setStateFld(p.state); setZip(p.zip); }} />
      </div>
      <div className="col-span-2 space-y-1.5">
        <Label className="text-xs">Apt / Suite</Label>
        <Input className="h-9" value={addr2} onChange={e => setAddr2(e.target.value)} placeholder="Apt 4B" autoComplete="address-line2" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">City</Label>
        <Input className="h-9" value={city} onChange={e => setCity(e.target.value)} placeholder="Miami" autoComplete="address-level2" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">State</Label>
        <Input className="h-9" value={stateFld} onChange={e => setStateFld(e.target.value)} placeholder="FL" autoComplete="address-level1" />
      </div>
      <div className="col-span-2 space-y-1.5">
        <Label className="text-xs">ZIP</Label>
        <Input className="h-9" value={zip} onChange={e => setZip(e.target.value)} placeholder="33101" autoComplete="postal-code" inputMode="numeric" />
      </div>
    </div>
  );
}

// ── Payroll fields ────────────────────────────────────────────────────────────

function PayrollBlock({ isSub, ssn, ein, companyName, setSsn, setEin, setCompanyName }: {
  isSub: boolean; ssn: string; ein: string; companyName: string;
  setSsn(v: string): void; setEin(v: string): void; setCompanyName(v: string): void;
}) {
  return isSub ? (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5 text-xs"><Building2 className="h-3 w-3" /> Company name</Label>
        <Input className="h-9" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme LLC" autoComplete="organization" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">EIN (XX-XXXXXXX)</Label>
        <SensitiveInput value={ein} onChange={v => setEin(fmtEIN(v))} placeholder="12-3456789" />
      </div>
    </div>
  ) : (
    <div className="space-y-1.5">
      <Label className="text-xs">Social Security Number (XXX-XX-XXXX)</Label>
      <SensitiveInput value={ssn} onChange={v => setSsn(fmtSSN(v))} placeholder="123-45-6789" />
      <p className="text-[10px] text-muted-foreground">Stored securely for payroll purposes only.</p>
    </div>
  );
}

// ── Email modal ───────────────────────────────────────────────────────────────

function EmailModal({ to, onClose }: { to: string; onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody]       = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) { toast.error("Subject and message are required"); return; }
    setSending(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); setSending(false); return; }
    const res = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ to, subject: subject.trim(), body: body.trim() }),
    });
    setSending(false);
    if (res.ok) { toast.success(`Email sent to ${to}`); onClose(); }
    else { const d = await res.json(); toast.error(d.error ?? "Failed to send"); }
  };

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Send email to {to}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Subject</Label>
          <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject…" className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Message</Label>
          <Textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Write your message…" rows={6} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={handleSend} disabled={sending}>
          {sending ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Sending…</> : "Send"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ── Member info + edit modal ──────────────────────────────────────────────────

function MemberInfoModal({ member, onUpdate }: {
  member: TeamMember; onUpdate: (id: string, patch: Partial<TeamMember>) => void;
}) {
  const [profile,     setProfile]     = useState<FullProfile | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [editing,     setEditing]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [name,        setName]        = useState(member.name && member.name !== member.email ? member.name : "");
  const [phone,       setPhone]       = useState(member.phone ?? "");
  const [role,        setRole]        = useState<Role>(member.role);
  const [workerType,  setWorkerType]  = useState<WorkerType>(member.workerType);
  const [addr1,       setAddr1]       = useState("");
  const [addr2,       setAddr2]       = useState("");
  const [city,        setCity]        = useState("");
  const [stateFld,    setStateFld]    = useState("");
  const [zip,         setZip]         = useState("");
  const [ssn,         setSsn]         = useState("");
  const [ein,         setEin]         = useState("");
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    const isInv = member.id.startsWith("inv-");
    const srcId = isInv ? member.id.slice(4) : member.id;
    const table = isInv ? "invitations" : "profiles";
    supabase.from(table).select("*").eq("id", srcId).maybeSingle()
      .then(({ data }) => {
        if (data) {
          setProfile(!isInv ? data as FullProfile : null);
          setAddr1(data.address_line1 ?? ""); setAddr2(data.address_line2 ?? "");
          setCity(data.city ?? ""); setStateFld(data.state ?? ""); setZip(data.postal_code ?? "");
          setSsn(data.ssn ?? ""); setEin(data.ein ?? ""); setCompanyName(data.company_name ?? "");
        }
        setLoading(false);
      });
  }, [member.id]);

  const isSub = (profile?.worker_type ?? member.workerType) === "subcontractor";
  const isRosterOrInvited = member.status === "roster" || member.status === "invited";

  const handleSave = async () => {
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); setSaving(false); return; }
    const pts = name.trim().split(" ");

    if (isRosterOrInvited) {
      const invId = member.id.startsWith("inv-") ? member.id.slice(4) : member.id;
      await supabase.from("invitations").update({
        first_name: pts[0] ?? "", last_name: pts.slice(1).join(" ") || null,
        primary_phone: phone || null, role, worker_type: workerType,
        address_line1: addr1 || null, address_line2: addr2 || null,
        city: city || null, state: stateFld || null, postal_code: zip || null,
        ssn: !isSub ? ssn || null : null, ein: isSub ? ein || null : null,
        company_name: isSub ? companyName || null : null,
      }).eq("id", invId);
    } else {
      const res = await fetch("/.netlify/functions/update-user-by-id", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          targetUserId: member.id,
          firstName: pts[0] ?? "", lastName: pts.slice(1).join(" ") ?? "",
          phone: phone || "", role, workerType,
          addressLine1: addr1 || "", addressLine2: addr2 || "",
          city: city || "", state: stateFld || "", postalCode: zip || "",
          ssn: !isSub ? ssn : "", ein: isSub ? ein : "",
          companyName: isSub ? companyName : "",
        }),
      });
      if (!res.ok) { toast.error("Failed to save"); setSaving(false); return; }
    }

    onUpdate(member.id, { name: name.trim() || member.name, phone: phone || undefined, role, workerType });
    toast.success("Member updated");
    setSaving(false);
    setEditing(false);
  };

  const displayName = member.name && member.name !== member.email ? member.name : "—";

  return (
    <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" {...PAC_PROPS}>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-primary-soft text-sm font-semibold text-primary">
              {memberInitials(member.name && member.name !== member.email ? member.name : member.email)}
            </AvatarFallback>
          </Avatar>
          <div>
            <DialogTitle className="text-base">{displayName}</DialogTitle>
            <p className="text-xs text-muted-foreground">{member.email}</p>
          </div>
          <div className="ml-auto"><StatusBadge status={member.status} /></div>
        </div>
      </DialogHeader>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !editing ? (
        <div className="space-y-4 text-sm">
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Contact</p>
            <a href={`mailto:${member.email}`} className="flex items-center gap-2 text-xs hover:text-primary">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />{member.email}
            </a>
            {member.phone && (
              <a href={`tel:${member.phone}`} className="flex items-center gap-2 text-xs hover:text-primary">
                <Phone className="h-3.5 w-3.5 text-muted-foreground" />{member.phone}
              </a>
            )}
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Role</p>
              <p className="mt-0.5 text-xs">{ROLE_LABELS[member.role]}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Type</p>
              <p className="mt-0.5 text-xs">{member.workerType === "subcontractor" ? "Sub-contractor" : "Employee"}</p>
            </div>
          </div>
          {(addr1 || city) && (
            <>
              <Separator />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Address</p>
                <a href={`https://maps.google.com/?q=${encodeURIComponent([addr1, city, stateFld, zip].filter(Boolean).join(", "))}`}
                  target="_blank" rel="noopener noreferrer"
                  className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{[addr1, addr2, city, stateFld, zip].filter(Boolean).join(", ")}</span>
                </a>
              </div>
            </>
          )}
          {(ssn || ein || companyName) && (
            <>
              <Separator />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" /> {isSub ? "Business Info" : "Payroll Info"}
                </p>
                {companyName && <p className="mt-1 flex items-center gap-1.5 text-xs"><Building2 className="h-3.5 w-3.5 text-muted-foreground" />{companyName}</p>}
                {ein && <p className="mt-0.5 text-xs text-muted-foreground">EIN: {ein}</p>}
                {ssn && <p className="mt-0.5 text-xs text-muted-foreground">SSN: ••••••{ssn.replace(/-/g, "").slice(-4)}</p>}
              </div>
            </>
          )}
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setEditing(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />Edit
            </Button>
            <Button size="sm" variant="outline" className="flex-1" asChild>
              <a href={`mailto:${member.email}`}><Mail className="mr-1.5 h-3.5 w-3.5" />Email</a>
            </Button>
            {member.phone && (
              <Button size="sm" variant="outline" className="flex-1" asChild>
                <a href={`tel:${member.phone}`}><Phone className="mr-1.5 h-3.5 w-3.5" />Call</a>
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input className="h-9" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" autoComplete="name" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input className="h-9" value={phone} onChange={e => setPhone(fmtPhone(e.target.value))} placeholder="555-123-4567" inputMode="tel" autoComplete="tel" />
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Role</Label><RoleSelect value={role} onChange={setRole} /></div>
            <div className="space-y-1.5">
              <Label className="text-xs">Employment type</Label>
              <Select value={workerType} onValueChange={v => setWorkerType(v as WorkerType)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="subcontractor">Sub-contractor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Separator />
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <MapPin className="h-3 w-3" /> Address
          </p>
          <AddressBlock addr1={addr1} addr2={addr2} city={city} stateFld={stateFld} zip={zip}
            setAddr1={setAddr1} setAddr2={setAddr2} setCity={setCity} setStateFld={setStateFld} setZip={setZip} />
          <Separator />
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Shield className="h-3 w-3" /> {isSub ? "Business Info" : "Payroll Info"}
          </p>
          <PayrollBlock isSub={isSub} ssn={ssn} ein={ein} companyName={companyName}
            setSsn={setSsn} setEin={setEin} setCompanyName={setCompanyName} />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : "Save changes"}
            </Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}

// ── Main table ────────────────────────────────────────────────────────────────

export function TeamMembersManager({
  members, onAdd, onUpdate, onRemove, inviteMode,
  title = "Team & Roles", subtitle,
}: TeamMembersManagerProps) {
  const [confirmId,   setConfirmId]   = useState<string | null>(null);
  const [emailTarget, setEmailTarget] = useState<string | null>(null);
  const [infoMember,  setInfoMember]  = useState<TeamMember | null>(null);
  const confirmMember = members.find(m => m.id === confirmId);

  const handleConfirmRemove = async () => {
    if (!confirmId) return;
    const m = confirmMember;
    setConfirmId(null);
    onRemove(confirmId);
    const result = await removeMemberFromOrg(
      m?.status === "invited" || m?.status === "roster"
        ? { invitationId: confirmId }
        : { memberId: confirmId }
    );
    if (!result.success) toast.error(result.error);
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subtitle ?? `${members.length} member${members.length === 1 ? "" : "s"} in this workspace`}
          </p>
        </div>
        <MemberDialog mode="add" inviteDefault={!!inviteMode} onSave={onAdd}
          trigger={<Button size="sm" className="h-8"><Plus className="mr-1.5 h-3.5 w-3.5" />{inviteMode ? "Invite member" : "Add member"}</Button>} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Member</th>
              <th className="px-4 py-2 text-left font-medium">Email</th>
              <th className="px-4 py-2 text-left font-medium">Phone</th>
              <th className="px-4 py-2 text-left font-medium">Role</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="w-24 px-4" />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-border last:border-b-0 hover:bg-secondary/20">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarFallback className="bg-primary-soft text-[10px] font-medium text-primary">
                        {memberInitials(m.name && m.name !== m.email ? m.name : m.email)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="font-medium">{m.name && m.name !== m.email ? m.name : "—"}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => setEmailTarget(m.email)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
                    <Mail className="h-3 w-3 shrink-0" />
                    <span className="max-w-[160px] truncate">{m.email}</span>
                  </button>
                </td>
                <td className="px-4 py-3">
                  {m.phone
                    ? <a href={`tel:${m.phone}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
                        <Phone className="h-3 w-3 shrink-0" />{m.phone}
                      </a>
                    : <span className="text-xs text-muted-foreground/40">—</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">{ROLE_LABELS[m.role]}</Badge>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {m.workerType === "subcontractor" ? "Sub-contractor" : "Employee"}
                </td>
                <td className="px-4 py-3"><StatusBadge status={m.status} /></td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setInfoMember(m)}>
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmId(m.id)} disabled={m.role === "owner"}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No team members yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!infoMember} onOpenChange={o => !o && setInfoMember(null)}>
        {infoMember && <MemberInfoModal member={infoMember} onUpdate={onUpdate} />}
      </Dialog>
      <Dialog open={!!emailTarget} onOpenChange={o => !o && setEmailTarget(null)}>
        {emailTarget && <EmailModal to={emailTarget} onClose={() => setEmailTarget(null)} />}
      </Dialog>
      <AlertDialog open={!!confirmId} onOpenChange={o => !o && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove team member?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmMember
                ? `This will remove ${confirmMember.name && confirmMember.name !== confirmMember.email ? confirmMember.name : confirmMember.email} from the workspace. This cannot be undone.`
                : "This will remove the member. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleConfirmRemove}>
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Add / Invite dialog ───────────────────────────────────────────────────────

function MemberDialog({ mode, initial, inviteDefault, onSave, trigger }: {
  mode: "add" | "edit"; initial?: TeamMember; inviteDefault?: boolean;
  onSave: (m: Omit<TeamMember, "id">) => void; trigger: React.ReactNode;
}) {
  const [open,       setOpen]       = useState(false);
  const [name,       setName]       = useState("");
  const [email,      setEmail]      = useState("");
  const [phone,      setPhone]      = useState("");
  const [role,       setRole]       = useState<Role>("field_worker");
  const [workerType, setWorkerType] = useState<WorkerType>("employee");
  const [sendNow,    setSendNow]    = useState(true);
  const [isOffline,  setIsOffline]  = useState(false);
  const [rosterOnly, setRosterOnly] = useState(false);
  const [sending,    setSending]    = useState(false);
  const [addr1,       setAddr1]       = useState("");
  const [addr2,       setAddr2]       = useState("");
  const [city,        setCity]        = useState("");
  const [stateFld,    setStateFld]    = useState("");
  const [zip,         setZip]         = useState("");
  const [ssn,         setSsn]         = useState("");
  const [ein,         setEin]         = useState("");
  const [companyName, setCompanyName] = useState("");

  const showOfflineToggle = OFFLINE_CAPABLE_ROLES.includes(role);
  const showRosterToggle  = role === "field_worker";
  const isSub = workerType === "subcontractor";

  // Reset all state when dialog opens
  useEffect(() => {
    if (!open) return;
    setName(initial?.name && initial.name !== initial.email ? initial.name : "");
    setEmail(initial?.email ?? "");
    setPhone(initial?.phone ?? "");
    setRole(initial?.role ?? "field_worker");
    setWorkerType(initial?.workerType ?? "employee");
    setSendNow(true); setIsOffline(false); setRosterOnly(false); setSending(false);
    setAddr1(""); setAddr2(""); setCity(""); setStateFld(""); setZip("");
    setSsn(""); setEin(""); setCompanyName("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    if (!email.trim()) return;
    const shouldInvite = mode === "add" && (inviteDefault || sendNow) && !rosterOnly;
    const status: TeamMember["status"] = rosterOnly ? "roster" : shouldInvite ? "invited" : initial?.status ?? "active";

    onSave({
      name: name.trim(), email: email.trim().toLowerCase(),
      phone: phone.trim() || undefined, role, workerType, status,
      invitedAt: status !== "active" ? new Date().toISOString() : initial?.invitedAt,
    });
    setOpen(false);

    if (shouldInvite || rosterOnly) {
      setSending(true);
      const result = await inviteMember({
        email: email.trim().toLowerCase(), role,
        name:        name.trim()     || undefined,
        phone:       phone.trim()    || undefined,
        workerType,  isOffline,       rosterOnly,
        addressLine1: addr1.trim()   || undefined,
        addressLine2: addr2.trim()   || undefined,
        city:         city.trim()    || undefined,
        state:        stateFld.trim()|| undefined,
        postalCode:   zip.trim()     || undefined,
        ssn:          !isSub ? (ssn.trim() || undefined) : undefined,
        ein:          isSub  ? (ein.trim() || undefined) : undefined,
        companyName:  isSub  ? (companyName.trim() || undefined) : undefined,
      });
      setSending(false);
      if (result.success) toast.success(rosterOnly ? `${name || email} added to roster` : `Invitation sent to ${email.trim()}`);
      else toast.error(`Failed: ${result.error}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" {...PAC_PROPS}>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? (inviteDefault ? "Invite member" : "Add member") : "Edit member"}</DialogTitle>
        </DialogHeader>

        <form autoComplete="on" onSubmit={e => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          {/* Basic info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input className="h-9" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" autoComplete="name" name="name" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input className="h-9" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="email" name="email" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input className="h-9" value={phone} onChange={e => setPhone(fmtPhone(e.target.value))} placeholder="555-123-4567" inputMode="tel" autoComplete="tel" name="tel" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <RoleSelect value={role} onChange={r => { setRole(r); setIsOffline(false); setRosterOnly(false); setSendNow(true); }} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Employment type</Label>
              <Select value={workerType} onValueChange={v => setWorkerType(v as WorkerType)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="subcontractor">Sub-contractor (1099)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Address */}
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <MapPin className="h-3 w-3" /> Address
            </p>
            <AddressBlock addr1={addr1} addr2={addr2} city={city} stateFld={stateFld} zip={zip}
              setAddr1={setAddr1} setAddr2={setAddr2} setCity={setCity} setStateFld={setStateFld} setZip={setZip} />
          </div>

          {/* Payroll */}
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Shield className="h-3 w-3" /> {isSub ? "Business Info" : "Payroll Info"}
            </p>
            <PayrollBlock isSub={isSub} ssn={ssn} ein={ein} companyName={companyName}
              setSsn={setSsn} setEin={setEin} setCompanyName={setCompanyName} />
          </div>

          {/* Invite options */}
          {mode === "add" && (
            <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-3">
              {showRosterToggle && (
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-medium"><WifiOff className="h-3.5 w-3.5" /> Roster Only</p>
                    <p className="text-[11px] text-muted-foreground">Add to team list without sending an invite or creating an account.</p>
                  </div>
                  <Switch checked={rosterOnly} onCheckedChange={v => { setRosterOnly(v); if (v) { setIsOffline(false); setSendNow(false); } else setSendNow(true); }} />
                </div>
              )}
              {showOfflineToggle && !rosterOnly && (
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium">{role === "viewer" ? "Send portal link" : "Send field app link"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {role === "viewer" ? "Opens the client portal — no account needed." : "Opens the field crew app — no password needed."}
                    </p>
                  </div>
                  <Switch checked={isOffline} onCheckedChange={setIsOffline} />
                </div>
              )}
              {!showOfflineToggle && !inviteDefault && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium">Send invitation email now</p>
                  <Switch checked={sendNow} onCheckedChange={setSendNow} />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!email.trim() || sending}>
              {sending ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : mode === "add" ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
