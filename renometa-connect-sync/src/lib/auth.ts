// src/lib/auth.ts
import { supabase } from "./supabase";

// ── Types ──────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  organizationId: string | null;
}

export interface OrgProfile {
  onboardingComplete: boolean;
  organizationId: string | null;
}

// ── Sign In ────────────────────────────────────────────────

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// ── Sign Up ────────────────────────────────────────────────

export async function signUpWithEmail(
  email: string,
  password: string,
  fullName: string
) {
  const [firstName, ...rest] = fullName.trim().split(" ");
  const lastName = rest.join(" ") || null;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName,
      },
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
  return data;
}

// ── OAuth (Google / Apple) ─────────────────────────────────

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithApple() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
  return data;
}

// ── Password Reset ─────────────────────────────────────────

export async function resetPassword(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
  });
  if (error) throw error;
}

// ── Sign Out ───────────────────────────────────────────────

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// ── Session Helpers ────────────────────────────────────────

export async function getSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

export async function getUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

// ── Profile & Org Helpers ──────────────────────────────────

/**
 * Check if the current user has an org with onboarding complete.
 * Used by the auth guard to decide where to redirect.
 */
export async function getOrgProfile(): Promise<OrgProfile | null> {
  const user = await getUser();
  if (!user) return null;

  // 1) Try profiles.organization_id
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  const orgId = profile?.organization_id ?? null;

  if (!orgId) {
    // Check org_memberships as fallback
    const { data: membership } = await supabase
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", user.id)
      .maybeSingle();

    if (!membership?.org_id) {
      return { onboardingComplete: false, organizationId: null };
    }

    const { data: org } = await supabase
      .from("organizations")
      .select("onboarding_complete")
      .eq("id", membership.org_id)
      .maybeSingle();

    return {
      onboardingComplete: org?.onboarding_complete ?? false,
      organizationId: membership.org_id,
    };
  }

  // Fetch org
  const { data: org } = await supabase
    .from("organizations")
    .select("onboarding_complete")
    .eq("id", orgId)
    .maybeSingle();

  return {
    onboardingComplete: org?.onboarding_complete ?? false,
    organizationId: orgId,
  };
}

/**
 * Create org + profile + membership during onboarding.
 */
export async function createOrganization(data: {
  name: string;
  phone?: string;
  website?: string;
  address?: string;
  industry?: string;
  timezone?: string;
  crmGoals?: string[];
  logoUrl?: string;
}) {
  const user = await getUser();
  if (!user) throw new Error("Not authenticated");

  const orgId = crypto.randomUUID();

  // 1) Create organization
  const { error: orgError } = await supabase.from("organizations").insert([
    {
      id: orgId,
      name: data.name,
      public_name: data.name,
      phone: data.phone || null,
      website: data.website || null,
      address: data.address || null,
      industry: data.industry || null,
      timezone: data.timezone || null,
      crm_goals: data.crmGoals || [],
      logo_url: data.logoUrl || null,
      onboarding_complete: false,
      created_by: user.id,
    },
  ]);
  if (orgError) throw orgError;

  // 2) Upsert profile
  const meta = user.user_metadata || {};
  const { error: profileError } = await supabase.from("profiles").upsert([
    {
      id: user.id,
      email: user.email,
      first_name: meta.first_name || null,
      last_name: meta.last_name || null,
      organization_id: orgId,
      role: "owner",
    },
  ]);
  if (profileError) throw profileError;

  // 3) Create org membership
  const { error: memberError } = await supabase
    .from("org_memberships")
    .insert([
      {
        org_id: orgId,
        member_id: user.id,
        role: "owner",
      },
    ]);
  if (memberError) throw memberError;

  return orgId;
}

/**
 * Mark onboarding as complete.
 */
export async function markOnboardingComplete(orgId: string) {
  const { error } = await supabase
    .from("organizations")
    .update({ onboarding_complete: true })
    .eq("id", orgId);
  if (error) throw error;
}

/**
 * Upload org logo to Supabase Storage.
 */
export async function uploadOrgLogo(
  orgId: string,
  file: File
): Promise<string> {
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `${orgId}/logo-${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from("org-assets")
    .upload(path, file, { upsert: true, cacheControl: "3600" });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
  return pub.publicUrl;
}