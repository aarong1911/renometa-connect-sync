// src/routes/signin.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { AuthLayout, GoogleIcon, AppleIcon } from "@/components/auth/auth-layout";
import { signInWithEmail, signInWithGoogle, signInWithApple, getOrgProfile } from "@/lib/auth";

export const Route = createFileRoute("/signin")({
  head: () => ({
    meta: [
      { title: "Sign in — RenoMeta Connect" },
      {
        name: "description",
        content:
          "Sign in to RenoMeta Connect — the AI command center for renovation and home-service businesses.",
      },
    ],
  }),
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePostLogin = async () => {
    const orgProfile = await getOrgProfile();
    if (!orgProfile || !orgProfile.organizationId || !orgProfile.onboardingComplete) {
      navigate({ to: "/onboarding" });
    } else {
      navigate({ to: "/" });
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter your email and password to continue.");
      toast.error("Enter your email and password to continue.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmail(email, password);
      toast.success("Welcome back");
      await handlePostLogin();
    } catch (err: any) {
      const msg = err?.message || "Sign in failed. Please try again.";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogle = async () => {
    try {
      await signInWithGoogle();
    } catch (err: any) {
      toast.error(err?.message || "Google sign-in failed");
    }
  };

  const handleApple = async () => {
    try {
      await signInWithApple();
    } catch (err: any) {
      toast.error(err?.message || "Apple sign-in failed");
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Let's get you to your command center."
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Mail className="size-3.5" />
            Email
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            aria-required="true"
            aria-invalid={!!error && !email}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 bg-primary-soft/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
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
              autoComplete="current-password"
              required
              aria-required="true"
              aria-invalid={!!error && !password}
              placeholder="••••••••••"
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
        </div>

        <div className="flex items-center justify-between pt-1">
          <Link
            to="/forgot-password"
            className="rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Forgot password?
          </Link>
          <Button
            type="submit"
            disabled={submitting}
            aria-busy={submitting}
            className="h-10 gap-1.5 bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {submitting ? "Signing in…" : "Log in"}
            <ArrowRight className="size-4" aria-hidden />
          </Button>
        </div>
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
          aria-label="Log in with Google"
          onClick={handleGoogle}
        >
          <GoogleIcon className="size-4" />
          Log in with Google
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-center gap-2.5 bg-card font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Log in with Apple"
          onClick={handleApple}
        >
          <AppleIcon className="size-4" />
          Log in with Apple
        </Button>
      </div>
    </AuthLayout>
  );
}