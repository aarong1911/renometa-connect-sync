// src/lib/meta-embedded-signup-types.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 2 (2026-09). Minimal,
// narrow local type declarations for the Facebook JS SDK surface this
// codebase actually calls — FB.init() and FB.login() with the specific
// config_id-based Embedded Signup shape, nothing more. Deliberately NOT a
// full @types/facebook-js-sdk (no such package covers Embedded Signup's
// config_id-based login anyway) — a large SDK typings package would bring
// in far more surface than this repo ever touches, and Meta's own JS SDK
// has no first-party TypeScript types at all.

export interface FacebookLoginAuthResponse {
  /** The short-lived (documented 30s TTL) exchangeable authorization
   * code — the ONE thing meta-whatsapp-embedded-signup-complete.ts needs
   * from this response. */
  code?: string;
  [key: string]: unknown;
}

export interface FacebookLoginResponse {
  status?: "connected" | "not_authorized" | "unknown" | string;
  authResponse?: FacebookLoginAuthResponse | null;
}

export interface FacebookLoginExtras {
  setup: Record<string, unknown>;
  featureType: string;
  sessionInfoVersion: string;
}

export interface FacebookLoginOptions {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: FacebookLoginExtras;
}

export interface FacebookSdk {
  init(params: { appId: string; version: string; xfbml?: boolean }): void;
  login(callback: (response: FacebookLoginResponse) => void, options: FacebookLoginOptions): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

// Only needed so this file is treated as a module (required for the
// `declare global` augmentation above to attach to the real global Window
// type rather than creating a local one) — no runtime export.
export {};
