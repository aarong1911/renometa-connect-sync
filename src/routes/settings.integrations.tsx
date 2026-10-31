// src/routes/settings.integrations.tsx
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Search, Plug, CheckCircle2, Circle, AlertTriangle, Loader2 } from "lucide-react";
import { INTEGRATIONS, CATEGORIES, type Integration, type CategoryId } from "@/lib/integrations-data";
import { MOCK_MODE } from "@/lib/mock-mode";
import { IntegrationConfigDrawer } from "@/components/integrations/integration-config-drawer";
import { cn } from "@/lib/utils";
import { formatGoogleAdsCustomerId, type GoogleAdsConnectionStatusResponse } from "@/lib/google-ads-format";
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
import { describeGmailOAuthReturn, type GmailConnectionStatus } from "@/lib/gmail-connection-health";
import { GmailConnectionPanel } from "@/components/integrations/gmail-connection-panel";

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

  // ── Google Ads — server-driven status (real google_ads_connections row,
  // never the callback's redirect query param alone — see the OAuth-return
  // effect below). Mirrors the gmail/gcal pattern: a dedicated status
  // object drives the card's detailed rendering, independent of the
  // generic `integrations[].connected` heuristic (google-ads is excluded
  // from that heuristic below, same as google-calendar already is).
  const [googleAdsStatus, setGoogleAdsStatus] = useState<GoogleAdsConnectionStatusResponse | null>(null);
  const [googleAdsStatusLoading, setGoogleAdsStatusLoading] = useState(true);
  const [googleAdsForceSelection, setGoogleAdsForceSelection] = useState(false);
  const googleAdsReturnProcessed = useRef(false);
  // Reconnect + Disconnect phase — mirrors the Gmail card's own
  // reconnect/disconnect state shape above, kept independent so a Google
  // Ads action in flight never disables/blocks the Gmail card or vice versa.
  const [googleAdsReconnecting, setGoogleAdsReconnecting] = useState(false);
  const [googleAdsDisconnecting, setGoogleAdsDisconnecting] = useState(false);
  const [googleAdsDisconnectConfirmOpen, setGoogleAdsDisconnectConfirmOpen] = useState(false);

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
      toast.success("Legacy SMTP sending removed");
      setGmailSmtpDisconnectConfirmOpen(false);
    } catch (err: any) {
      toast.error(`Failed to remove SMTP sending: ${err.message}`);
    } finally {
      setGmailSmtpDisconnecting(false);
    }
  }, []);

  // ── Gmail "SYNC INBOX" state (OAuth) ────────────────────────────────────
  // Independent of the `connected` flag on the Integration objects above
  // (which reflects the older organizations.integration_settings mock/
  // apikey concept) — this reads the real OAuth `integrations` table via
  // gmail-connection-status.ts, and drives Connect/Reconnect/Sync/
  // Disconnect for the Gmail card specifically.
  // The OAuth connection is what the Gmail card's Connected/Not connected
  // count reflects — the legacy SMTP setup is shown inside the card only.
  const [gmailStatus, setGmailStatus] = useState<GmailConnectionStatus | null>(null);
  const [gmailStatusLoading, setGmailStatusLoading] = useState(true);
  const [gmailStatusError, setGmailStatusError] = useState<string | null>(null);
  const [gmailSyncing, setGmailSyncing] = useState(false);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailDisconnecting, setGmailDisconnecting] = useState(false);
  const [gmailDisconnectConfirmOpen, setGmailDisconnectConfirmOpen] = useState(false);

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
      const status: GmailConnectionStatus = await res.json();
      setGmailStatus(status);
      setIntegrations((prev) => prev.map((i) => (i.id === "gmail" ? { ...i, connected: status.connected === true } : i)));
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

  // gmail-oauth-callback.ts redirects back here with
  // ?gmail=success|partial|error (+ ?gmail_message=...) after the OAuth round
  // trip — surface that once, refresh real status, then strip the params so a
  // refresh doesn't re-show it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gmail");
    if (!result) return;
    const outcome = describeGmailOAuthReturn(result, params.get("gmail_message"));
    if (outcome) {
      if (outcome.tone === "success") toast.success(outcome.text);
      else if (outcome.tone === "warning") toast.warning(outcome.text, { duration: 10000 });
      else toast.error(outcome.text, { duration: 10000 });
      if (outcome.tone !== "error") fetchGmailStatus();
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
        fetchGmailStatus();
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
          // google-ads is driven entirely by googleAdsStatus (real
          // google_ads_connections row via google-ads-connection-status.ts,
          // fetched in a dedicated effect below) — there is no
          // `integration_settings.google_ads` key, and this heuristic would
          // always read it as disconnected, clobbering the real status.
          if (i.id === "google-ads") return i;
          // gmail is driven by the OAuth connection (fetchGmailStatus); the
          // integration_settings.gmail key only describes legacy SMTP.
          if (i.id === "gmail") return i;
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

  // Real, authenticated status check — mirrors fetchGmailStatus. This is
  // the ONLY source of truth for whether the Google Ads card shows
  // "Connected"; the OAuth-callback's redirect query param (below) is only
  // ever used to decide which toast to show and whether to open the
  // drawer, never to set connected state directly.
  const fetchGoogleAdsStatus = useCallback(async () => {
    setGoogleAdsStatusLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setGoogleAdsStatusLoading(false); return; }
      const res = await fetch("/.netlify/functions/google-ads-connection-status", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) { setGoogleAdsStatusLoading(false); return; }
      const json: GoogleAdsConnectionStatusResponse = await res.json();
      setGoogleAdsStatus(json);
      updateConnectionStatus("google-ads", json.connected);
    } catch {
      // Best-effort — card keeps whatever state it last had.
    } finally {
      setGoogleAdsStatusLoading(false);
    }
  }, [updateConnectionStatus]);

  useEffect(() => {
    if (MOCK_MODE) { setGoogleAdsStatusLoading(false); return; }
    fetchGoogleAdsStatus();
  }, [fetchGoogleAdsStatus]);

  // google-ads-oauth-callback.ts redirects back here with a safe, short
  // result code — ?google_ads=connected|select_account|sync_pending|
  // cancelled|error (+ ?reason=... for error) — never raw backend/Google
  // errors. Processed exactly once per navigation via the ref guard below:
  // React 18 Strict Mode (dev only) re-invokes effect bodies against the
  // SAME component instance without a real remount, so useRef (which
  // persists across that double-invoke, unlike re-reading the URL alone)
  // is what actually makes this idempotent — reading window.location.search
  // a second time after the params were already stripped would usually
  // also no-op, but the ref makes that guarantee explicit rather than
  // incidental. Real connection state always comes from
  // fetchGoogleAdsStatus() (server-driven), never from this query param.
  useEffect(() => {
    if (googleAdsReturnProcessed.current) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google_ads");
    if (!result) return;
    googleAdsReturnProcessed.current = true;
    const reason = params.get("reason");

    if (result === "connected") {
      toast.success("Google Ads connected");
      fetchGoogleAdsStatus();
    } else if (result === "select_account") {
      toast.success("Google Ads authorized. Select the advertiser account you want to connect.");
      fetchGoogleAdsStatus();
      setGoogleAdsForceSelection(true);
      const googleAds = integrations.find((i) => i.id === "google-ads") ?? INTEGRATIONS.find((i) => i.id === "google-ads") ?? null;
      if (googleAds) openDrawer(googleAds);
    } else if (result === "sync_pending") {
      toast.warning("Google authorized, but we couldn't load your ad accounts yet — you can retry from the Google Ads card.");
      fetchGoogleAdsStatus();
    } else if (result === "cancelled") {
      toast("Google Ads connection cancelled");
    } else if (result === "error") {
      // Only known, safe reason codes get a specific message — anything
      // else (or no reason at all) falls back to the generic message.
      // Never surfaces a raw backend/provider error string.
      const safeMessages: Record<string, string> = {
        invalid_state: "Your Google Ads connection request expired or was invalid — please try again",
        provider_error: "Google could not complete the connection — please try again",
        token_exchange: "Could not finish connecting to Google Ads — please try again",
        server_configuration: "Google Ads connection is not available right now — please try again later",
        // Reconnect + Disconnect phase — Google didn't grant a fresh
        // authorization this time (e.g. the consent screen was skipped),
        // so the existing connection was deliberately left untouched
        // rather than silently keeping the old one. See the "critical
        // refresh token" handling in google-ads-oauth-callback.ts.
        reconnect_requires_consent: "Google didn't grant new access — please try Reconnect again and approve access when prompted",
      };
      toast.error((reason && safeMessages[reason]) || "Could not connect Google Ads — please try again");
    }

    // Preserve every other search param — only these two are ever removed.
    params.delete("google_ads");
    params.delete("reason");
    const next = params.toString();
    window.history.replaceState({}, "", next ? `${window.location.pathname}?${next}` : window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchGoogleAdsStatus]);

  // Reconnect + Disconnect phase — mirrors handleGoogleAdsConnect's shape
  // (see integration-config-drawer.tsx) but passes intent: "reconnect" so
  // the server signs that into the OAuth state and requests Google's
  // account-chooser prompt, letting the user authorize a different Google
  // identity/manager hierarchy without first disconnecting. Never deletes
  // or replaces the existing connection client-side — the callback decides
  // what to persist once the user completes (or cancels) the flow.
  const handleGoogleAdsReconnect = useCallback(async () => {
    if (googleAdsReconnecting) return; // guard against duplicate clicks
    setGoogleAdsReconnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in"); return; }
      const res = await fetch("/.netlify/functions/google-ads-oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ intent: "reconnect" }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.authorizationUrl) {
        toast.error(result.error ?? "Could not start Google Ads reconnect");
        setGoogleAdsReconnecting(false);
        return;
      }
      window.location.assign(result.authorizationUrl);
    } catch {
      toast.error("Network error — could not start Google Ads reconnect");
      setGoogleAdsReconnecting(false);
    }
  }, [googleAdsReconnecting]);

  // Disconnect only ever calls the dedicated server endpoint — never
  // touches google_ads_connections (or anything else) directly, and never
  // deletes historical lead submissions/conversion events/mappings, which
  // live in separate tables scoped by their own organization_id/
  // google_ads_customer_id columns.
  const handleGoogleAdsDisconnect = useCallback(async () => {
    setGoogleAdsDisconnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("You must be signed in to disconnect Google Ads"); return; }
      const res = await fetch("/.netlify/functions/google-ads-disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({}),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(result.error ?? "Could not disconnect Google Ads");
        return;
      }
      toast.success("Google Ads disconnected");
      setGoogleAdsDisconnectConfirmOpen(false);
      await fetchGoogleAdsStatus();
    } catch {
      toast.error("Network error — could not disconnect Google Ads");
    } finally {
      setGoogleAdsDisconnecting(false);
    }
  }, [fetchGoogleAdsStatus]);

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

                  {/* Gmail: one "Connect with Google" path (inbox sync +
                      estimate/change-order sending), with authorization and
                      sync health shown separately. Legacy SMTP lives in a
                      collapsed Advanced section, only for orgs that already
                      have it — see gmail-connection-panel.tsx. */}
                  {i.id === "gmail" && !MOCK_MODE ? (
                    <GmailConnectionPanel
                      status={gmailStatus}
                      loading={gmailStatusLoading}
                      statusError={gmailStatusError}
                      connecting={gmailConnecting}
                      syncing={gmailSyncing}
                      onConnect={handleConnectGmail}
                      onSync={handleSyncGmail}
                      onDisconnect={() => setGmailDisconnectConfirmOpen(true)}
                      onRetryStatus={fetchGmailStatus}
                      smtpEmail={gmailSmtpEmail}
                      onManageSmtp={() => openDrawer(i)}
                      onRemoveSmtp={() => setGmailSmtpDisconnectConfirmOpen(true)}
                      formatTimestamp={fmtGmailTimestamp}
                    />
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
                  ) : i.id === "google-ads" && !MOCK_MODE ? (
                    /* Server-driven — real google_ads_connections row via
                       google-ads-connection-status.ts, never the OAuth
                       callback's redirect query param alone (see the
                       OAuth-return effect above). Skeleton while loading,
                       then one of 5 states the click handler below routes
                       differently for. */
                    <div className="mt-auto space-y-1.5 pt-3">
                      <span className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold ring-1",
                        googleAdsStatusLoading
                          ? "bg-secondary text-muted-foreground ring-border"
                          : googleAdsStatus?.status === "connected"
                          ? "bg-success-soft text-success ring-success/20"
                          : googleAdsStatus?.status === "needs_account_selection" || googleAdsStatus?.status === "needs_account_sync"
                          ? "bg-warning-soft text-warning ring-warning/20"
                          : googleAdsStatus?.status === "error"
                          ? "bg-destructive/10 text-destructive ring-destructive/20"
                          : "bg-secondary text-muted-foreground ring-border",
                      )}>
                        {googleAdsStatusLoading ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : googleAdsStatus?.status === "connected" ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : googleAdsStatus?.status === "needs_account_selection" || googleAdsStatus?.status === "needs_account_sync" || googleAdsStatus?.status === "error" ? (
                          <AlertTriangle className="h-2.5 w-2.5" />
                        ) : (
                          <Circle className="h-2.5 w-2.5" />
                        )}
                        {googleAdsStatusLoading
                          ? "Checking…"
                          : googleAdsStatus?.status === "connected"
                          ? "Connected"
                          : googleAdsStatus?.status === "needs_account_selection"
                          ? "Select account"
                          : googleAdsStatus?.status === "needs_account_sync"
                          ? "Needs attention"
                          : googleAdsStatus?.status === "error"
                          ? "Connection error"
                          : "Not connected"}
                      </span>
                      {googleAdsStatus?.status === "connected" && googleAdsStatus.selectedCustomerId && (
                        <p className="text-[11px] text-foreground">
                          <span className="font-semibold">Account:</span> {formatGoogleAdsCustomerId(googleAdsStatus.selectedCustomerId)}
                        </p>
                      )}
                      {/* Reconnect + Disconnect phase — connected state gets
                          all three lifecycle actions (Manage/Reconnect
                          neutral per the RenoMeta warm-neutral control
                          system, Disconnect destructive); every other
                          status keeps the single existing action button
                          unchanged. flex-wrap keeps this from overflowing
                          the card at narrow widths. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant={googleAdsStatus?.status === "connected" ? "neutral" : "default"}
                          className="h-7 text-xs"
                          disabled={googleAdsStatusLoading}
                          onClick={() => {
                            const needsSelection =
                              googleAdsStatus?.status === "needs_account_selection" ||
                              googleAdsStatus?.status === "needs_account_sync";
                            setGoogleAdsForceSelection(needsSelection);
                            openDrawer(i);
                          }}
                        >
                          {googleAdsStatus?.status === "connected"
                            ? "Manage"
                            : googleAdsStatus?.status === "needs_account_selection"
                            ? "Select account"
                            : googleAdsStatus?.status === "needs_account_sync"
                            ? "Retry sync"
                            : googleAdsStatus?.status === "error"
                            ? "Retry"
                            : "Connect"}
                        </Button>
                        {googleAdsStatus?.status === "connected" && (
                          <>
                            <Button
                              size="sm"
                              variant="neutral"
                              className="h-7 text-xs"
                              disabled={googleAdsReconnecting}
                              onClick={handleGoogleAdsReconnect}
                            >
                              {googleAdsReconnecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                              {googleAdsReconnecting ? "Redirecting…" : "Reconnect"}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 text-xs"
                              onClick={() => setGoogleAdsDisconnectConfirmOpen(true)}
                            >
                              Disconnect
                            </Button>
                          </>
                        )}
                      </div>
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
          // For gmail the drawer only edits legacy SMTP sending — the card's
          // connected state belongs to the Google (OAuth) connection.
          if (integration.id === "gmail") setGmailSmtpEmail(null);
          else updateConnectionStatus(integration.id, false);
          setDrawerOpen(false);
        }}
        onConnect={(integration) => {
          if (integration.id !== "gmail") {
            handleConnect(integration);
          } else {
            // The drawer already toasted "credentials saved" and wrote
            // organizations.integration_settings.gmail — refetch so the
            // card's SMTP email updates without a full page reload.
            setDrawerOpen(false);
            getOrgId().then(async (orgId) => {
              if (!orgId) return;
              const { data: org } = await supabase.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
              setGmailSmtpEmail(org?.integration_settings?.gmail?.email ?? null);
            });
          }
        }}
        googleAdsStatus={googleAdsStatus}
        googleAdsForceSelection={googleAdsForceSelection}
        onGoogleAdsForceSelectionConsumed={() => setGoogleAdsForceSelection(false)}
        onGoogleAdsStatusRefresh={fetchGoogleAdsStatus}
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
              Disconnect Google account?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  RenoMeta's access to <span className="font-medium text-foreground break-all">{gmailStatus?.accountEmail ?? "this Google account"}</span> will be revoked for your whole organization.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>New email stops syncing into Conversations.</li>
                  <li>Replies, estimates, change orders and email campaigns can't be sent from this account until you reconnect.</li>
                  <li>
                    {gmailSmtpEmail
                      ? "Replies and campaigns will send from your legacy SMTP account instead."
                      : "Email campaigns that are still sending pause until you reconnect."}
                  </li>
                  <li>Email already synced stays in RenoMeta.</li>
                </ul>
                <p>You can reconnect at any time.</p>
              </div>
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

      {/* Reconnect + Disconnect phase — disconnect is destructive to the
          LIVE connection only; copy is explicit that historical CRM data
          (leads, attribution, conversion history, test fixtures) is never
          deleted, and that reconnecting later needs no manual cleanup. */}
      <AlertDialog open={googleAdsDisconnectConfirmOpen} onOpenChange={(open) => !open && !googleAdsDisconnecting && setGoogleAdsDisconnectConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Disconnect Google Ads?
            </AlertDialogTitle>
            <AlertDialogDescription>
              RenoMeta will stop syncing leads and reporting from Google Ads. Historical leads, CRM attribution, and conversion history are kept — nothing is deleted. Your Google Ads campaigns are not affected in any way. You can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={googleAdsDisconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleGoogleAdsDisconnect}
              disabled={googleAdsDisconnecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {googleAdsDisconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={gmailSmtpDisconnectConfirmOpen} onOpenChange={(open) => !open && !gmailSmtpDisconnecting && setGmailSmtpDisconnectConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Remove legacy SMTP sending?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved SMTP credentials for {gmailSmtpEmail ?? "this account"}. {gmailStatus?.connected
                ? "Your Google account keeps sending everything — replies, estimates, change orders and campaigns."
                : "Conversations replies and email campaigns stop sending until you connect your Google account."}
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