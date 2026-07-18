// src/components/integrations/integration-config-drawer.tsx
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Link2, Copy, ExternalLink, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useState, useCallback, useEffect } from "react";
import type { Integration } from "@/lib/integrations-data";
import { supabase } from "@/lib/supabase";

interface Props {
  integration: Integration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect?: (integration: Integration) => void;
  onDisconnect?: (integration: Integration) => void;
}

// Map integration id → key inside integration_settings JSON
function settingsKey(id: string): string {
  return id.replace(/-/g, "_"); // e.g. "meta-lead-ads" → "meta_lead_ads"
}

// Map integration card id → product key used as meta_connections.product
// (one row per (org_id, product) now — see
// supabase/migrations/006_meta_connections_per_product.sql)
function metaProductKey(id: string): string | null {
  if (id === "whatsapp") return "whatsapp";
  if (id === "fb-messenger") return "messenger";
  if (id === "instagram-direct") return "instagram";
  if (id === "meta-lead-ads") return "lead_ads";
  if (id === "meta-ads") return "ads";
  return null;
}

const META_IDS = new Set(["whatsapp", "fb-messenger", "instagram-direct", "meta-lead-ads", "meta-ads"]);

interface MetaConnection {
  product: string;
  meta_user_id: string;
  meta_user_name: string | null;
  meta_user_picture_url: string | null;
  business_id: string | null;
  business_name: string | null;
  page_id: string | null;
  page_name: string | null;
  ig_actor_id: string | null;
  ig_username: string | null;
  waba_id: string | null;
  waba_phone_number_id: string | null;
  waba_display_phone: string | null;
  ad_account_id: string | null;
  ad_account_name: string | null;
  is_active: boolean;
  expires_at: string | null;
  updated_at: string;
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  return data?.organization_id ?? null;
}

async function getOrgAndUserId(): Promise<{ orgId: string; userId: string } | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  const orgId = data?.organization_id;
  if (!orgId) return null;
  return { orgId, userId: user.id };
}

// Returns the connection row for ONE specific product, or null if that
// product isn't connected. Each product is now fully independent — there
// is no shared array to check membership against, so this fetches the
// full per-product map and picks out just the one the caller asked for.
async function fetchMetaConnection(productKey: string | null): Promise<MetaConnection | null> {
  if (!productKey) return null;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const res = await fetch("/.netlify/functions/meta-connection-status", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.connections?.[productKey] ?? null;
}

export function IntegrationConfigDrawer({ integration, open, onOpenChange, onConnect, onDisconnect }: Props) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [metaConnection, setMetaConnection] = useState<MetaConnection | null>(null);
  const [metaConnecting, setMetaConnecting] = useState(false);

  const updateField = useCallback((key: string, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setErrors((e) => { const next = { ...e }; delete next[key]; return next; });
  }, []);

  const markTouched = useCallback((key: string) => {
    setTouched((t) => ({ ...t, [key]: true }));
  }, []);

  // Load existing connection status when drawer opens
  useEffect(() => {
    if (!open || !integration) return;
    const currentId = integration.id;
    setFields({});
    setErrors({});
    setTouched({});
    setReconfiguring(false);
    setMetaConnection(null);

    (async () => {
      if (META_IDS.has(currentId)) {
        const productKey = metaProductKey(currentId);
        const conn = await fetchMetaConnection(productKey);
        setMetaConnection(conn);
        setIsConfigured(!!conn);
        return;
      }

      const orgId = await getOrgId();
      if (!orgId) return;
      const { data } = await supabase
        .from("organizations")
        .select("integration_settings")
        .eq("id", orgId)
        .maybeSingle();
      const key = settingsKey(currentId);
      const saved = data?.integration_settings?.[key];
      setIsConfigured(!!saved && typeof saved === "object" && Object.keys(saved).length > 0);
      // Pre-populate non-secret fields (phone number, account SID)
      if (saved) {
        const safe: Record<string, string> = {};
        if (saved.phoneNumber) safe.phoneNumber = saved.phoneNumber;
        if (saved.accountSid) safe.accountSid = saved.accountSid;
        if (saved.apiKey && currentId !== "stripe") safe.apiKey = saved.apiKey;
        setFields(safe);
      }
    })();
  }, [open, integration?.id]);

  // Listen for the OAuth popup's postMessage and refresh connection state
  useEffect(() => {
    if (!integration || !META_IDS.has(integration.id)) return;

    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.source !== "meta-oauth") return;
      setMetaConnecting(false);
      if (e.data.success) {
        toast.success(`${integration!.name} connected`);
        (async () => {
          const productKey = metaProductKey(integration!.id);
          const conn = await fetchMetaConnection(productKey);
          setMetaConnection(conn);
          setIsConfigured(!!conn);
          if (conn) onConnect?.(integration!);
        })();
      } else {
        toast.error(e.data.error || "Connection failed — please try again");
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [integration?.id, onConnect]);

  if (!integration) return null;
  // Captured as non-null so inner functions don't need repeated narrowing
  const int = integration;

  function handleMetaConnect() {
    (async () => {
      const ids = await getOrgAndUserId();
      if (!ids) {
        toast.error("Could not determine your organization");
        return;
      }
      setMetaConnecting(true);
      const url = `/.netlify/functions/meta-oauth-start?orgId=${encodeURIComponent(ids.orgId)}&userId=${encodeURIComponent(ids.userId)}&product=${encodeURIComponent(int.id)}`;
      const popup = window.open(url, "meta-oauth", "width=600,height=720");
      if (!popup) {
        setMetaConnecting(false);
        toast.error("Your browser blocked the popup — please allow popups for this site and try again");
        return;
      }
      // If the user closes the popup manually without completing auth, stop the spinner
      const poll = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(poll);
          setMetaConnecting(false);
        }
      }, 500);
    })();
  }

  async function handleMetaDisconnect() {
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const productKey = metaProductKey(int.id);
      const res = await fetch("/.netlify/functions/meta-disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ product: productKey }),
      });
      if (!res.ok) throw new Error("Disconnect failed");
      setMetaConnection(null);
      setIsConfigured(false);
      onDisconnect?.(int);
      toast.success(`${int.name} disconnected`);
    } catch (err: any) {
      toast.error(`Failed to disconnect: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  function getApiKeyFields(): {
    key: string; label: string; placeholder: string;
    type: string; minLength?: number; pattern?: RegExp; patternMsg?: string; secret?: boolean;
  }[] {
    if (int.id === "gmail") {
      return [
        { key: "email",       label: "Gmail Address", placeholder: "you@gmail.com",         type: "email",    minLength: 5, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: "Enter a valid email address" },
        { key: "appPassword", label: "App Password",  placeholder: "xxxx xxxx xxxx xxxx",   type: "password", secret: true, minLength: 16 },
      ];
    }
    if (int.id === "twilio") {
      return [
        { key: "accountSid",   label: "Account SID",   placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", type: "text",     minLength: 34, pattern: /^AC[a-f0-9]{32}$/i, patternMsg: "Must start with AC followed by 32 hex characters" },
        { key: "authToken",    label: "Auth Token",     placeholder: isConfigured && !reconfiguring ? "Leave blank to keep existing" : "Enter auth token",           type: "password", secret: true },
        { key: "phoneNumber",  label: "Phone Number",   placeholder: "+15551234567",                     type: "text",     minLength: 10, pattern: /^\+\d{10,15}$/, patternMsg: "Must be E.164 format: +1XXXXXXXXXX" },
      ];
    }
    if (int.id === "jotform") {
      return [{ key: "apiKey", label: "API Key", placeholder: "Enter Jotform API key", type: "password", secret: true, minLength: 8 }];
    }
    if (int.id === "stripe") {
      return [{ key: "secretKey", label: "Secret Key", placeholder: "sk_live_…", type: "password", secret: true, minLength: 20 }];
    }
    return [
      { key: "apiKey",    label: "API Key",    placeholder: "Enter API key",    type: "password", secret: true, minLength: 8 },
      { key: "secretKey", label: "Secret Key", placeholder: "Enter secret key", type: "password", secret: true, minLength: 8 },
    ];
  }

  async function validateAndSave() {
    const fieldDefs = getApiKeyFields();
    const newErrors: Record<string, string> = {};
    const allTouched: Record<string, boolean> = {};

    for (const f of fieldDefs) {
      allTouched[f.key] = true;
      const val = (fields[f.key] ?? "").trim();
      // Secret fields can be blank when reconfiguring (means "keep existing")
      const isOptional = f.secret && isConfigured && !reconfiguring && !val;
      if (isOptional) continue;
      if (!val) {
        newErrors[f.key] = `${f.label} is required`;
      } else if (f.minLength && val.length < f.minLength) {
        newErrors[f.key] = `Must be at least ${f.minLength} characters`;
      } else if (f.pattern && !f.pattern.test(val)) {
        newErrors[f.key] = f.patternMsg ?? "Invalid format";
      }
    }

    setTouched(allTouched);
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    setSaving(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Not authenticated");

      // Read current settings so we can merge (not overwrite other integrations)
      const { data: orgRow } = await supabase
        .from("organizations")
        .select("integration_settings")
        .eq("id", orgId)
        .maybeSingle();

      const existing: Record<string, any> = orgRow?.integration_settings ?? {};
      const key = settingsKey(int.id);
      const prev = existing[key] ?? {};

      // Build new settings — omit blank secret fields (keep previous value)
      const next: Record<string, string> = {};
      for (const f of fieldDefs) {
        const val = (fields[f.key] ?? "").trim();
        if (val) {
          next[f.key] = val;
        } else if (f.secret && prev[f.key]) {
          next[f.key] = prev[f.key]; // keep existing secret
        }
      }

      const { error } = await supabase
        .from("organizations")
        .update({ integration_settings: { ...existing, [key]: next } })
        .eq("id", orgId);

      if (error) throw error;

      setIsConfigured(true);
      setReconfiguring(false);
      onConnect?.(int);
      toast.success(`${int.name} credentials saved`);
      // Clear secret fields from state after save
      setFields((f) => {
        const cleaned = { ...f };
        fieldDefs.filter((fd) => fd.secret).forEach((fd) => { cleaned[fd.key] = ""; });
        return cleaned;
      });
    } catch (err: any) {
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setSaving(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Not authenticated");
      const { data: orgRow } = await supabase.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
      const existing: Record<string, any> = { ...(orgRow?.integration_settings ?? {}) };
      delete existing[settingsKey(int.id)];
      const { error } = await supabase.from("organizations").update({ integration_settings: existing }).eq("id", orgId);
      if (error) throw error;
      setIsConfigured(false);
      setFields({});
      onDisconnect?.(int);
      toast.success(`${int.name} disconnected`);
    } catch (err: any) {
      toast.error(`Failed to disconnect: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
              <Link2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <SheetTitle className="text-base">{int.name}</SheetTitle>
              <SheetDescription className="text-xs">{integration.vendor}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-5 px-1">
          <p className="text-sm text-muted-foreground">{integration.description}</p>

          <div className="flex flex-wrap gap-1.5">
            {integration.syncBadges.map((b) => (
              <Badge key={b} variant="secondary" className="text-[10px] h-5 px-1.5 rounded-full">{b}</Badge>
            ))}
          </div>

          {integration.connectMethod === "oauth" && META_IDS.has(int.id) && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              {metaConnection ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-md bg-success/10 px-3 py-2.5">
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={metaConnection.meta_user_picture_url ?? undefined} alt={metaConnection.meta_user_name ?? "Connected account"} />
                      <AvatarFallback>{(metaConnection.meta_user_name ?? "?").slice(0, 1)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-medium leading-tight">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                        {metaConnection.meta_user_name ?? "Connected"}
                      </p>
                      {metaConnection.business_name && (
                        <p className="truncate text-xs text-muted-foreground">{metaConnection.business_name}</p>
                      )}
                    </div>
                  </div>

                  {int.id === "whatsapp" && metaConnection.waba_display_phone && (
                    <p className="text-xs text-muted-foreground">
                      WhatsApp number: <span className="font-medium text-foreground">{metaConnection.waba_display_phone}</span>
                    </p>
                  )}
                  {int.id === "fb-messenger" && metaConnection.page_name && (
                    <p className="text-xs text-muted-foreground">
                      Page: <span className="font-medium text-foreground">{metaConnection.page_name}</span>
                    </p>
                  )}
                  {int.id === "instagram-direct" && metaConnection.ig_username && (
                    <p className="text-xs text-muted-foreground">
                      Instagram: <span className="font-medium text-foreground">@{metaConnection.ig_username}</span>
                    </p>
                  )}
                  {int.id === "meta-lead-ads" && metaConnection.page_name && (
                    <p className="text-xs text-muted-foreground">
                      Page: <span className="font-medium text-foreground">{metaConnection.page_name}</span>
                    </p>
                  )}
                  {int.id === "meta-ads" && metaConnection.ad_account_name && (
                    <p className="text-xs text-muted-foreground">
                      Ad account: <span className="font-medium text-foreground">{metaConnection.ad_account_name}</span>
                    </p>
                  )}
                  {int.id === "meta-ads" ? (
                    <p className="text-xs text-muted-foreground">
                      Ready to use — try "Create Ad Campaign" in AI Center → AI Tools.
                    </p>
                  ) : int.id !== "whatsapp" && (
                    <p className="text-xs text-muted-foreground">Message sync for this product is coming soon — the connection is active and ready.</p>
                  )}

                  <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive" onClick={handleMetaDisconnect} disabled={saving}>
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Disconnect
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Click below to open Facebook Login for Business in a popup and authorize access to your {integration.vendor} {int.id === "whatsapp" ? "WhatsApp Business Account" : int.id === "fb-messenger" ? "Page" : int.id === "instagram-direct" ? "Instagram account" : "ad account"}.
                  </p>
                  <Button className="w-full gap-2" onClick={handleMetaConnect} disabled={metaConnecting}>
                    {metaConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                    {metaConnecting ? "Waiting for Facebook…" : `Connect with ${integration.vendor}`}
                  </Button>
                </>
              )}
            </div>
          )}

          {integration.connectMethod === "oauth" && !META_IDS.has(int.id) && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">
                Click below to securely connect your {integration.vendor} account via OAuth.
              </p>
              <Button className="w-full gap-2" onClick={() => onConnect?.(int)}>
                <ExternalLink className="h-3.5 w-3.5" />
                Connect with {integration.vendor}
              </Button>
            </div>
          )}

          {integration.connectMethod === "apikey" && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              {isConfigured && !reconfiguring ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Credentials configured
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setReconfiguring(true)}>
                    Update credentials
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive" onClick={handleDisconnect} disabled={saving}>
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Disconnect
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Enter your {int.vendor} credentials below.
                    {int.id === "twilio" && (
                      <> Get them at <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" className="underline">console.twilio.com</a>.</>
                    )}
                    {int.id === "gmail" && (
                      <> App Passwords require 2-Step Verification. Create one at{" "}
                      <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="underline">myaccount.google.com/apppasswords</a>.</>
                    )}
                  </p>
                  {getApiKeyFields().map((f) => (
                    <div key={f.key} className="space-y-1.5">
                      <Label className="text-xs">{f.label}</Label>
                      <Input
                        type={f.type}
                        placeholder={f.placeholder}
                        className={`text-xs h-8 ${touched[f.key] && errors[f.key] ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        value={fields[f.key] ?? ""}
                        onChange={(e) => updateField(f.key, e.target.value)}
                        onBlur={() => markTouched(f.key)}
                      />
                      {touched[f.key] && errors[f.key] && (
                        <p className="text-[11px] text-destructive">{errors[f.key]}</p>
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2">
                    {reconfiguring && (
                      <Button variant="outline" className="flex-1" onClick={() => setReconfiguring(false)} disabled={saving}>
                        Cancel
                      </Button>
                    )}
                    <Button className="flex-1" onClick={validateAndSave} disabled={saving}>
                      {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      Save Credentials
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {integration.connectMethod === "link" && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">
                Use the webhook URL below in your {integration.vendor} settings.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">Webhook URL</Label>
                <div className="flex gap-2">
                  <Input readOnly value={`https://api.renometa.com/webhooks/${int.id}`} className="text-xs h-8 font-mono" />
                  <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(`https://api.renometa.com/webhooks/${int.id}`)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <Button className="w-full" onClick={() => onConnect?.(int)}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open Setup Guide
              </Button>
            </div>
          )}

          {integration.automations && integration.automations.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">Available Automations</p>
              <ul className="space-y-1">
                {integration.automations.map((a) => (
                  <li key={a} className="text-xs text-muted-foreground flex items-start gap-1.5">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}