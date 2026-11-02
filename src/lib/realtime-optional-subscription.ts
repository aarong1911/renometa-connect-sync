// src/lib/realtime-optional-subscription.ts
//
// Isolation for OPTIONAL Realtime subscriptions — tables whose live updates
// are a nice-to-have, and which may not be in the `supabase_realtime`
// publication.
//
// Why this exists: Supabase Realtime validates every postgres_changes binding
// on a channel at join time, and ONE rejected binding fails the WHOLE channel
// ("Unable to subscribe to changes with given parameters. Please check
// Realtime is enabled…"). `deal_activities` is not published in production
// (confirmed 2026-11-02 against the live Realtime endpoint), and its single
// INSERT binding on the shared realtime-bridge channel had been taking down
// all of that channel's ~45 other CRM / organization / team bindings since it
// was added. An optional table therefore gets its own channel, and that
// channel removes itself on its first error: realtime-js would otherwise
// rejoin a permanently rejected channel on a backoff timer forever.
//
// Trade-off: a transient socket error also reports CHANNEL_ERROR, so an
// optional subscription that hits one stays off until the bridge re-mounts
// (reload, org change). Acceptable for nice-to-have freshness; core tables
// stay on channels that keep realtime-js's normal rejoin behavior.
//
// Logs only the channel, table and event — never row payloads, server
// messages verbatim, tokens or credentials.

export type PostgresChangeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export type OptionalTableSubscription = {
  channelName: string;
  table: string;
  event: PostgresChangeEvent;
  filter?: string;
  onChange: (payload: unknown) => void;
};

// The slice of supabase-js's RealtimeChannel / SupabaseClient this uses.
export type RealtimeChannelLike = {
  on(type: "postgres_changes", filter: Record<string, string>, callback: (payload: any) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannelLike;
};
export type RealtimeClientLike = {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: any): unknown;
};

export type RealtimeLogger = (message: string, details: Record<string, unknown>) => void;

/** Subscribes one optional table on its own channel. Returns an idempotent cleanup. */
export function subscribeOptionalTable(
  client: RealtimeClientLike,
  spec: OptionalTableSubscription,
  log: RealtimeLogger = (message, details) => console.warn(message, details),
): () => void {
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    client.removeChannel(channel);
  };
  const channel = client.channel(spec.channelName).on(
    "postgres_changes",
    { event: spec.event, schema: "public", table: spec.table, ...(spec.filter ? { filter: spec.filter } : {}) },
    (payload) => spec.onChange(payload),
  );
  channel.subscribe((status) => {
    if (removed || status !== "CHANNEL_ERROR") return;
    log("[realtime] optional subscription unavailable; live updates for this table are off", {
      channel: spec.channelName,
      table: spec.table,
      event: spec.event,
      status,
    });
    remove();
  });
  return remove;
}

/**
 * Extracts only the table name from a Realtime "Unable to subscribe…" system
 * message, so a failure log can say which binding was rejected without
 * repeating the server's full text (which echoes filter values).
 */
export function rejectedRealtimeTable(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const m = message.match(/\btable: ([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}
