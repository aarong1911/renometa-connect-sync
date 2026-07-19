// src/routes/auth.callback.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Lock, Eye, EyeOff, Phone, User, MapPin, Shield,
  Building2, CheckCircle2, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getOrgProfile } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/auth-layout";

export const Route = createFileRoute("/auth/callback")({
  validateSearch: (s: Record<string, unknown>) => ({ token: (s.token as string) ?? "" }),
  component: AuthCallback,
});

type Stage = "loading" | "setup" | "done" | "error" | "no-account";

type Invitation = {
  id: string; email: string; role: string;
  first_name: string | null; last_name: string | null;
  organization_id: string; worker_type: string | null;
  primary_phone: string | null;
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
  ssn: string | null; ein: string | null; company_name: string | null;
};

function AuthCallback() {
  const navigate  = useNavigate();
  const { token } = Route.useSearch();
  const [stage, setStage]       = useState<Stage>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);

  // Personal
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [phone,     setPhone]     = useState("");

  // Address
  const [addr1,    setAddr1]    = useState("");
  const [addr2,    setAddr2]    = useState("");
  const [city,     setCity]     = useState("");
  const [stateFld, setStateFld] = useState("");
  const [zip,      setZip]      = useState("");

  // Payroll
  const [ssn,         setSsn]         = useState("");
  const [ein,         setEin]         = useState("");
  const [companyName, setCompanyName] = useState("");

  // Security
  const [password,    setPassword]    = useState("");
  const [confirm,     setConfirm]     = useState("");
  const [showPw,      setShowPw]      = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving,      setSaving]      = useState(false);

  function fmtPhone(raw: string) {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }

  useEffect(() => {
    // This route is dual-purpose: (1) invitation-acceptance, reached with a
    // ?token= from a team-invite email, and (2) the plain OAuth redirect
    // target for "Sign in with Google"/"Sign in with Apple" (see
    // signInWithGoogle()/signInWithApple() in src/lib/auth.ts, which both
    // set redirectTo to this exact route with no token). Previously, ANY
    // visit here with no ?token= unconditionally showed "Link expired" —
    // which is what every Google/Apple sign-in hit, since OAuth never
    // supplies an invitations-table token. Branch on whether a token is
    // present BEFORE assuming this is an invite-acceptance visit.
    if (!token) {
      handleOAuthReturn();
      return;
    }

    const load = async () => {
      const { data, error } = await supabase
        .from("invitations")
        .select("*")
        .eq("token", token)
        .maybeSingle();

      if (error || !data) { setErrorMsg("Invalid invitation link."); setStage("error"); return; }
      if (data.status !== "pending") { setErrorMsg("This invitation has already been used."); setStage("error"); return; }
      if (new Date(data.expires_at) < new Date()) { setErrorMsg("This invitation has expired."); setStage("error"); return; }

      setInvitation(data as Invitation);

      // Pre-fill from invitation — admin may have already entered these
      setFirstName(data.first_name ?? "");
      setLastName(data.last_name ?? "");
      setPhone(data.primary_phone ?? "");
      setAddr1(data.address_line1 ?? "");
      setAddr2(data.address_line2 ?? "");
      setCity(data.city ?? "");
      setStateFld(data.state ?? "");
      setZip(data.postal_code ?? "");
      setSsn(data.ssn ?? "");
      setEin(data.ein ?? "");
      setCompanyName(data.company_name ?? "");

      setStage("setup");
    };
    load();
  }, [token]);

  // No invite token present — this is a plain OAuth return (Google/Apple).
  // Supabase's JS client processes the OAuth redirect's hash/code
  // automatically, so by the time this effect runs, getSession() should
  // already reflect the newly-authenticated user if the OAuth exchange
  // succeeded. Check whether that user already has a profile/org: if so,
  // they're an existing user signing in — go to the dashboard (or
  // onboarding, if they have an account but never finished setup). If
  // there's no session at all, or no profile/org exists yet, treat it as
  // "no account" rather than showing a broken invite-link error.
  async function handleOAuthReturn() {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      // OAuth exchange didn't produce a session (e.g. user cancelled on
      // Google's side, or the exchange failed) — send them back to sign in
      // rather than showing an invite-specific error message.
      setErrorMsg("Sign-in didn't complete. Please try again.");
      setStage("error");
      return;
    }

    const orgProfile = await getOrgProfile();
    if (orgProfile?.organizationId) {
      // Existing user with a real org — go straight to the dashboard
      // (or onboarding, if they have an org but never finished setup).
      navigate({ to: orgProfile.onboardingComplete ? "/" : "/onboarding" });
      return;
    }

    // Authenticated with Google/Apple, but no profile/org exists for this
    // user yet — this is a brand-new sign-up via OAuth, not an existing
    // user signing in. Per the desired behavior: tell them clearly and
    // route into the sign-up/onboarding flow rather than erroring out.
    setStage("no-account");
  }

  const isSub = invitation?.worker_type === "subcontractor";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim())    { toast.error("First name is required"); return; }
    if (password.length < 8)  { toast.error("Password must be at least 8 characters"); return; }
    if (password !== confirm)  { toast.error("Passwords don't match"); return; }
    if (!invitation)           { toast.error("Invitation not loaded"); return; }

    setSaving(true);

    const res = await fetch("/.netlify/functions/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token, password,
        firstName: firstName.trim(), lastName: lastName.trim(),
        phone:       phone.trim()    || undefined,
        addressLine1: addr1.trim()   || undefined,
        addressLine2: addr2.trim()   || undefined,
        city:        city.trim()     || undefined,
        state:       stateFld.trim() || undefined,
        postalCode:  zip.trim()      || undefined,
        ssn:         !isSub ? (ssn.trim() || undefined)          : undefined,
        ein:         isSub  ? (ein.trim() || undefined)          : undefined,
        companyName: isSub  ? (companyName.trim() || undefined)  : undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) { toast.error(data.error ?? "Failed to create account"); setSaving(false); return; }

    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: invitation.email, password,
    });
    if (signInErr) { toast.error("Account created but sign-in failed: " + signInErr.message); setSaving(false); return; }

    setSaving(false);
    setStage("done");
    setTimeout(() => navigate({ to: "/" }), 2000);
  }

  if (stage === "loading") return (
    <AuthLayout title="" subtitle="">
      <div className="flex flex-col items-center gap-3 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Verifying your invitation…</p>
      </div>
    </AuthLayout>
  );

  if (stage === "no-account") return (
    <AuthLayout title="Please sign up first" subtitle="We couldn't find an existing RenoMeta Connect account for this Google account.">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Continue to finish setting up your organization, or go back if this was a mistake.
        </p>
        <Button type="button" className="h-11 w-full bg-foreground text-background hover:bg-foreground/90"
          onClick={() => navigate({ to: "/onboarding" })}>Continue to sign up</Button>
        <Button type="button" variant="outline" className="h-11 w-full"
          onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/signin" }); }}>
          Back to sign in
        </Button>
      </div>
    </AuthLayout>
  );

  if (stage === "error") return (
    <AuthLayout title="Link expired" subtitle="This invite link is no longer valid.">
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorMsg}</div>
        <Button type="button" className="h-11 w-full bg-foreground text-background hover:bg-foreground/90"
          onClick={() => navigate({ to: "/signin" })}>Back to sign in</Button>
      </div>
    </AuthLayout>
  );

  if (stage === "done") return (
    <AuthLayout title="You're all set!" subtitle="Redirecting you to the dashboard…">
      <div className="flex justify-center py-8"><CheckCircle2 className="h-14 w-14 text-green-500" /></div>
    </AuthLayout>
  );

  return (
    <AuthLayout title="Set up your account" subtitle="Complete your profile to join your team on RenoMeta Connect.">
      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Personal */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <User className="size-3" /> Personal Info
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">First name *</Label>
              <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="John" className="h-11 bg-primary-soft/50" required />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Last name</Label>
              <Input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" className="h-11 bg-primary-soft/50" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs"><Phone className="size-3" /> Phone</Label>
              <Input value={phone} onChange={e => setPhone(fmtPhone(e.target.value))} placeholder="555-123-4567" inputMode="tel" className="h-11 bg-primary-soft/50" />
            </div>
          </div>
        </div>

        {/* Address */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <MapPin className="size-3" /> Address
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Street address</Label>
              <Input value={addr1} onChange={e => setAddr1(e.target.value)} placeholder="123 Main St" className="h-11 bg-primary-soft/50" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Apt / Suite</Label>
              <Input value={addr2} onChange={e => setAddr2(e.target.value)} placeholder="Apt 4B" className="h-11 bg-primary-soft/50" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">City</Label>
              <Input value={city} onChange={e => setCity(e.target.value)} placeholder="Miami" className="h-11 bg-primary-soft/50" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">State</Label>
              <Input value={stateFld} onChange={e => setStateFld(e.target.value)} placeholder="FL" className="h-11 bg-primary-soft/50" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">ZIP code</Label>
              <Input value={zip} onChange={e => setZip(e.target.value)} placeholder="33101" className="h-11 bg-primary-soft/50" />
            </div>
          </div>
        </div>

        {/* Payroll */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Shield className="size-3" /> {isSub ? "Business Info" : "Payroll Info"}
          </p>
          {isSub ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs"><Building2 className="size-3" /> Company name</Label>
                <Input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme LLC" className="h-11 bg-primary-soft/50" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">EIN</Label>
                <Input value={ein} onChange={e => setEin(e.target.value)} placeholder="XX-XXXXXXX" className="h-11 bg-primary-soft/50" />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">Social Security Number (SSN)</Label>
              <Input value={ssn} onChange={e => setSsn(e.target.value)} placeholder="XXX-XX-XXXX" type="password" className="h-11 bg-primary-soft/50" />
              <p className="text-[10px] text-muted-foreground">Stored securely for payroll purposes only.</p>
            </div>
          )}
        </div>

        {/* Password */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Lock className="size-3" /> Security
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Password *</Label>
              <div className="relative">
                <Input type={showPw ? "text" : "password"} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters" className="h-11 bg-primary-soft/50 pr-10" required />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Confirm password *</Label>
              <div className="relative">
                <Input type={showConfirm ? "text" : "password"} value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Re-enter password" className="h-11 bg-primary-soft/50 pr-10" required />
                <button type="button" onClick={() => setShowConfirm(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground">
                  {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>

        <Button type="submit" disabled={saving}
          className="h-11 w-full bg-foreground text-background hover:bg-foreground/90">
          {saving
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Setting up…</>
            : "Create account & join team"}
        </Button>
      </form>
    </AuthLayout>
  );
}