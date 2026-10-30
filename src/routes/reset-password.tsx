// src/routes/reset-password.tsx
//
// The ONLY place a password-recovery session is turned into a password change. Public route (the recovery link is opened by a user who is
// not signed in, possibly in a fresh browser), listed in __root.tsx PUBLIC_ROUTES and app-shell.tsx isAuthRoute. See src/lib/password-recovery.ts
// for the root cause and design. This page never reads a redirect/next parameter and never logs a token; after the password changes the user
// is signed out everywhere and returned to /signin (no auto-login).

import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/lib/supabase";
import { ResetPasswordView, type ResetViewState } from "@/components/auth/reset-password-view";
import {
  bootstrapRecovery, cancelRecovery, getCapturedRecoveryIntent, parseRecoveryUrl, submitNewPassword,
  type RecoveryAuth, type RecoveryBootstrap, type RecoveryIntent,
} from "@/lib/password-recovery";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Reset password — RenoMeta Connect" }, { name: "robots", content: "noindex" }] }),
  component: ResetPasswordPage,
});

const auth = supabase.auth as unknown as RecoveryAuth;
const kv = () => window.localStorage;

// A one-time token must be verified exactly once even if the effect runs twice (StrictMode, re-mount): share one promise per page load.
let bootstrapOnce: Promise<RecoveryBootstrap> | null = null;
function bootstrapForThisLoad(): Promise<RecoveryBootstrap> {
  if (!bootstrapOnce) {
    // Prefer the intent captured BEFORE supabase-js consumed the URL; fall back to what is in the address bar now.
    let intent: RecoveryIntent = getCapturedRecoveryIntent();
    if (intent.kind === "none") intent = parseRecoveryUrl(window.location.hash, window.location.search);
    bootstrapOnce = bootstrapRecovery(auth, intent, kv());
  }
  return bootstrapOnce;
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<ResetViewState>({ kind: "checking" });
  // The user Supabase verified this recovery for; the password change is refused for any other session.
  const recoveringUserId = useRef("");

  useEffect(() => {
    let cancelled = false;
    void bootstrapForThisLoad().then((result) => {
      if (cancelled) return;
      // remove tokens / error params from the address bar and history entry
      try { window.history.replaceState(null, "", "/reset-password"); } catch { /* ignore */ }
      if (result.status === "ready") recoveringUserId.current = result.userId;
      setState(result.status === "ready" ? { kind: "ready", email: result.email } : { kind: "invalid", problem: result.problem });
    });
    return () => { cancelled = true; };
  }, []);

  const onSubmit = useCallback(async (password: string, confirm: string) => {
    const result = await submitNewPassword(auth, kv(), recoveringUserId.current, password, confirm);
    if (result.ok) setState({ kind: "done" });
    else if (result.linkProblem) setState({ kind: "invalid", problem: result.linkProblem });
    return result;
  }, []);

  const goSignIn = useCallback(() => { bootstrapOnce = null; navigate({ to: "/signin", replace: true }); }, [navigate]);
  const onCancel = useCallback(async () => { await cancelRecovery(auth, kv()); goSignIn(); }, [goSignIn]);
  const onRequestNewLink = useCallback(async () => { await cancelRecovery(auth, kv()); bootstrapOnce = null; navigate({ to: "/forgot-password", replace: true }); }, [navigate]);

  return <ResetPasswordView state={state} onSubmit={onSubmit} onCancel={onCancel} onRequestNewLink={onRequestNewLink} onSignIn={goSignIn} />;
}
