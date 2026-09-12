// netlify/functions/lib/meta-avatar-cache.ts
//
// Durable caching of Meta/Instagram profile picture URLs into Supabase
// Storage. Meta's CDN (fbcdn.net / Instagram CDN) profile picture URLs
// are short-lived and later return 403. The shared frontend ContactAvatar
// component (src/components/ui/contact-avatar.tsx) already falls back
// gracefully to a generated avatar when a remote image 403s — that UI
// bug is already fixed. What's left is that the browser still makes the
// doomed request to the stale CDN URL first, which is the console/
// network noise this module exists to eliminate: fetch the picture
// SERVER-SIDE once, at profile-enrichment time, and persist a stable,
// RenoMeta/Supabase-hosted copy instead of ever storing the raw Meta CDN
// URL in `contacts.avatar_url`.
//
// Called from meta-messenger-crm.ts / meta-instagram-crm.ts at the exact
// point each already resolves a Contact's avatar from
// metaProfile.profilePic — never anywhere else, and never proxied on
// every page load (this is a one-time-per-enrichment server fetch, not a
// live image proxy).
//
// Storage bucket: "contact-avatars" (public, so the stored copy is
// servable via a plain public URL for <img src>, same as the existing
// "project-photos"/"org-assets" public buckets). This repo creates
// Storage buckets manually (Supabase dashboard), never via SQL migration
// — see supabase/migrations/20260814_secure_project_media.sql, which
// only adds storage.objects RLS *policies* for an already-existing
// bucket, and no migration in this repo ever runs `insert into
// storage.buckets`. This bucket needs no custom RLS policy at all: only
// the service-role client (used exclusively in Netlify Functions, which
// always bypasses RLS) ever writes to it, so the default deny-all for
// `authenticated`/`anon` writes already satisfies "no public write
// access" with zero extra policy rows. See the caller files' own
// comments for the exact one-time manual bucket-creation step required
// before this actually starts working in an environment that doesn't
// have it yet.
//
// Path: contact-avatars/{orgId}/{sha256(channel:providerSenderId)}.jpg —
// deterministic per (org, channel, sender), independent of whether a
// Contact row exists yet (the provider's own sender id — messenger_psid
// / instagram_igsid — is stable and known before either CRM file's
// caller has a contactId to key off of). The filename is an opaque
// SHA-256 hash, never the raw PSID/IGSID itself — this bucket is public,
// so its object paths are effectively public URLs, and a provider sender
// id must never appear in one. A later re-fetch for the same sender
// hashes to the same path and naturally overwrites it (upsert) instead
// of accumulating orphaned files. Extension is always ".jpg" regardless
// of the actual source content-type — the correct Content-Type is set as
// object metadata on upload (that's what a browser <img> actually uses
// to decide how to render it), so fixing the extension keeps exactly one
// file per sender rather than one per content-type ever observed.
//
// Never logs the remote Meta CDN URL itself (its query string can carry
// signing/expiry material), any access token, or a raw provider sender
// id — only safe, non-secret identifiers (orgId, channel, HTTP status,
// byte counts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const CONTACT_AVATAR_BUCKET = "contact-avatars";

// Known Meta-hosted CDN root domains for profile pictures (Facebook/
// Messenger and Instagram both serve these from the same CDN family).
// Matched as an exact hostname or a subdomain of one of these roots —
// e.g. "scontent.fna.fbcdn.net" and "instagram.flhr1-1.fna.fbcdn.net"
// both match the "fbcdn.net" root. Deliberately a narrow allowlist of
// known root domains, not a substring/contains check on the raw URL
// string, so it can only ever recognize genuine Meta CDN URLs — never a
// false positive on some other host that merely mentions "fbcdn"
// somewhere in its name.
const META_CDN_ROOT_DOMAINS = ["fbcdn.net", "cdninstagram.com"];

/**
 * True only for a URL whose hostname is a known Meta/Instagram CDN host
 * (fbcdn.net / cdninstagram.com and their subdomains) — used to detect an
 * already-stored `contacts.avatar_url` that still points at a raw,
 * expiring Meta CDN URL from before this caching helper existed, so
 * enrichment can repair it. Never throws; an unparseable/empty URL
 * safely returns false.
 */
export function isMetaCdnAvatarUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return META_CDN_ROOT_DOMAINS.some(
    (root) => hostname === root || hostname.endsWith(`.${root}`),
  );
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB — generous for a profile picture
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface CacheMetaAvatarParams {
  orgId: string;
  /** Keeps the two channels' paths from ever colliding even if their numeric sender ids overlap. */
  channel: "messenger" | "instagram";
  /** The provider's own sender id (messenger_psid / instagram_igsid) — stable per sender. */
  providerSenderId: string;
  /** The raw Meta CDN profile picture URL just returned by a Graph profile lookup. */
  remoteUrl: string;
}

/**
 * Downloads a Meta CDN profile picture server-side and stores a durable
 * copy in Supabase Storage, returning the stable public URL. Returns
 * null on ANY failure (network error/timeout, non-2xx, disallowed or
 * missing content-type, oversized body, storage upload error) — callers
 * must treat null as "caching didn't work this time" and fall back to
 * whatever avatar behavior they already had (keep the existing stored
 * avatar_url, or leave it unset for ContactAvatar's generated fallback).
 * Never throws, and never blocks/fails inbound message processing.
 */
export async function cacheMetaAvatar(
  supabaseAdmin: SupabaseClient,
  params: CacheMetaAvatarParams,
): Promise<string | null> {
  const { orgId, channel, providerSenderId, remoteUrl } = params;
  if (!orgId || !providerSenderId || !remoteUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const res = await fetch(remoteUrl, { signal: controller.signal });
    if (!res.ok) {
      console.warn("[meta-avatar-cache] remote_fetch_failed", { orgId, channel, httpStatus: res.status });
      return null;
    }

    contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      console.warn("[meta-avatar-cache] unsupported_content_type", { orgId, channel, contentType });
      return null;
    }

    const declaredLength = Number(res.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      console.warn("[meta-avatar-cache] image_too_large", { orgId, channel, declaredLength });
      return null;
    }

    bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      console.warn("[meta-avatar-cache] image_too_large_after_download", { orgId, channel, size: bytes.byteLength });
      return null;
    }
    if (bytes.byteLength === 0) {
      console.warn("[meta-avatar-cache] empty_image_body", { orgId, channel });
      return null;
    }
  } catch (err) {
    console.warn("[meta-avatar-cache] remote_fetch_error", {
      orgId, channel,
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Opaque, deterministic filename — this bucket is public, so its
  // object paths are effectively public URLs, and the raw provider
  // sender id (PSID/IGSID) must never appear in one. Hashing
  // "channel:providerSenderId" keeps the path stable/reproducible per
  // sender (so a later re-fetch overwrites the same object) without
  // ever exposing the identifier itself.
  const avatarKey = createHash("sha256").update(`${channel}:${providerSenderId}`).digest("hex");
  const path = `${orgId}/${avatarKey}.jpg`;

  try {
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(CONTACT_AVATAR_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });

    if (uploadErr) {
      console.warn("[meta-avatar-cache] storage_upload_failed", { orgId, channel, message: uploadErr.message });
      return null;
    }

    const { data } = supabaseAdmin.storage.from(CONTACT_AVATAR_BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.warn("[meta-avatar-cache] storage_upload_error", {
      orgId, channel,
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
