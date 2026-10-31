// src/components/integrations/gmail-connection-panel.tsx
//
// The Gmail card body on Settings → Integrations. One primary path —
// "Connect with Google" (gmail-oauth-start.ts → Google consent →
// gmail-oauth-callback.ts) — which powers inbox sync and every
// contractor-originated email: Conversations replies, estimates, change
// orders and email campaigns (lib/gmail-send.ts, routed by
// netlify/functions/lib/contractor-email.ts).
//
// Authorization and sync health are shown separately (see
// lib/gmail-connection-health.ts): only a genuine credential failure asks
// for a reconnect; a sync that fails for any other reason keeps "Sync now".
//
// Legacy SMTP (Gmail App Password) is only shown to orgs that already have
// it — it's used for replies and campaigns while their Google account isn't
// connected. New orgs are never offered App Password setup.
//
// Presentational only — the route owns the fetches, handlers and confirm
// dialogs, so the Disconnect confirmation stays a single AlertDialog.

import { AlertTriangle, CheckCircle2, Circle, Loader2, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { gmailCardState, type GmailConnectionStatus } from "@/lib/gmail-connection-health";

const PRIVACY_POLICY_URL = "https://renometa.com/privacy-policy";

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
  smtpEmail: string | null;
  onManageSmtp: () => void;
  onRemoveSmtp: () => void;
  formatTimestamp: (iso: string | null) => string;
};

export function GmailConnectionPanel(props: Props) {
  const { status, loading, statusError, connecting, syncing } = props;
  const state = gmailCardState({ loading, error: statusError, status });

  return (
    <div className="mt-3 space-y-3">
      {state === "loading" && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Checking your Google connection…
        </p>
      )}

      {state === "status_error" && (
        <div className="space-y-2 rounded-md border border-destructive/20 bg-destructive/5 p-2.5">
          <p className="text-[11px] text-destructive">{statusError} — your connection itself is unchanged.</p>
          <Button variant="neutral" size="sm" className="h-7 text-xs" onClick={props.onRetryStatus}>
            Try again
          </Button>
        </div>
      )}

      {state === "not_connected" && (
        <div className="space-y-2.5">
          <ul className="space-y-1">
            <Benefit>Customer emails appear in Conversations</Benefit>
            <Benefit>Replies, estimates, change orders and email campaigns send from your own Gmail address</Benefit>
          </ul>
          <Button size="sm" className="h-8 w-full" disabled={connecting} onClick={props.onConnect}>
            {connecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {connecting ? "Opening Google…" : "Connect with Google"}
          </Button>
          <PermissionsNote />
        </div>
      )}

      {(state === "connected" || state === "reconnect") && status && (
        <div className="space-y-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-info-soft text-info">
              <Mail className="h-3.5 w-3.5" />
            </span>
            <p className="min-w-0 truncate text-[12px] font-medium text-foreground" title={status.accountEmail ?? undefined}>
              {status.accountEmail ?? "Connected Google account"}
            </p>
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[11px]">
            <dt className="text-muted-foreground">Authorization</dt>
            <dd>
              {state === "reconnect" ? (
                <StatusPill tone="warning" icon={<AlertTriangle className="h-2.5 w-2.5" />}>Reconnect needed</StatusPill>
              ) : (
                <StatusPill tone="success" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>Authorized</StatusPill>
              )}
            </dd>
            <dt className="text-muted-foreground">Inbox sync</dt>
            <dd>
              {state === "reconnect" ? (
                <StatusPill tone="muted" icon={<Circle className="h-2 w-2" />}>Paused</StatusPill>
              ) : status.syncHealth === "ok" ? (
                <StatusPill tone="success" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>Working</StatusPill>
              ) : status.syncHealth === "failing" || status.syncHealth === "auth_error" ? (
                <StatusPill tone="destructive" icon={<AlertTriangle className="h-2.5 w-2.5" />}>Failing</StatusPill>
              ) : (
                <StatusPill tone="muted" icon={<Circle className="h-2 w-2" />}>Waiting for first sync</StatusPill>
              )}
            </dd>
            <dt className="text-muted-foreground">Last synced</dt>
            <dd className="truncate text-foreground">{props.formatTimestamp(status.lastSuccessfulSyncAt)}</dd>
          </dl>

          {state === "reconnect" && (
            <p className="rounded-md border border-warning/20 bg-warning-soft p-2 text-[11px] leading-relaxed text-warning">
              Google access for this account expired or was revoked, so inbox sync and estimate emails are paused.
              Reconnect the same account to resume — nothing already synced is lost.
            </p>
          )}

          {state === "connected" && status.syncHealth === "failing" && (
            <div className="space-y-1 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-[11px] leading-relaxed">
              {status.syncError && <p className="break-words text-destructive">{status.syncError}</p>}
              <p className="text-muted-foreground">
                Your Google authorization is fine, so reconnecting won't fix this. Try Sync now; if it keeps failing, contact RenoMeta support.
                {status.lastFailedSyncAt ? ` Last failed attempt: ${props.formatTimestamp(status.lastFailedSyncAt)}.` : ""}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {state === "reconnect" ? (
              <Button size="sm" className="h-7 text-xs" disabled={connecting} onClick={props.onConnect}>
                {connecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {connecting ? "Opening Google…" : "Reconnect Google"}
              </Button>
            ) : (
              <Button
                variant="neutral"
                size="sm"
                className="h-7 text-xs"
                disabled={syncing}
                onClick={props.onSync}
                title="Pull recent Gmail messages into Conversations now"
              >
                {syncing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            )}
            <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={props.onDisconnect}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

      <LegacySmtpSection email={props.smtpEmail} googleSending={state === "connected"} onManage={props.onManageSmtp} onRemove={props.onRemoveSmtp} />
    </div>
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

// Mirrors what Google's consent screen will ask for (GOOGLE_GMAIL_SCOPES:
// gmail.readonly + gmail.send) and what each one is used for.
function PermissionsNote() {
  return (
    <div className="space-y-1 text-[10.5px] leading-relaxed text-muted-foreground">
      <p>Google will ask you to let RenoMeta:</p>
      <ul className="list-disc space-y-0.5 pl-4">
        <li><span className="font-medium text-foreground">Read your email</span> — to show customer conversations in RenoMeta</li>
        <li><span className="font-medium text-foreground">Send email for you</span> — only when your team sends a reply, estimate, change order or email campaign from RenoMeta</li>
      </ul>
      <p>
        RenoMeta never deletes your email, and you can disconnect at any time.{" "}
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
          How we use Google data
        </a>
      </p>
    </div>
  );
}

// Only for orgs that already have SMTP. send-inbox-message.ts and the
// campaign worker use it only while the Google connection can't send.
function LegacySmtpSection({ email, googleSending, onManage, onRemove }: { email: string | null; googleSending: boolean; onManage: () => void; onRemove: () => void }) {
  if (!email) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Legacy SMTP sending</p>
        {googleSending ? (
          <StatusPill tone="muted" icon={<Circle className="h-2 w-2" />}>Standby</StatusPill>
        ) : (
          <StatusPill tone="success" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>In use</StatusPill>
        )}
      </div>
      <p className="truncate text-[11px] text-foreground" title={email}>{email}</p>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {googleSending
          ? "Not in use — your Google account sends everything. Kept only as a backup for replies and campaigns if Google ever needs reconnecting."
          : "Sending your Conversations replies and email campaigns until your Google account is connected. Estimates and change orders need Google."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="neutral" size="sm" className="h-7 text-xs" onClick={onManage}>Update</Button>
        <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}
