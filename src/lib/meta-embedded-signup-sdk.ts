// src/lib/meta-embedded-signup-sdk.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 2 (2026-09). Loads the
// Facebook JS SDK lazily — ONLY when the coexistence flow is actually
// started (never at app startup, never module-load time) — and
// initializes it with the appId/Graph API version the safe bootstrap
// endpoint returned. Never hardcodes an app id or config_id; those are
// always parameters, sourced by the caller from
// meta-whatsapp-embedded-signup-config.ts.
//
// Safe across repeated drawer opens: a module-level promise is the single
// source of truth for "is the SDK loading/loaded" — every caller
// (whether this is the first "Connect existing WhatsApp Business number"
// click ever, or the fifth time the drawer has been opened and closed)
// gets the SAME promise while a load is in flight, and an instant
// resolve once `window.FB` already exists. This is what prevents both a
// duplicate <script> tag AND a race where two concurrent calls each
// think they're the one responsible for injecting the script.

import type { FacebookSdk } from "./meta-embedded-signup-types";

const SCRIPT_ELEMENT_ID = "facebook-jssdk";
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

let sdkPromise: Promise<FacebookSdk> | null = null;
let initializedWithAppId: string | null = null;

export type LoadFacebookSdkParams = {
  appId: string;
  graphApiVersion: string;
};

/**
 * Resolves once `window.FB` exists AND has been initialized with the
 * given appId/version. Never rejects the shared in-flight promise
 * permanently — a failed attempt clears the cache so the NEXT call (e.g.
 * the user clicking the button again after a network blip) gets a fresh
 * attempt rather than being stuck on a dead promise forever.
 */
export function loadFacebookSdk(params: LoadFacebookSdkParams): Promise<FacebookSdk> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("The Facebook SDK can only be loaded in a browser."));
  }
  if (!params.appId) {
    return Promise.reject(new Error("Missing Meta app id — cannot load the Facebook SDK."));
  }

  // Already loaded and initialized with the SAME app id — nothing to do.
  // (A different appId would only happen if the bootstrap config changed
  // between calls within the same page session, which shouldn't occur in
  // practice; re-calling FB.init with a different appId is harmless per
  // Meta's own SDK behavior, so this still re-inits rather than erroring.)
  if (window.FB && initializedWithAppId === params.appId) {
    return Promise.resolve(window.FB);
  }

  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    function finishInit() {
      if (!window.FB) {
        reject(new Error("The Facebook SDK did not load correctly."));
        return;
      }
      window.FB.init({ appId: params.appId, version: params.graphApiVersion, xfbml: false });
      initializedWithAppId = params.appId;
      resolve(window.FB);
    }

    // window.FB script object already present in the DOM (e.g. the SDK
    // finished loading from an earlier call, but window.FB isn't set yet
    // because fbAsyncInit hasn't fired) — never inject a second <script>
    // tag; just wait for the SDK's own init hook.
    const existingScript = document.getElementById(SCRIPT_ELEMENT_ID);
    if (existingScript) {
      const previousAsyncInit = window.fbAsyncInit;
      window.fbAsyncInit = () => {
        previousAsyncInit?.();
        finishInit();
      };
      // If the SDK already finished loading before this call (window.FB
      // exists but wasn't initialized with our appId yet), fbAsyncInit
      // will never fire again — finish immediately instead of waiting
      // forever for an event that already happened.
      if (window.FB) finishInit();
      return;
    }

    window.fbAsyncInit = finishInit;

    const script = document.createElement("script");
    script.id = SCRIPT_ELEMENT_ID;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = SDK_SRC;
    script.onerror = () => reject(new Error("Could not load the Facebook SDK — check your connection and try again."));
    document.body.appendChild(script);
  }).catch((err) => {
    // Clear the cache so a subsequent call gets a fresh attempt instead
    // of permanently reusing a rejected promise.
    sdkPromise = null;
    throw err;
  });

  return sdkPromise;
}

/** Test-only reset — clears the module-level cache between test cases.
 * Never called from production code. */
export function __resetFacebookSdkLoaderForTests(): void {
  sdkPromise = null;
  initializedWithAppId = null;
}
