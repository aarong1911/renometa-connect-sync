// src/lib/team.ts
import { supabase } from "@/lib/supabase";

export type InviteResult = { success: true; invitationId: string } | { success: false; error: string };
export type RemoveResult = { success: true } | { success: false; error: string };

async function getToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function inviteMember(params: {
  email: string; role: string; name?: string; phone?: string;
  workerType?: string; isOffline?: boolean; rosterOnly?: boolean;
  addressLine1?: string; addressLine2?: string; city?: string;
  state?: string; postalCode?: string;
  ssn?: string; ein?: string; companyName?: string;
}): Promise<InviteResult> {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  const res  = await fetch("/.netlify/functions/invite-member", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (res.status === 207) return { success: false, error: data.error };
  if (!res.ok)            return { success: false, error: data.error ?? "Invitation failed" };
  return { success: true, invitationId: data.invitationId };
}

export async function removeMemberFromOrg(params: {
  memberId?: string; invitationId?: string;
}): Promise<RemoveResult> {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  const invitationId = params.invitationId?.startsWith("inv-")
    ? params.invitationId.slice(4) : params.invitationId;
  const res  = await fetch("/.netlify/functions/remove-member", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ memberId: params.memberId, invitationId }),
  });
  const data = await res.json();
  if (!res.ok) return { success: false, error: data.error ?? "Remove failed" };
  return { success: true };
}