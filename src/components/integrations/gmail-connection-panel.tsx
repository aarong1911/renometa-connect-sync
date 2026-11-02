// src/components/integrations/gmail-connection-panel.tsx
//
// The Gmail card body on Settings → Integrations. One primary path —
// "Connect with Google" (gmail-oauth-start.ts → Google consent →
// gmail-oauth-callback.ts) — which powers inbox sync and every
// contractor-originated email: Conversations replies, estimates, change
// orders and email campaigns (lib/gmail-send.ts, routed by
// netlify/functions/lib/contractor-email.ts).
//
// Kept as compact as the other integration cards: the header, description
// and feature chips come from the shared card; this panel adds only the
// connection state and its actions. Authorization and sync health are shown
// separately (see lib/gmail-connection-health.ts): only a genuine credential
// failure asks for a reconnect.
//
// Disconnect and the legacy SMTP settings live behind "Manage". Legacy SMTP
// is only ever offered to orgs that already have it — nothing here suggests
// an App Password is needed for Google.
//
// Presentational only — the route owns the fetches, handlers, the SMTP
// drawer and the confirm dialogs.

import { AlertTriangle, CheckCircle2, ChevronDown, Circle, Loader2, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { gmailCardState, type GmailCardState, type GmailConnectionStatus } from "@/lib/gmail-connection-health";

export const PRIVACY_POLICY_URL = "https://renometa.com/privacy-policy";

type Props = {
  status: GmailConnectionStatus | null;
  loading: boolean;
  statusError: string | null;
  connecting: boolean;
  syncing: boolean;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  onRetryStatus: () => void;
  /** Address of an existing legacy SMTP setup; null when the org has none. */
  smtpEmail: string | null;
  /** Opens the Advanced / legacy email settings drawer. */
  onOpenLegacySettings: () => void;
  formatTimestamp: (iso: string | null) => string;
};

export type GmailManageAction = { id: "legacy" | "disconnect"; label: string; destructive?: boolean };

/**
 * What the "Manage" menu offers. Reconnect is the card's primary button
 * whenever it applies, so it isn't repeated here.
 */
export function gmailManageActions(input: { state: GmailCardState; hasSmtp: boolean }): GmailManageAction[] {
  if (input.state !== "connected" && input.state !== "reconnect") return [];
  const actions: GmailManageAction[] = [];
  if (input.hasSmtp) actions.push({ id: "legacy", label: "Advanced: legacy email settings" });
  actions.push({ id: "disconnect", label: "Disconnect Google account", destructive: true });
  return actions;
}

export function GmailConnectionPanel(props: Props) {
  const { status, loading, statusError, connecting, syncing } = props;
  const state = gmailCardState({ loading, error: statusError, status });
  const manageActions = gmailManageActions({ state, hasSmtp: !!props.smtpEmail });

  if (state === "loading") {
    return (
      <div className="mt-auto pt-3">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Checking your Google connection…
        </p>
      </div>
    );
  }

  if (state === "status_error") {
    return (
      <div className="mt-auto space-y-2 pt-3">
        <p className="text-[11px] text-destructive">{statusError} — your connection itself is unchanged.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="neutral" size="sm" className="h-7 text-xs" onClick={props.onRetryStatus}>Try again</Button>
          {props.smtpEmail && <LegacySettingsLink onClick={props.onOpenLegacySettings} />}
        </div>
      </div>
    );
  }

  if (state === "not_connected" || !status) {
    return (
      <div className="mt-auto space-y-2.5 pt-3">
        <ul className="space-y-1">
          <Benefit>Sync customer emails into Conversations</Benefit>
          <Benefit>Send replies, estimates, change orders and campaigns</Benefit>
        </ul>
        {props.smtpEmail && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Replies and campaigns currently send from{" "}
            <span className="break-all font-medium text-foreground">{props.smtpEmail}</span>.{" "}
            <LegacySettingsLink onClick={props.onOpenLegacySettings} />
          </p>
        )}
        <Button size="sm" className="h-7 text-xs" disabled={connecting} onClick={props.onConnect}>
          {connecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {connecting ? "Opening Google…" : "Connect with Google"}
        </Button>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          RenoMeta requests permission to read and send email.{" "}
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
            Learn how we use Google data
          </a>
          .
        </p>
      </div>
    );
  }

  const reconnect = state === "reconnect";
  return (
    <div className="mt-auto space-y-2.5 pt-3">
      <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-foreground">
        <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate" title={status.accountEmail ?? undefined}>
          {status.accountEmail ?? "Connected Google account"}
        </span>
      </p>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">Authorization</dt>
        <dd>
          {reconnect ? (
            <StatusPill tone="warning" icon={<AlertTriangle className="h-2.5 w-2.5" />}>Reconnect needed</StatusPill>
          ) : (
            <StatusPill tone="success" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>Authorized</StatusPill>
          )}
        </dd>
        <dt className="text-muted-foreground">Inbox sync</dt>
        <dd>
          {reconnect ? (
            <StatusPill tone="muted" icon={<Circle className="h-2 w-2" />}>Paused</StatusPill>
          ) : status.syncHealth === "ok" ? (
            <StatusPill tone="success" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>Working</StatusPill>
          ) : status.syncHealth === "failing" || status.syncHealth === "auth_error" ? (
            <StatusPill tone="destructive" icon={<AlertTriangle className="h-2.5 w-2.5" />}>Failing</StatusPill>
          ) : (
            <StatusPill tone="muted" icon={<Circle className="h-2 w-2" />}>Waiting</StatusPill>
          )}
        </dd>
        <dt className="text-muted-foreground">Last synced</dt>
        <dd className="truncate text-foreground">{props.formatTimestamp(status.lastSuccessfulSyncAt)}</dd>
      </dl>

      {reconnect && (
        <p className="text-[11px] leading-relaxed text-warning">
          Google access expired or was revoked. Reconnect the same account to resume — nothing synced is lost.
          {props.smtpEmail ? ` Until then, replies and campaigns send from ${props.smtpEmail}.` : ""}
        </p>
      )}

      {!reconnect && status.syncHealth === "failing" && (
        <p className="break-words text-[11px] leading-relaxed text-destructive">
          {status.syncError ? `${status.syncError} ` : ""}
          <span className="text-muted-foreground">Authorization is fine, so reconnecting won't help — try Sync now.</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {reconnect ? (
          <Button size="sm" className="h-7 text-xs" disabled={connecting} onClick={props.onConnect}>
            {connecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {connecting ? "Opening Google…" : "Reconnect Google"}
          </Button>
        ) : (
          <Button variant="neutral" size="sm" className="h-7 text-xs" disabled={syncing} onClick={props.onSync} aria-label="Sync Gmail now">
            {syncing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="neutral" size="sm" className="h-7 text-xs" aria-label="Manage Gmail connection">
              Manage <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {manageActions.map((a) => (
              <ManageItem key={a.id} action={a} onSelect={a.id === "legacy" ? props.onOpenLegacySettings : props.onDisconnect} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ManageItem({ action, onSelect }: { action: GmailManageAction; onSelect: () => void }) {
  return (
    <>
      {action.destructive && <DropdownMenuSeparator />}
      <DropdownMenuItem
        onSelect={onSelect}
        className={cn("text-xs", action.destructive && "text-destructive focus:text-destructive")}
      >
        {action.label}
      </DropdownMenuItem>
    </>
  );
}

function LegacySettingsLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Legacy email settings
    </button>
  );
}

function Benefit({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5 text-[11px] text-foreground">
      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
      <span>{children}</span>
    </li>
  );
}

function StatusPill({ tone, icon, children }: { tone: "success" | "warning" | "destructive" | "muted"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1",
      tone === "success" && "bg-success-soft text-success ring-success/20",
      tone === "warning" && "bg-warning-soft text-warning ring-warning/20",
      tone === "destructive" && "bg-destructive/10 text-destructive ring-destructive/20",
      tone === "muted" && "bg-secondary text-muted-foreground ring-border",
    )}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
