// src/components/portal/InviteToPortalModal.tsx
import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ExternalLink, Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  /** Pre-fill from contact if available */
  clientName?: string;
  clientEmail?: string;
};

export function InviteToPortalModal({ open, onClose, projectId, projectName, clientName = "", clientEmail = "" }: Props) {
  const [name,    setName]    = useState(clientName);
  const [email,   setEmail]   = useState(clientEmail);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [copied,  setCopied]  = useState(false);

  const reset = () => {
    setName(clientName); setEmail(clientEmail);
    setMessage(""); setSending(false); setPortalUrl(null); setCopied(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSend = async () => {
    if (!email.trim()) return;
    setSending(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); setSending(false); return; }

    const res = await fetch("/.netlify/functions/portal-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        email:     email.trim().toLowerCase(),
        name:      name.trim() || undefined,
        projectId,
        message:   message.trim() || undefined,
      }),
    });
    const data = await res.json();
    setSending(false);

    if (data.success) {
      setPortalUrl(data.portalUrl);
      toast.success(`Portal link sent to ${email.trim()}`);
    } else {
      toast.error(data.error ?? "Failed to send portal invite");
    }
  };

  const copyLink = () => {
    if (!portalUrl) return;
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite client to portal</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Send your client a private link to view <strong>{projectName}</strong> — no account needed.
          </p>
        </DialogHeader>

        {!portalUrl ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Client name</Label>
                <Input className="h-9" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Jane Smith" autoComplete="name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email <span className="text-destructive">*</span></Label>
                <Input className="h-9" type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="client@email.com" autoComplete="email" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Personal message <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea value={message} onChange={e => setMessage(e.target.value)}
                placeholder="Hi! Your project is underway. Use this portal to track progress and reach us anytime."
                rows={3} className="resize-none text-sm" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-50 border border-green-100 p-4 text-center space-y-1.5">
              <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <Check className="h-5 w-5 text-green-600" />
              </div>
              <p className="text-sm font-medium text-green-800">Portal link sent!</p>
              <p className="text-xs text-green-600">Email delivered to {email}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Portal link (bookmark or share)</Label>
              <div className="flex gap-2">
                <Input className="h-9 text-xs font-mono" value={portalUrl} readOnly />
                <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={copyLink}>
                  {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                <Button variant="outline" size="sm" className="h-9 shrink-0" asChild>
                  <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleClose}>
            {portalUrl ? "Close" : "Cancel"}
          </Button>
          {!portalUrl && (
            <Button size="sm" onClick={handleSend} disabled={!email.trim() || sending}>
              {sending
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Sending…</>
                : "Send portal link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
