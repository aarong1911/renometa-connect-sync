// src/components/contacts/communication-preferences-section.tsx
//
// Phase 14.1 — read-only view of a contact's canonical Marketing
// communication-preference state, plus the one safe, one-directional
// action Phase 14.1 supports: unknown -> eligible for SMS.
//
// Read path: the authenticated Supabase client, directly against
// marketing_contact_preferences (authenticated has SELECT-only grant —
// see 20260829_marketing_campaigns_foundation.sql). RLS is the real org
// boundary here, same as every other read in this drawer.
//
// Write path: this component NEVER writes to marketing_contact_preferences
// itself — there is no authenticated INSERT/UPDATE/DELETE grant on that
// table at all. The only mutation is a POST to the trusted
// marketing-contact-preferences-set Netlify function, which independently
// re-validates the contact belongs to the caller's org and refuses
// anything except unknown -> eligible (see that function's own guard —
// this component does not duplicate that logic, it just calls it and
// reflects whatever the backend actually did).
//
// A contact with no preferences row is displayed as Email: Subscribed
// (the opt-out model's default) and SMS: Unknown (the opt-in model's
// default) — no row is ever inserted just to render a display value.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

type SmsStatus = "unknown" | "eligible" | "opted_out" | "suppressed";

type Preferences = {
  email_unsubscribed: boolean;
  email_suppressed: boolean;
  sms_status: SmsStatus;
};

const EMAIL_LABEL: Record<"subscribed" | "unsubscribed" | "suppressed", string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  suppressed: "Suppressed",
};

const SMS_LABEL: Record<SmsStatus, string> = {
  unknown: "Unknown",
  eligible: "Eligible",
  opted_out: "Opted Out",
  suppressed: "Suppressed",
};

const SMS_HELP: Record<SmsStatus, string> = {
  unknown: "SMS marketing eligibility has not been established.",
  eligible: "This contact may receive SMS marketing campaigns.",
  opted_out: "This contact opted out of SMS marketing.",
  suppressed: "SMS marketing is blocked for this contact.",
};

export function CommunicationPreferencesSection({ contactId }: { contactId: string }) {
  const [pref, setPref] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("marketing_contact_preferences")
      .select("email_unsubscribed, email_suppressed, sms_status")
      .eq("contact_id", contactId)
      .maybeSingle();
    if (error) {
      console.error("[CommunicationPreferencesSection] load failed:", error.message);
    }
    // No row = the canonical defaults (email opt-out model, SMS opt-in
    // model) — never inserted here, only ever read.
    setPref(
      data ?? { email_unsubscribed: false, email_suppressed: false, sms_status: "unknown" },
    );
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const emailState: "subscribed" | "unsubscribed" | "suppressed" =
    pref?.email_suppressed ? "suppressed" : pref?.email_unsubscribed ? "unsubscribed" : "subscribed";
  const emailTone: BadgeTone = emailState === "subscribed" ? "success" : emailState === "unsubscribed" ? "warning" : "danger";

  const smsState: SmsStatus = pref?.sms_status ?? "unknown";
  const smsTone: BadgeTone = smsState === "eligible" ? "success" : smsState === "unknown" ? "muted" : smsState === "opted_out" ? "warning" : "danger";

  async function handleMarkEligible() {
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to do this");
      const res = await fetch("/.netlify/functions/marketing-contact-preferences-set", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ contactId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not update SMS eligibility");
      toast.success("SMS marketing eligibility updated.");
      setConfirmOpen(false);
    } catch (err: any) {
      // A 409 (state moved on since page load, e.g. someone else's STOP
      // just landed) or any other failure both resolve the same way here:
      // never trust stale client state, always re-read the canonical row.
      toast.error(err?.message ?? "Could not update SMS eligibility");
    } finally {
      setSubmitting(false);
      await load();
    }
  }

  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Communication Preferences
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Email Marketing</span>
          {loading ? <Skeleton className="h-5 w-20" /> : <StatusBadge tone={emailTone}>{EMAIL_LABEL[emailState]}</StatusBadge>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">SMS Marketing</span>
          <div className="flex items-center gap-2">
            {loading ? (
              <Skeleton className="h-5 w-20" />
            ) : (
              <>
                <StatusBadge tone={smsTone}>{SMS_LABEL[smsState]}</StatusBadge>
                {smsState === "unknown" && (
                  <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setConfirmOpen(true)}>
                    Mark Eligible
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {!loading && <p className="text-[11px] text-muted-foreground">{SMS_HELP[smsState]}</p>}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!submitting) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable SMS marketing for this contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the contact as eligible for SMS marketing campaigns. Only do this when your business has an appropriate basis to contact them by SMS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={(e) => { e.preventDefault(); handleMarkEligible(); }}>
              {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Mark Eligible
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
