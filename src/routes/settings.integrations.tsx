// src/routes/settings.integrations.tsx
import { useState, useMemo, useCallback, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Search, Plug, CheckCircle2, Circle, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import { INTEGRATIONS, CATEGORIES, type Integration, type CategoryId } from "@/lib/integrations-data";
import { MOCK_MODE } from "@/lib/mock-mode";
import { IntegrationConfigDrawer } from "@/components/integrations/integration-config-drawer";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/org-id";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettings,
});

function IntegrationsSettings() {
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<Integration | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>(INTEGRATIONS);
  const [disconnectTarget, setDisconnectTarget] = useState<Integration | null>(null);

  // ── Google Calendar — read-only status (Phase 10.3) ─────────────────────
  // No OAuth connect/callback flow exists in this repo for Google Calendar
  // (see the Phase 10.3 audit) — the two live-connected `integrations`
  // rows (provider='gcal') that netlify/functions/vapi-webhook.ts already
  // reads from were established outside this app's UI. Rather than
  // fabricate a Connect button that can't actually complete an OAuth
  // handshake, this card shows the REAL status (safe columns only — never
  // the encrypted token columns) and defers Connect/Reconnect honestly.
  type GcalStatus = {
    connected: boolean;
    accountEmail: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    syncError: string | null;
  };
  const [gcalStatus, setGcalStatus] = useState<GcalStatus | null>(null);

  // ── Gmail "SEND EMAIL" state (SMTP App Password) ───────────────────────
  // Real — organizations.integration_settings.gmail is read directly by
  // send-inbox-message.ts's email branch to actually send mail. This is
  // completely separate from the OAuth "SYNC INBOX" connection below;
  // disconnecting/reconnecting one must never affect the other.
  const [gmailSmtpEmail, setGmailSmtpEmail] = useState<string | null>(null);
  const [gmailSmtpDisconnecting, setGmailSmtpDisconnecting] = useState(false);
  const [gmailSmtpDisconnectConfirmOpen, setGmailSmtpDisconnectConfirmOpen] = useState(false);
  const gmailSmtpConfigured = !!gmailSmtpEmail;

  const handleDisconnectGmailSmtp = useCallback(async () => {
    setGmailSmtpDisconnecting(true);
    try {
      // Routed through the secure endpoint — it deletes the encrypted App
      // Password secret and clears the non-secret gmail metadata, without
      // touching the separate Gmail OAuth inbox-sync connection.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in to disconnect Gmail sending"); return; }
      const res = await fetch("/.netlify/functions/smtp-disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Disconnect failed");
      }
      setGmailSmtpEmail(null);
      updateConnectionStatus("gmail", false);
      toast.success("Gmail sending credentials disconnected");
      setGmailSmtpDisconnectConfirmOpen(false);
    } catch (err: any) {
      toast.error(`Failed to disconnect: ${err.message}`);
    } finally {
      setGmailSmtpDisconnecting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Gmail "SYNC INBOX" state (OAuth) ────────────────────────────────────
  // Independent of the `connected` flag on the Integration objects above
  // (which reflects the older organizations.integration_settings mock/
  // apikey concept) — this reads the real OAuth `integrations` table via
  // gmail-connection-status.ts, and drives Connect/Reconnect/Sync/
  // Disconnect for the Gmail card specifically.
  type GmailStatus = {
    connected: boolean;
    accountEmail: string | null;
    hasRefreshToken: boolean;
    tokenExpiresAt: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    syncError: string | null;
  };
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [gmailStatusLoading, setGmailStatusLoading] = useState(true);
  const [gmailStatusError, setGmailStatusError] = useState<string | null>(null);
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailDisconnecting, setGmailDisconnecting] = useState(false);
  const [gmailDisconnectConfirmOpen, setGmailDisconnectConfirmOpen] = useState(false);

  const gmailNeedsReconnect =
    !!gmailStatus?.connected &&
    (!gmailStatus.hasRefreshToken ||
      (!!gmailStatus.tokenExpiresAt && new Date(gmailStatus.tokenExpiresAt).getTime() < Date.now()));

  const fetchGmailStatus = useCallback(async () => {
    setGmailStatusLoading(true);
    setGmailStatusError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setGmailStatusLoading(false); return; }
      const res = await fetch("/.netlify/functions/gmail-connection-status", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setGmailStatusError(err.error ?? "Failed to load Gmail status");
        return;
      }
      setGmailStatus(await res.json());
    } catch {
      setGmailStatusError("Network error loading Gmail status");
    } finally {
      setGmailStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (MOCK_MODE) { setGmailStatusLoading(false); return; }
    fetchGmailStatus();
  }, [fetchGmailStatus]);

  // gmail-oauth-callback.ts redirects back here with ?gmail=success|error
  // (+ ?gmail_message=...) after the OAuth round trip — surface that once,
  // refresh real status, then strip the params so a refresh doesn't re-show it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gmail");
    if (!result) return;
    const message = params.get("gmail_message");
    if (result === "success") {
      toast.success("Gmail connected");
      fetchGmailStatus();
    } else if (result === "error") {
      toast.error(message || "Gmail connection failed");
    }
    params.delete("gmail");
    params.delete("gmail_message");
    const next = params.toString();
    window.history.replaceState({}, "", next ? `${window.location.pathname}?${next}` : window.location.pathname);
  }, [fetchGmailStatus]);

  const handleConnectGmail = useCallback(async () => {
    setGmailConnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in to connect Gmail"); return; }
      const res = await fetch("/.netlify/functions/gmail-oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({}),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.url) {
        toast.error(result.error ?? "Could not start Gmail connection");
        setGmailConnecting(false);
        return;
      }
      window.location.href = result.url;
    } catch {
      toast.error("Network error — could not start Gmail connection");
      setGmailConnecting(false);
    }
  }, []);

  const handleDisconnectGmail = useCallback(async () => {
    setGmailDisconnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in to disconnect Gmail"); return; }
      const res = await fetch("/.netlify/functions/gmail-disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({}),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(result.error ?? "Could not disconnect Gmail");
        return;
      }
      toast.success("Gmail disconnected");
      setGmailDisconnectConfirmOpen(false);
      await fetchGmailStatus();
    } catch {
      toast.error("Network error — could not disconnect Gmail");
    } finally {
      setGmailDisconnecting(false);
    }
  }, [fetchGmailStatus]);

  const handleSyncGmail = useCallback(async () => {
    setGmailSyncing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in to sync Gmail"); return; }
      const res = await fetch("/.netlify/functions/gmail-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({}),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(result.error ?? "Gmail sync failed");
        return;
      }
      toast.success(
        `Gmail synced: ${result.fetched} fetched, ${result.inserted} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""}`,
      );
      fetchGmailStatus();
    } catch {
      toast.error("Network error — Gmail sync did not complete");
    } finally {
      setGmailSyncing(false);
    }
  }, [fetchGmailStatus]);

  function fmtGmailTimestamp(iso: string | null): string {
    if (!iso) return "Never";
    try {
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  // Load real connection status from org's integration_settings + meta_connections
  useEffect(() => {
    if (MOCK_MODE) {
      // A believable mix of connected/not-connected for screenshots — the
      // most commonly-connected ones (SMS/voice/calendar/email) marked on.
      const MOCK_CONNECTED_IDS = new Set([
        "twilio", "google-calendar", "gmail", "meta-lead-ads", "whatsapp",
        "docusign", "quickbooks",
      ]);
      setIntegrations((prev) =>
        prev.map((i) => ({ ...i, connected: MOCK_CONNECTED_IDS.has(i.id) || i.connected }))
      );
      setGmailSmtpEmail("demo@renometa.com");
      return;
    }
    (async () => {
      const orgId = await getOrgId();
      if (!orgId) return;

      const { data: org } = await supabase.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
      const settings: Record<string, any> = org?.integration_settings ?? {};
      // Gmail SMTP send credentials (real — read directly by
      // send-inbox-message.ts's email branch, distinct from the OAuth
      // inbox-sync connection tracked by gmailStatus below).
      setGmailSmtpEmail(settings.gmail?.email ?? null);

      const { data: { session } } = await supabase.auth.getSession();
      let connectedProducts: string[] = [];
      if (session) {
        try {
          const res = await fetch("/.netlify/functions/meta-connection-status", {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (res.ok) {
            const json = await res.json();
            // Per-product schema (see
            // supabase/migrations/006_meta_connections_per_product.sql) —
            // meta-connection-status.ts now returns `connections` keyed by
            // product (e.g. { whatsapp: {...}, ads: {...} }), one entry
            // per product that's actually connected. A product's presence
            // as a key means it's connected; there's no shared array to
            // check membership against anymore.
            connectedProducts = Object.keys(json.connections ?? {});
          }
        } catch {
          // Meta connection status is best-effort here — card will just show "Not connected"
        }
      }

      if (!MOCK_MODE) {
        const { data: gcalRow } = await supabase
          .from("integrations")
          .select("status, provider_account_email, last_sync_at, last_sync_status, sync_error")
          .eq("org_id", orgId)
          .eq("provider", "gcal")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        setGcalStatus({
          connected: gcalRow?.status === "connected",
          accountEmail: gcalRow?.provider_account_email ?? null,
          lastSyncAt: gcalRow?.last_sync_at ?? null,
          lastSyncStatus: gcalRow?.last_sync_status ?? null,
          syncError: gcalRow?.sync_error ?? null,
        });
        updateConnectionStatus("google-calendar", gcalRow?.status === "connected");
      }

      const metaProductMap: Record<string, string> = {
        whatsapp: "whatsapp",
        "fb-messenger": "messenger",
        "instagram-direct": "instagram",
        "meta-lead-ads": "lead_ads",
        "meta-ads": "ads",
      };

      setIntegrations((prev) =>
        prev.map((i) => {
          // google-calendar's real connected status was already set above
          // via updateConnectionStatus() from the `integrations` table
          // directly — must not be overwritten by the generic
          // integration_settings-object heuristic below (there is no
          // `integration_settings.google_calendar` key to read).
          if (i.id === "google-calendar") return i;
          if (metaProductMap[i.id]) {
            return { ...i, connected: connectedProducts.includes(metaProductMap[i.id]) };
          }
          const key = i.id.replace(/-/g, "_");
          const saved = settings[key];
          return { ...i, connected: !!saved && typeof saved === "object" && Object.keys(saved).length > 0 };
        })
      );
    })();
  }, []);

  // Category-grouped layout (Lovable design) replaces the old single flat
  // grid + category-pill filter — every real category from
  // lib/integrations-data.ts gets its own titled section, and search
  // narrows within each section rather than switching between them.
  const bySearch = useMemo(() => {
    if (!search) return integrations;
    const q = search.toLowerCase();
    return integrations.filter((i) => i.name.toLowerCase().includes(q) || i.vendor.toLowerCase().includes(q));
  }, [search, integrations]);

  const sections = useMemo(() => {
    return CATEGORIES.filter((c) => c.id !== "all")
      .map((c) => ({
        id: c.id as CategoryId,
        label: c.label,
        items: bySearch.filter((i) => i.category === c.id),
      }))
      .filter((s) => s.items.length > 0);
  }, [bySearch]);

  const total = integrations.length;
  const connectedCount = integrations.filter((i) => i.connected).length;
  const availableCount = total - connectedCount;

  const updateConnectionStatus = useCallback((id: string, connected: boolean) => {
    setIntegrations((prev) =>
      prev.map((i) => (i.id === id ? { ...i, connected } : i))
    );
  }, []);

  const handleConnect = useCallback((integration: Integration) => {
    updateConnectionStatus(integration.id, true);
    toast.success(`${integration.name} connected successfully`);
    setDrawerOpen(false);
  }, [updateConnectionStatus]);

  const handleDisconnect = useCallback(() => {
    if (!disconnectTarget) return;
    updateConnectionStatus(disconnectTarget.id, false);
    toast.success(`${disconnectTarget.name} disconnected`);
    setDisconnectTarget(null);
  }, [disconnectTarget, updateConnectionStatus]);

  const openDrawer = (i: Integration) => {
    setSelected(i);
    setDrawerOpen(true);
  };

  const actionLabel = (i: Integration) => {
    if (i.connected) return null;
    if (i.connectMethod === "oauth") return "Connect";
    if (i.connectMethod === "apikey") return "Configure";
    return "Get Started";
  };

  return (
    <div className="space-y-6">
      {/* Stats — Lovable MetricCard style */}
      <div className="grid grid-cols-3 gap-3">
        <MetricTile icon={Plug} iconBg="bg-info-soft" iconColor="text-info" label="Total Integrations" value={String(total)} />
        <MetricTile icon={CheckCircle2} iconBg="bg-success-soft" iconColor="text-success" label="Connected" value={String(connectedCount)} />
        <MetricTile icon={Circle} iconBg="bg-secondary" iconColor="text-foreground" label="Available" value={String(availableCount)} />
      </div>

      {/* Search only — category pills replaced by always-visible grouped sections below */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search integrations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 pl-9 text-sm"
        />
      </div>

      {/* Category sections — Lovable SectionCard style */}
      {sections.map((section) => (
        <Card key={section.id}>
          <div className="flex h-12 items-center gap-2 border-b border-border px-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-soft text-violet">
              <Plug className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-semibold text-foreground">{section.label}</span>
          </div>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {section.items.map((i) => (
                <div
                  key={i.id}
                  className="flex flex-col rounded-lg border border-border/70 bg-card p-3.5 transition-shadow hover:shadow-(--shadow-elev-2)"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-black/5">
                      <Link2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-[13px] font-semibold text-foreground">{i.name}</span>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{i.vendor}</p>
                    </div>
                  </div>

                  <p className="mt-2.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{i.description}</p>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {i.syncBadges.map((b) => (
                      <span key={b} className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                        {b}
                      </span>
                    ))}
                  </div>

                  {i.connected && i.id !== "gmail" && i.automations && i.automations.length > 0 && (
                    <div className="mt-3 rounded-md border border-border bg-muted/50 p-2.5">
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Automations</p>
                      <ul className="space-y-0.5">
                        {i.automations.map((a) => (
                          <li key={a} className="flex items-start gap-1.5 text-[11px] text-foreground">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                            {a}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Gmail has TWO independent capabilities that must never
                      be conflated: sending mail (SMTP App Password, read
                      directly by send-inbox-message.ts) and inbox sync
                      (real OAuth connection via gmail-connection-status.ts).
                      A reconnect-needed OAuth state must never read as
                      "email sending is broken" — each gets its own status
                      badge and actions. */}
                  {i.id === "gmail" && !MOCK_MODE ? (
                    <div className="mt-3 space-y-2">
                      {/* SEND EMAIL */}
                      <div className="rounded-md border border-border bg-muted/50 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Send Email (SMTP)</p>
                          <span className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1",
                            gmailSmtpConfigured ? "bg-success-soft text-success ring-success/20" : "bg-secondary text-muted-foreground ring-border",
                          )}>
                            {gmailSmtpConfigured ? <CheckCircle2 className="h-2.5 w-2.5" /> : <Circle className="h-2 w-2" />}
                            {gmailSmtpConfigured ? "Configured" : "Not configured"}
                          </span>
                        </div>
                        {gmailSmtpConfigured && <p className="mb-1.5 truncate text-[11px] text-foreground">{gmailSmtpEmail}</p>}
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => openDrawer(i)}>
                            {gmailSmtpConfigured ? "Update credentials" : "Add credentials"}
                          </Button>
                          {gmailSmtpConfigured && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px] text-muted-foreground"
                              onClick={() => setGmailSmtpDisconnectConfirmOpen(true)}
                            >
                              Disconnect
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* SYNC INBOX */}
                      <div className="rounded-md border border-border bg-muted/50 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sync Inbox (OAuth)</p>
                          <span className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1",
                            gmailStatus?.connected
                              ? gmailNeedsReconnect
                                ? "bg-warning-soft text-warning ring-warning/20"
                                : "bg-success-soft text-success ring-success/20"
                              : "bg-secondary text-muted-foreground ring-border",
                          )}>
                            {gmailStatus?.connected
                              ? gmailNeedsReconnect
                                ? <AlertTriangle className="h-2.5 w-2.5" />
                                : <CheckCircle2 className="h-2.5 w-2.5" />
                              : <Circle className="h-2 w-2" />}
                            {gmailStatus?.connected ? (gmailNeedsReconnect ? "Needs reconnect" : "Connected") : "Not connected"}
                          </span>
                        </div>
                        {gmailStatusLoading ? (
                          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
                        ) : gmailStatusError ? (
                          <p className="mb-1.5 text-[11px] text-destructive">{gmailStatusError}</p>
                        ) : gmailStatus?.connected ? (
                          <div className="mb-1.5 space-y-0.5 text-[11px] text-foreground">
                            <p><span className="font-semibold">Account:</span> {gmailStatus.accountEmail ?? "Unknown"}</p>
                            <p>
                              <span className="font-semibold">Last sync:</span> {fmtGmailTimestamp(gmailStatus.lastSyncAt)}
                              {gmailStatus.lastSyncStatus ? ` · ${gmailStatus.lastSyncStatus}` : ""}
                            </p>
                            {gmailStatus.syncError && <p className="text-destructive">{gmailStatus.syncError}</p>}
                            {gmailNeedsReconnect && (
                              <p className="flex items-center gap-1 text-warning">
                                <AlertTriangle className="h-3 w-3" /> Reconnect to keep syncing
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="mb-1.5 text-[11px] text-muted-foreground">Not connected yet.</p>
                        )}
                        <div className="flex gap-2">
                          {gmailStatus?.connected && !gmailNeedsReconnect && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={gmailSyncing}
                              onClick={handleSyncGmail}
                              title="Manually pull recent Gmail messages into Conversations"
                            >
                              {gmailSyncing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                              {gmailSyncing ? "Syncing…" : "Sync Gmail"}
                            </Button>
                          )}
                          {(!gmailStatus?.connected || gmailNeedsReconnect) && (
                            <Button
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={gmailConnecting}
                              onClick={handleConnectGmail}
                            >
                              {gmailConnecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                              {gmailConnecting ? "Connecting…" : gmailStatus?.connected ? "Reconnect Gmail" : "Connect Gmail"}
                            </Button>
                          )}
                          {gmailStatus?.connected && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px] text-muted-foreground"
                              onClick={() => setGmailDisconnectConfirmOpen(true)}
                            >
                              Disconnect
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : i.id === "google-calendar" && !MOCK_MODE ? (
                    /* Phase 10.3 — read-only. No OAuth connect/callback flow
                       exists in this repo for Google Calendar; the app
                       already writes real events server-side (see
                       netlify/functions/vapi-webhook.ts) against
                       `integrations` rows established outside this UI.
                       Showing a working-looking Connect button here would
                       be a false promise, so this card reports the real
                       status only and defers Connect/Reconnect. */
                    <div className="mt-auto space-y-1.5 pt-3">
                      <span className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold ring-1",
                        gcalStatus?.connected
                          ? "bg-success-soft text-success ring-success/20"
                          : "bg-secondary text-muted-foreground ring-border",
                      )}>
                        {gcalStatus?.connected ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-2.5 w-2.5" />}
                        {gcalStatus?.connected ? "Connected" : "Not connected"}
                      </span>
                      {gcalStatus?.connected && (
                        <div className="space-y-0.5 text-[11px] text-foreground">
                          {gcalStatus.accountEmail && <p><span className="font-semibold">Account:</span> {gcalStatus.accountEmail}</p>}
                          <p>
                            <span className="font-semibold">Last sync:</span> {fmtGmailTimestamp(gcalStatus.lastSyncAt)}
                            {gcalStatus.lastSyncStatus ? ` · ${gcalStatus.lastSyncStatus}` : ""}
                          </p>
                          {gcalStatus.syncError && <p className="text-destructive">{gcalStatus.syncError}</p>}
                        </div>
                      )}
                      <p className="text-[10.5px] text-muted-foreground">
                        {gcalStatus?.connected
                          ? "Managed connection — contact RenoMeta support to reconnect or disconnect."
                          : "Not connected. Contact RenoMeta support to set up Google Calendar sync."}
                      </p>
                    </div>
                  ) : (
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                      <span className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold ring-1",
                        i.connected
                          ? "bg-success-soft text-success ring-success/20"
                          : "bg-secondary text-muted-foreground ring-border",
                      )}>
                        {i.connected ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-2.5 w-2.5" />}
                        {i.connected ? "Connected" : "Not connected"}
                      </span>
                      <div className="flex gap-2">
                        {i.connected ? (
                          <>
                            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openDrawer(i)}>Configure</Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setDisconnectTarget(i)}>Disconnect</Button>
                          </>
                        ) : (
                          <Button size="sm" className="h-7 text-xs" onClick={() => openDrawer(i)}>
                            {actionLabel(i)}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {sections.length === 0 && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No integrations found.
        </div>
      )}

      <IntegrationConfigDrawer
        integration={selected}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onDisconnect={(integration) => {
          updateConnectionStatus(integration.id, false);
          if (integration.id === "gmail") setGmailSmtpEmail(null);
          setDrawerOpen(false);
        }}
        onConnect={(integration) => {
          handleConnect(integration);
          if (integration.id === "gmail") {
            // The drawer just saved organizations.integration_settings.gmail
            // — refetch so the card's configured-email display updates
            // without a full page reload.
            getOrgId().then(async (orgId) => {
              if (!orgId) return;
              const { data: org } = await supabase.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
              setGmailSmtpEmail(org?.integration_settings?.gmail?.email ?? null);
            });
          }
        }}
      />

      <AlertDialog open={!!disconnectTarget} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Disconnect {disconnectTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the connection to {disconnectTarget?.vendor}. Any active automations using this integration will stop working. You can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={gmailDisconnectConfirmOpen} onOpenChange={(open) => !open && !gmailDisconnecting && setGmailDisconnectConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Disconnect Gmail inbox sync?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This revokes RenoMeta Connect's OAuth access to {gmailStatus?.accountEmail ?? "this Gmail account"} and stops future inbox syncing. Previously synced email history is kept, and sending email via SMTP is not affected — you can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={gmailDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnectGmail}
              disabled={gmailDisconnecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {gmailDisconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={gmailSmtpDisconnectConfirmOpen} onOpenChange={(open) => !open && !gmailSmtpDisconnecting && setGmailSmtpDisconnectConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Disconnect Gmail sending?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved Gmail App Password for {gmailSmtpEmail ?? "this account"} — Conversations will no longer be able to send email until new credentials are added. Inbox sync (if connected) is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={gmailSmtpDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnectGmailSmtp}
              disabled={gmailSmtpDisconnecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {gmailSmtpDisconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MetricTile({
  icon: Icon, iconBg, iconColor, label, value,
}: { icon: React.ComponentType<{ className?: string }>; iconBg: string; iconColor: string; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", iconBg, iconColor)}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xl font-bold leading-none text-foreground">{value}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}