// src/routes/forgot-password.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Mail, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/auth-layout";
import { resetPassword } from "@/lib/auth";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Forgot password — RenoMeta Connect" },
      {
        name: "description",
        content:
          "Reset your RenoMeta Connect password. Enter your email and we'll send you a secure reset link.",
      },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Enter the email associated with your account.");
      toast.error("Enter the email associated with your account.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(email);
      setSent(true);
      toast.success("Reset link sent");
    } catch (err: any) {
      // Don't reveal whether the email exists — show success either way
      setSent(true);
      toast.success("Reset link sent");
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        title="Check your inbox"
        subtitle="We've sent password reset instructions to your email."
        footer={
          <Link to="/signin" className="inline-flex items-center gap-1.5 text-primary hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <CheckCircle2 className="h-7 w-7 text-primary" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="text-sm text-foreground">
              If an account exists for{" "}
              <span className="font-medium">{email}</span>, you'll receive an email with a link to reset your password shortly.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn't get it? Check your spam folder or try again in a few minutes.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            Use a different email
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot password?"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <Link to="/signin" className="inline-flex items-center gap-1.5 text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate aria-describedby={error ? "fp-error" : undefined}>
        <div className="space-y-1.5">
          <Label htmlFor="fp-email">Email</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="fp-email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-9"
              aria-invalid={!!error}
            />
          </div>
          {error && (
            <p id="fp-error" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            "Send reset link"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}