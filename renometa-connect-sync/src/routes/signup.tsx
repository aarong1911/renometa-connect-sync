// src/routes/signup.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Mail, Lock, User, Eye, EyeOff, ArrowRight, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { AuthLayout, GoogleIcon, AppleIcon } from "@/components/auth/auth-layout";
import { signUpWithEmail, signInWithGoogle, signInWithApple } from "@/lib/auth";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Create your account — RenoMeta Connect" },
      {
        name: "description",
        content:
          "Start your free RenoMeta Connect workspace — CRM, projects, automation, and financials for renovation pros.",
      },
    ],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string; form?: string }>({});

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name || !email || !password) {
      if (!name) next.name = "Enter your full name.";
      if (!email) next.email = "Enter your work email.";
      if (!password) next.password = "Choose a password.";
      next.form = "Fill in all fields to create your account.";
      setErrors(next);
      toast.error(next.form);
      return;
    }
    if (password.length < 8) {
      next.password = "Password must be at least 8 characters.";
      setErrors(next);
      toast.error(next.password);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const { user } = await signUpWithEmail(email, password, name);

      // If Supabase requires email confirmation
      if (user && !user.confirmed_at) {
        setConfirmationSent(true);
        toast.success("Check your email to confirm your account");
      } else {
        // Auto-confirmed (e.g., confirmation disabled in Supabase settings)
        toast.success("Account created. Welcome to RenoMeta Connect!");
        navigate({ to: "/onboarding" });
      }
    } catch (err: any) {
      const msg = err?.message || "Sign up failed. Please try again.";
      setErrors({ form: msg });
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogle = async () => {
    try {
      await signInWithGoogle();
    } catch (err: any) {
      toast.error(err?.message || "Google sign-up failed");
    }
  };

  const handleApple = async () => {
    try {
      await signInWithApple();
    } catch (err: any) {
      toast.error(err?.message || "Apple sign-up failed");
    }
  };

  // Show confirmation screen after email signup
  if (confirmationSent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="We've sent a confirmation link to activate your account."
        footer={
          <Link to="/signin" className="font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <CheckCircle2 className="h-7 w-7 text-primary" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="text-sm text-foreground">
              We've sent a confirmation link to{" "}
              <span className="font-medium">{email}</span>. Click the link in
              your email to activate your account.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn't get it? Check your spam folder or try again in a few
              minutes.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirmationSent(false);
              setEmail("");
              setPassword("");
              setName("");
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
      title="Create your account"
      subtitle="Set up your workspace in less than a minute."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/signin" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {errors.form && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {errors.form}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="name" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <User className="size-3.5" />
            Full name
          </Label>
          <Input
            id="name"
            autoComplete="name"
            required
            aria-required="true"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined}
            placeholder="Jordan Rivera"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 bg-primary-soft/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          {errors.name && (
            <p id="name-error" className="text-xs text-destructive">{errors.name}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Mail className="size-3.5" />
            Work email
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            aria-required="true"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 bg-primary-soft/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          {errors.email && (
            <p id="email-error" className="text-xs text-destructive">{errors.email}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Lock className="size-3.5" />
            Password
          </Label>
          <div className="relative">
            <Input
              id="password"
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              required
              aria-required="true"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error password-hint" : "password-hint"}
              minLength={8}
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-11 bg-primary-soft/50 pr-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={showPw ? "Hide password" : "Show password"}
              aria-pressed={showPw}
              aria-controls="password"
            >
              {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p id="password-hint" className="text-[11px] text-muted-foreground">
            Must be at least 8 characters.
          </p>
          {errors.password && (
            <p id="password-error" className="text-xs text-destructive">{errors.password}</p>
          )}
        </div>

        <Button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className="mt-2 h-11 w-full gap-1.5 bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {submitting ? "Creating account…" : "Create account"}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3" aria-hidden="true">
        <Separator className="flex-1" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">or</span>
        <Separator className="flex-1" />
      </div>

      <div className="space-y-2.5">
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-center gap-2.5 bg-card font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Sign up with Google"
          onClick={handleGoogle}
        >
          <GoogleIcon className="size-4" />
          Sign up with Google
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-center gap-2.5 bg-card font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Sign up with Apple"
          onClick={handleApple}
        >
          <AppleIcon className="size-4" />
          Sign up with Apple
        </Button>
      </div>
    </AuthLayout>
  );
}