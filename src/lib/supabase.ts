import { createClient } from "@supabase/supabase-js";
import { captureRecoveryIntent, installRecoveryListener } from "./password-recovery";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Check your .env file."
  );
}

// Password recovery: supabase-js reads and then REMOVES the recovery tokens from the URL while it initializes, turning them into an ordinary
// session. Record what the URL meant (and mark "recovery pending") first, so the app can route the user to /reset-password instead of
// treating the link as a normal sign-in. See src/lib/password-recovery.ts. (Runs only in the browser.)
captureRecoveryIntent();

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Registered synchronously, before auth-js finishes initializing, so its PASSWORD_RECOVERY event (emitted only after the URL tokens were verified)
// is never missed: it binds the pending recovery to the user Supabase verified.
installRecoveryListener(supabase.auth);