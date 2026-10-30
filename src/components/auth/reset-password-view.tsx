// src/components/auth/reset-password-view.tsx
//
// Presentation for the /reset-password page. No router, Supabase or storage access here — the route wires those in — so every state is
// unit-testable. Reuses the existing AuthLayout / Input / Button / Label design system.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/auth-layout";
import { LINK_PROBLEM_MESSAGES, MIN_PASSWORD_LENGTH, type PasswordFieldErrors, type RecoveryProblem, type SubmitResult } from "@/lib/password-recovery";

export type ResetViewState =
  | { kind: "checking" }
  | { kind: "ready"; email: string | null }
  | { kind: "invalid"; problem: RecoveryProblem }
  | { kind: "done" };

export type ResetPasswordViewProps = {
  state: ResetViewState;
  onSubmit: (password: string, confirm: string) => Promise<SubmitResult>;
  onCancel: () => void;
  onRequestNewLink: () => void;
  onSignIn: () => void;
};

function PasswordField(props: {
  id: string; label: string; value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean; describedBy?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={props.id}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          autoFocus={props.autoFocus}
          required
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="pl-9 pr-10"
          aria-invalid={!!props.error}
          aria-describedby={props.error ? `${props.id}-error` : props.describedBy}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {props.error && <p id={`${props.id}-error`} role="alert" className="text-xs text-destructive">{props.error}</p>}
    </div>
  );
}

export function NewPasswordForm({ email, onSubmit, onCancel }: { email: string | null; onSubmit: ResetPasswordViewProps["onSubmit"]; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await onSubmit(password, confirm);
      if (!result.ok) {
        if (result.fieldErrors) setErrors(result.fieldErrors);
        if (result.message) setFormError(result.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate data-testid="new-password-form">
      {email && <p className="text-xs text-muted-foreground">Choosing a new password for <span className="font-medium text-foreground">{email}</span>.</p>}
      <PasswordField id="new-password" label="New password" value={password} onChange={setPassword} error={errors.password} autoFocus describedBy="new-password-hint" />
      <p id="new-password-hint" className="-mt-2 text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
      <PasswordField id="confirm-password" label="Confirm new password" value={confirm} onChange={setConfirm} error={errors.confirm} />
      {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
      <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
        {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />Updating…</> : "Update password"}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onCancel} disabled={submitting}>Cancel</Button>
    </form>
  );
}

export function ResetPasswordView({ state, onSubmit, onCancel, onRequestNewLink, onSignIn }: ResetPasswordViewProps) {
  if (state.kind === "checking") {
    return (
      <AuthLayout title="Verifying your link" subtitle="One moment…">
        <div className="flex justify-center py-8" role="status" aria-live="polite"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Verifying" /></div>
      </AuthLayout>
    );
  }
  if (state.kind === "invalid") {
    return (
      <AuthLayout title="Reset link problem" subtitle="We couldn't use this password reset link.">
        <div className="flex flex-col items-center gap-4 text-center" data-testid="reset-link-problem">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10"><AlertTriangle className="h-7 w-7 text-destructive" aria-hidden /></div>
          <p className="text-sm text-foreground" role="alert">{LINK_PROBLEM_MESSAGES[state.problem]}</p>
          <Button className="w-full" onClick={onRequestNewLink}>Request a new link</Button>
          <Button variant="ghost" className="w-full" onClick={onSignIn}>Back to sign in</Button>
        </div>
      </AuthLayout>
    );
  }
  if (state.kind === "done") {
    return (
      <AuthLayout title="Password updated" subtitle="Your password has been changed.">
        <div className="flex flex-col items-center gap-4 text-center" data-testid="reset-success">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"><CheckCircle2 className="h-7 w-7 text-primary" aria-hidden /></div>
          <p className="text-sm text-foreground">For your security you've been signed out on all devices. Sign in with your new password to continue.</p>
          <Button className="w-full" onClick={onSignIn}>Back to sign in</Button>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="Enter and confirm the password you'd like to use.">
      <NewPasswordForm email={state.email} onSubmit={onSubmit} onCancel={onCancel} />
    </AuthLayout>
  );
}
