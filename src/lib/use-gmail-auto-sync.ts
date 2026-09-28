// React glue for src/lib/gmail-auto-sync.ts. Runs only while the calling page
// (Conversations) is mounted and `enabled` (Gmail connected). Both the automatic
// triggers and the manual "Sync Gmail" button go through the same controller and
// the same real server call (triggerGmailSync -> netlify/functions/gmail-sync).

import { useEffect, useMemo, useRef } from "react";
import { triggerGmailSync } from "@/lib/gmail-sync-client";
import { createGmailAutoSync, type GmailSyncOutcome, type GmailSyncSource } from "@/lib/gmail-auto-sync";

/** The real server sync (exported so tests can assert the production wiring hits gmail-sync). */
export const syncViaGmailServer = (source: GmailSyncSource) => triggerGmailSync({ silent: source === "auto" });

export function useGmailAutoSync(opts: {
  enabled: boolean;
  onSynced: (result: Extract<GmailSyncOutcome, { ok: true }>, source: GmailSyncSource) => void;
}) {
  const onSyncedRef = useRef(opts.onSynced);
  onSyncedRef.current = opts.onSynced;

  const controller = useMemo(
    () =>
      createGmailAutoSync({
        sync: syncViaGmailServer,
        onSynced: (result, source) => onSyncedRef.current(result, source),
        // Quiet but observable: automatic failures are logged, never toasted.
        onError: (error, source) => {
          if (source === "auto") console.warn("[gmail-auto-sync] automatic sync failed:", error);
        },
        isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
        now: () => Date.now(),
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (h) => window.clearInterval(h as number),
        addListener: (event, fn) => {
          const target: EventTarget = event === "focus" ? window : document;
          target.addEventListener(event, fn);
          return () => target.removeEventListener(event, fn);
        },
      }),
    [],
  );

  useEffect(() => {
    if (!opts.enabled) return;
    controller.start();
    return () => controller.stop();
  }, [controller, opts.enabled]);

  return controller;
}
