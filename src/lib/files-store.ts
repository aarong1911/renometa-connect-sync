// src/lib/files-store.ts
// Supabase-backed document store for the Files module.
//
// Platform State Sync Phase S5C — Files shared-state migration.
// Phase S5C.1 — Real File Storage (this pass).
//
// BEFORE S5C: a module-level `_files` array + a listener Set + `emit()` +
// `useSyncExternalStore`, hydrated by a top-level `fetchFiles()` call at
// import time. No realtime.
//
// S5C: one TanStack Query per org (`queryKeys.files(orgId)`) for the REAL
// persisted metadata (public.project_files). `useFiles()` keeps its exact
// public shape — a bare `FileRecord[]` — as a thin `useQuery` wrapper.
// Mutations patch + invalidate the shared client after a confirmed write.
// The central RealtimeBridge invalidates `queryKeys.files(orgId)` on any
// `project_files` row change.
//
// S5C.1 root cause (live test: uploaded files never appeared) — TWO
// compounding bugs, not one:
//   1. `addFile()` never called `supabase.storage.upload(...)` at all — it
//      inserted a metadata row with `file_path` set to a browser
//      `URL.createObjectURL(file)` blob: URL (tab-local, not a real
//      Storage object, gone on refresh) or the raw filename.
//   2. `routes/files.tsx`'s `onFiles()` called `addFile(...)` WITHOUT
//      `await` and then unconditionally showed a success toast — so even
//      when the metadata insert failed outright (see below), the user saw
//      "N files uploaded" with nothing on screen and no error surfaced.
// Fixed by: a real Storage upload with a persistent path (this file) and
// an awaited, per-file, honestly-reported upload flow (routes/files.tsx).
//
// `project-files` bucket: confirmed via CLAUDE.md's Storage Buckets table
// ("project-files | Auth | Documents, non-image files") — an existing,
// already-provisioned PRIVATE/authenticated bucket, not invented here. The
// pre-S5C.1 code already hardcoded this bucket name for `getPublicUrl` —
// but `getPublicUrl` is wrong for a private bucket (never returns a
// working link for anyone). S5C.1 switches to `createSignedUrl`/
// `createSignedUrls`, reusing the exact resolver/cache pattern already
// proven in project-photos.ts's private "project-media" bucket (same
// project_files table, different, already-working module — see that
// file's "Signed URL cache" section, mirrored here for this bucket).
//
// `storage_bucket` column — CONFIRMED live schema (S5C.1 audit):
// `text NOT NULL DEFAULT 'project-photos'`. The default is Project
// Photos' bucket, not this domain's — relying on it would tag every
// general-Files row with the wrong bucket name. addFile() below therefore
// ALWAYS writes `storage_bucket: FILES_BUCKET` ("project-files")
// explicitly; nothing in this module ever branches on the column when
// reading, since every row this store manages is always resolved through
// the one project-files bucket regardless.
//
// `project_id` — CONFIRMED live schema (S5C.1 audit): was `NOT NULL` with
// a linkage trigger (validate_project_files_linkage) that unconditionally
// required it to reference an existing Project — which made a "Workspace"
// (no Project) general file impossible to insert. Both are corrected —
// live, manually, and tracked here via
// supabase/migrations/20260904_fix_project_files_workspace_linkage.sql
// (NOT applied by this repo — already applied to production in
// equivalent form; the file exists for schema history only). `project_id:
// null` is now valid; the trigger only requires an existing Project when
// project_id IS NOT NULL, and every other linkage check (org membership,
// phase/milestone/daily_log/task belonging to the Project) is unchanged.
//
// `starred` and `shareLinks` are NOT persisted anywhere — confirmed live:
// `toggleStar`/`createShareLink`/`revokeShareLink` never call Supabase at
// all. Client-only UI decoration, not server state — kept as a small
// local `useSyncExternalStore` layer, decoupled from the (Query-backed)
// real metadata. See Part 3 of the S5C brief.
//
// project-photos.ts / ProjectPhotoGallery.tsx operate on this SAME table
// for the Project detail Photos tab, but are a separate, already-working
// module with their own additional columns (is_cover, daily_log_id) and
// their own upload/delete/cover logic — out of scope here (a different
// parent domain). A `project_files` realtime event still correctly
// refreshes this store's list (a photo uploaded via the Photos tab is a
// real file row and belongs on the Files page too).
//
// "New version" (addVersion) remains a synthetic, non-persisted feature —
// it bumps `project_files.version` and appends a local-only version-
// history entry, but never uploads the replacement file's bytes anywhere.
// That was true before S5C.1 and is unchanged here — this pass's scope is
// the base upload/delete flow, not the version-history feature (see the
// S5C.1 report's "remaining boundaries").
import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FileCategory = "Contract" | "Blueprint" | "Permit" | "Photos" | "Other";
export const FILE_CATEGORIES: FileCategory[] = ["Contract", "Blueprint", "Permit", "Photos", "Other"];

export type FileVersion = {
  id: string;
  version: number;
  uploaded: string;
  uploadedBy: string;
  size: string;
  note?: string;
};

export type ShareLink = {
  id: string;
  createdAt: string;
  createdBy: string;
  recipient?: string;
  expiresAt?: string;
  permission: "view" | "comment" | "edit";
  url: string;
  revoked?: boolean;
};

export type FileActivity = {
  id: string;
  at: string;
  who: string;
  action: "uploaded" | "renamed" | "moved" | "tagged" | "shared" | "share-revoked" | "version-added" | "downloaded" | "deleted" | "starred" | "unstarred";
  detail?: string;
};

export type FileRecord = {
  id: string;
  name: string;
  category: FileCategory;
  projectId?: string;
  projectName?: string;
  size: string;
  uploadedAt: string;
  uploadedBy: string;
  tags: string[];
  starred: boolean;
  shared: boolean;
  versions: FileVersion[];
  shareLinks: ShareLink[];
  activity: FileActivity[];
  url?: string;
  ext: string;
  /**
   * Internal — the real Storage object path (project_files.file_path),
   * carried through so deleteFile() can remove the exact right Storage
   * object without a second lookup. Not rendered anywhere in the UI.
   * Null for legacy rows that never had a real path (blob:/raw filename)
   * — deleteFile() skips Storage removal for those (nothing real to
   * remove), matching Part 14's "no unsafe backfill / no guessing".
   */
  storagePath: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function approxBytes(s: string): number {
  const m = /^([\d.]+)\s*(GB|MB|KB|B)?$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "B").toUpperCase()) {
    case "GB": return Math.round(n * 1_073_741_824);
    case "MB": return Math.round(n * 1_048_576);
    case "KB": return Math.round(n * 1_024);
    default:   return Math.round(n);
  }
}

export function fileIcon(ext: string): string {
  const e = ext.toLowerCase();
  if (["pdf"].includes(e)) return "pdf";
  if (["png","jpg","jpeg","gif","webp","heic","svg"].includes(e)) return "image";
  if (["mp4","mov","avi","mkv"].includes(e)) return "video";
  if (["xlsx","xls","csv"].includes(e)) return "spreadsheet";
  if (["pptx","ppt","key"].includes(e)) return "presentation";
  if (["zip","rar","7z","tar","gz"].includes(e)) return "archive";
  if (["ifc","dwg","rvt","skp"].includes(e)) return "cad";
  return "generic";
}

function inferExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "file";
}

function mimeToCategory(mimeType: string | null, fileType: string | null, fileName: string): FileCategory {
  const name = fileName.toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  const type = (fileType ?? "").toLowerCase();

  if (type === "contract" || name.includes("contract") || name.includes("agreement")) return "Contract";
  if (type === "blueprint" || name.includes("blueprint") || name.includes("drawing") || name.includes(".dwg") || mime.includes("dwg")) return "Blueprint";
  if (type === "permit" || name.includes("permit") || name.includes("inspection")) return "Permit";
  if (mime.startsWith("image/") || ["jpg","jpeg","png","gif","webp","heic"].some(e => name.endsWith(`.${e}`))) return "Photos";
  return "Other";
}

// ── Org ID helper (imperative — mutation functions are not hooks) ─────────────

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

// ── Storage (S5C.1) ─────────────────────────────────────────────────────

/** The one bucket this domain has ever used — see file header. Private/authenticated (CLAUDE.md), never public. */
const FILES_BUCKET = "project-files";
/** Matches project-photos.ts's convention for the same table/private-bucket pattern. */
const FILES_SIGNED_URL_TTL_SECONDS = 60 * 60;

const MIME_EXTENSION_FALLBACK: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
};

const MIN_PRINTABLE_CODE_POINT = 32;
const DEL_CODE_POINT = 127;

/** Removes ASCII control characters without relying on a regex control-character class (same technique as project-photos.ts). */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= MIN_PRINTABLE_CODE_POINT && code !== DEL_CODE_POINT) out += ch;
  }
  return out;
}

/**
 * Strips path separators/control characters, collapses whitespace, and
 * guarantees a non-empty, extension-preserving, ASCII-safe result — never
 * used as file IDENTITY (the storage path's UUID folder is), only as the
 * human-readable tail of the Storage object path. Same algorithm as
 * project-photos.ts's sanitizeFileName (kept local — a different module's
 * internal helper, not exported there).
 */
function sanitizeFileName(originalName: string, mimeType: string): string {
  const parts = originalName.split(/[\\/]/);
  const base = parts[parts.length - 1] || originalName;
  const dotIndex = base.lastIndexOf(".");
  const rawExt = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const namePart = dotIndex > 0 ? base.slice(0, dotIndex) : base;

  const cleanedName = stripControlCharacters(namePart)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 100);

  const ext = rawExt || MIME_EXTENSION_FALLBACK[mimeType] || inferExt(originalName) || "bin";
  return (cleanedName || "file") + "." + ext;
}

/** organizations/{orgId}/files/{fileId}/{safeFileName} — the fileId folder guarantees no collision even if two uploads share a sanitized file name; fileId is reused as the project_files row's own primary key (same trick project-photos.ts uses). */
function buildFilesStoragePath(orgId: string, fileId: string, safeFileName: string): string {
  return `organizations/${orgId}/files/${fileId}/${safeFileName}`;
}

/** A path this store itself never produced — legacy blob:/bare-filename rows from before S5C.1, or the empty string. Never worth an API round trip; mapRow fails gracefully instead of guessing (Part 14). */
function isResolvableStoragePath(path: string | null | undefined): path is string {
  return !!path && !path.startsWith("blob:") && path.includes("/");
}

// -- Signed URL cache (mirrors project-photos.ts's pattern for the same table/bucket shape) --
type SignedUrlCacheEntry = { url: string; expiresAt: number };
const signedUrlCache = new Map<string, SignedUrlCacheEntry>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function getCachedSignedUrl(path: string): string | null {
  const entry = signedUrlCache.get(path);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt - REFRESH_MARGIN_MS) {
    signedUrlCache.delete(path);
    return null;
  }
  return entry.url;
}

function setCachedSignedUrl(path: string, url: string): void {
  signedUrlCache.set(path, { url, expiresAt: Date.now() + FILES_SIGNED_URL_TTL_SECONDS * 1000 });
}

/** Single-file resolution — used right after a successful upload, for the one new row. */
async function resolveFileUrl(path: string | null): Promise<string | undefined> {
  if (!isResolvableStoragePath(path)) return undefined;
  const cached = getCachedSignedUrl(path);
  if (cached) return cached;
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(path, FILES_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("[files-store] createSignedUrl failed:", error);
    return undefined;
  }
  setCachedSignedUrl(path, data.signedUrl);
  return data.signedUrl;
}

/** Batch resolution — one createSignedUrls() call for every not-yet-cached row in a fetched list, instead of one network request per row per render (same reasoning as project-photos.ts's resolvePhotoUrls). */
async function resolveFileUrls(rows: FileRecord[]): Promise<FileRecord[]> {
  const pending: string[] = [];
  for (const row of rows) {
    if (isResolvableStoragePath(row.storagePath) && !getCachedSignedUrl(row.storagePath)) {
      pending.push(row.storagePath);
    }
  }
  if (pending.length > 0) {
    const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrls(pending, FILES_SIGNED_URL_TTL_SECONDS);
    if (error) {
      console.error("[files-store] createSignedUrls batch failed:", error);
    } else {
      for (const entry of data ?? []) {
        if (entry.signedUrl && !entry.error && entry.path) setCachedSignedUrl(entry.path, entry.signedUrl);
      }
    }
  }
  return rows.map((row) => (
    isResolvableStoragePath(row.storagePath)
      ? { ...row, url: getCachedSignedUrl(row.storagePath) ?? undefined }
      : row
  ));
}

const FILE_SELECT = `
  *,
  projects!project_id(name),
  uploader:profiles!uploaded_by(first_name, last_name)
`;

/**
 * Row -> FileRecord, WITHOUT url resolution (async, see resolveFileUrl(s)
 * above) or the local-only starred/shareLinks decoration (applied by
 * useFiles() below). Preserves the exact pre-S5C normalization: display
 * size, inferred extension, derived category, a single synthetic
 * "uploaded" activity entry and a single version entry seeded from the
 * row's own `version` column — none of this was ever a real
 * activity/version-history table.
 */
function mapRowBase(row: any): FileRecord {
  const uploaderName = row.uploader
    ? `${row.uploader.first_name ?? ""} ${row.uploader.last_name ?? ""}`.trim() || "Unknown"
    : "Unknown";

  const sizeStr = row.file_size ? formatBytes(Number(row.file_size)) : "—";
  const ext = inferExt(row.file_name ?? "");
  const category = mimeToCategory(row.mime_type, row.file_type, row.file_name ?? "");

  return {
    id: row.id,
    name: row.file_name ?? "Untitled",
    category,
    projectId: row.project_id ?? undefined,
    projectName: row.projects?.name ?? undefined,
    size: sizeStr,
    uploadedAt: row.created_at,
    uploadedBy: uploaderName,
    tags: row.tags ?? [],
    starred: false,
    shared: false,
    versions: [{
      id: `${row.id}-v${row.version ?? 1}`,
      version: row.version ?? 1,
      uploaded: row.created_at,
      uploadedBy: uploaderName,
      size: sizeStr,
    }],
    shareLinks: [],
    activity: [{
      id: `${row.id}-upload`,
      at: row.created_at,
      who: uploaderName,
      action: "uploaded",
    }],
    url: undefined,
    ext,
    storagePath: row.file_path ?? null,
  };
}

/**
 * The Files list queryFn — org-scoped, newest first, same select/join and
 * normalization the pre-S5C singleton used, now with signed URLs resolved
 * in one batch call. Self-contained (no React, no other query's cache) so
 * it is safe to run from `useQuery` or an imperative `refetchQueries`.
 */
export async function fetchFilesForOrg(orgId: string): Promise<FileRecord[]> {
  const { data, error } = await supabase
    .from("project_files")
    .select(FILE_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[files-store] fetch failed:", error);
    throw error;
  }
  return resolveFileUrls((data ?? []).map(mapRowBase));
}

// ── Query cache helpers (real metadata) ─────────────────────────────────

const qc = () => getQueryClient();

function patchFilesCache(fn: (list: FileRecord[]) => FileRecord[]) {
  qc().setQueriesData<FileRecord[]>({ queryKey: ["files"] }, (old) => (Array.isArray(old) ? fn(old) : old));
}

/** Read-only — used by addFile()'s de-dupe patch and addVersion(). */
function getCachedFiles(): FileRecord[] {
  for (const [, data] of qc().getQueriesData<FileRecord[]>({ queryKey: ["files"] })) {
    if (Array.isArray(data)) return data;
  }
  return [];
}

function invalidateFiles() {
  void qc().invalidateQueries({ queryKey: ["files"] });
}

function useFilesQuery() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.files(orgId) : ["files", "_pending"],
    queryFn: () => fetchFilesForOrg(orgId as string),
    enabled: !!orgId,
    // Files change on explicit user action (upload/delete/rename), not a
    // high-frequency background process — mutation invalidation + realtime
    // + focus-refetch are the primary freshness path.
    staleTime: 45_000,
  });
}

// ── Local-only decoration layer (starred / shareLinks — never persisted) ──

const _starred = new Set<string>();
const _shareLinks = new Map<string, ShareLink[]>();
let _localVersion = 0;
const _localListeners = new Set<() => void>();

function bumpLocal() {
  _localVersion += 1;
  _localListeners.forEach((l) => l());
}

/** Subscribes the calling component to starred/shareLinks changes — the snapshot value itself is unused, only the re-render it triggers matters. */
function useLocalDecorationVersion(): number {
  return useSyncExternalStore(
    (cb) => { _localListeners.add(cb); return () => _localListeners.delete(cb); },
    () => _localVersion,
    () => 0,
  );
}

function decorate(row: FileRecord): FileRecord {
  const links = _shareLinks.get(row.id) ?? [];
  return {
    ...row,
    starred: _starred.has(row.id),
    // Matches the pre-S5C rule exactly: "shared" flips true the moment a
    // link is ever created and stays true even after every link is
    // revoked (revoking never removed the link from the list).
    shared: links.length > 0,
    shareLinks: links,
  };
}

// ── Public hooks (unchanged shapes) ─────────────────────────────────────

export function useFiles(): FileRecord[] {
  const { data } = useFilesQuery();
  const localVersion = useLocalDecorationVersion();
  // Stable reference unless the underlying Query data OR a local
  // decoration actually changed — callers (files.tsx) re-sync a selected
  // row / deep-linked file whenever this array's reference changes, so an
  // unrelated re-render (e.g. typing in the search box) must NOT produce a
  // new array here, or that effect would fire on every keystroke.
  return useMemo(() => (data ?? []).map(decorate), [data, localVersion]);
}

export function useFilesLoading(): boolean {
  return useFilesQuery().isLoading;
}

export async function refreshFiles(): Promise<void> {
  await qc().refetchQueries({ queryKey: ["files"] });
}

// ── Mutations (real metadata — persist-first, patch + invalidate) ────────

export type AddFileResult = { ok: true; file: FileRecord } | { ok: false; error: string };

/**
 * Real Storage upload + metadata insert (S5C.1). Order: sanitize name ->
 * build a persistent, collision-safe, org-scoped path (a fresh UUID folder
 * — never the raw filename, never a blob: URL) -> upload to Storage ->
 * ONLY on upload success, insert the project_files row (reusing the same
 * id as the Storage folder, same trick project-photos.ts uses) -> on
 * metadata failure, best-effort remove the just-uploaded Storage object so
 * a failed insert never leaves an orphaned file -> on success, resolve a
 * signed URL and reflect the row in the cache exactly once.
 */
export async function addFile(params: { file: File; projectId?: string }): Promise<AddFileResult> {
  const orgId = await getOrgId();
  const { data: { user } } = await supabase.auth.getUser();
  if (!orgId || !user) return { ok: false, error: "Could not determine your workspace." };

  const { file } = params;
  const mimeType = file.type || (inferExt(file.name) === "pdf" ? "application/pdf" : "application/octet-stream");
  const fileId = crypto.randomUUID();
  const safeFileName = sanitizeFileName(file.name, mimeType);
  const storagePath = buildFilesStoragePath(orgId, fileId, safeFileName);

  const { error: uploadError } = await supabase.storage
    .from(FILES_BUCKET)
    .upload(storagePath, file, { contentType: mimeType, upsert: false });
  if (uploadError) {
    console.error("[files-store] storage upload failed:", uploadError);
    return { ok: false, error: `${file.name}: upload failed (${uploadError.message})` };
  }

  // S5C.1 debugging fix: the INSERT no longer requests the relational
  // embed (`projects!project_id(name)` / `uploader:profiles!uploaded_by
  // (...)`) that the canonical LIST query uses (Part 3) — persisting a
  // file must never depend on PostgREST being able to resolve a
  // relationship embed on the RETURNING row. A plain `select("*")` is
  // always safe here; the enriched (joined) row arrives moments later via
  // the invalidateFiles() refetch below, which still uses FILE_SELECT
  // unchanged (#5 in the report).
  //
  // `storage_bucket` MUST be written explicitly (live schema audit,
  // S5C.1): the column is `text NOT NULL DEFAULT 'project-photos'` — the
  // Project Photos feature's bucket, not this one. Relying on the column
  // default would tag every general-Files row as living in the wrong
  // bucket. General Files objects are always uploaded to FILES_BUCKET
  // ("project-files" — see the upload call above), so the metadata row
  // must say so explicitly, every time.
  const insertPayload = {
    id: fileId,
    org_id: orgId,
    // Explicit null, never "", "workspace", or undefined — project_id is
    // uuid-typed; an empty-string value 400s a uuid column. NULL is now a
    // valid Workspace-file value (see
    // 20260904_fix_project_files_workspace_linkage.sql — project_id was
    // NOT NULL and its linkage trigger required a real Project until this
    // pass's schema fix, applied live).
    project_id: params.projectId ?? null,
    storage_bucket: FILES_BUCKET,
    file_name: file.name,
    file_path: storagePath,
    file_size: file.size,
    mime_type: mimeType,
    uploaded_by: user.id,
    version: 1,
  };

  const { data, error: dbError } = await supabase
    .from("project_files")
    .insert(insertPayload)
    .select("*")
    .single();

  if (dbError || !data) {
    // A failed metadata insert must never leave an orphaned Storage object.
    const { error: cleanupError } = await supabase.storage.from(FILES_BUCKET).remove([storagePath]);
    // Full PostgREST error shape (code/message/details/hint) — never the
    // collapsed [object Object] a bare `console.error(..., dbError)` logs
    // in most consoles. Safe fields only: no file contents, tokens, signed
    // URLs, or user PII — dbError never carries any of those.
    console.error("[files-store] addFile metadata insert failed, storage object removed:", {
      code: dbError?.code,
      message: dbError?.message,
      details: dbError?.details,
      hint: dbError?.hint,
    });
    if (cleanupError) {
      console.error("[files-store] secondary cleanup also failed — orphaned object left in", FILES_BUCKET, {
        code: cleanupError.name,
        message: cleanupError.message,
      });
      return { ok: false, error: `${file.name}: could not save file details, and cleanup of the uploaded file also failed. It may need manual removal.` };
    }
    return { ok: false, error: `${file.name}: could not save file details${dbError?.message ? ` (${dbError.message})` : ""}.` };
  }

  const mapped = mapRowBase(data);
  mapped.url = await resolveFileUrl(mapped.storagePath);
  patchFilesCache((list) => [mapped, ...list.filter((f) => f.id !== mapped.id)]);
  // The row above has no project name / uploader display name yet (plain
  // select("*") has no embed) — invalidate so the next fetch (which still
  // uses the enriched FILE_SELECT) replaces it with the fully joined row.
  // No duplicate: patch + invalidate both key off the same row id.
  invalidateFiles();
  return { ok: true, file: mapped };
}

export async function renameFile(id: string, newName: string) {
  const { error } = await supabase.from("project_files").update({ file_name: newName }).eq("id", id);
  if (error) { console.error("[files-store] renameFile failed:", error); return; }
  // Metadata-only — the Storage object path never changes on a display
  // rename (Part 12), so the file stays reachable and its cached signed
  // URL stays valid.
  patchFilesCache((list) => list.map((f) => (f.id === id ? { ...f, name: newName } : f)));
  invalidateFiles();
}

export async function moveFile(id: string, projectId: string | undefined) {
  const { error } = await supabase.from("project_files").update({ project_id: projectId ?? null }).eq("id", id);
  if (error) { console.error("[files-store] moveFile failed:", error); return; }
  // Metadata-only — the Storage object is never moved/copied (Part 13).
  // The displayed projectName comes from a join this update doesn't
  // return — invalidate (refetches the active query) rather than guessing
  // the new project's name client-side.
  invalidateFiles();
}

export async function setCategory(id: string, category: FileCategory) {
  const { error } = await supabase.from("project_files").update({ file_type: category.toLowerCase() }).eq("id", id);
  if (error) { console.error("[files-store] setCategory failed:", error); return; }
  patchFilesCache((list) => list.map((f) => (f.id === id ? { ...f, category } : f)));
  invalidateFiles();
}

/** Never persisted (see file header) — local decoration only. */
export function toggleStar(id: string) {
  if (_starred.has(id)) _starred.delete(id);
  else _starred.add(id);
  bumpLocal();
}

export async function setTags(id: string, tags: string[]) {
  const { error } = await supabase.from("project_files").update({ tags }).eq("id", id);
  if (error) { console.error("[files-store] setTags failed:", error); return; }
  patchFilesCache((list) => list.map((f) => (f.id === id ? { ...f, tags } : f)));
  invalidateFiles();
}

/**
 * Unchanged scope boundary (S5C.1 report): this remains a synthetic
 * version-history bump — it does not upload the replacement file's bytes
 * anywhere, only records a version number + a local-only history entry.
 * Fixing that is a separate, larger feature (a real version-history
 * table + re-upload flow), not part of this pass.
 */
export async function addVersion(id: string, params: { size: number; note?: string }) {
  const file = getCachedFiles().find((f) => f.id === id);
  if (!file) return;
  const nextVer = (file.versions[0]?.version ?? 0) + 1;
  const { error } = await supabase.from("project_files").update({ version: nextVer }).eq("id", id);
  if (error) { console.error("[files-store] addVersion failed:", error); return; }
  const newVer: FileVersion = {
    id: `${id}-v${nextVer}`,
    version: nextVer,
    uploaded: new Date().toISOString(),
    uploadedBy: "You",
    size: formatBytes(params.size),
    note: params.note,
  };
  patchFilesCache((list) => list.map((f) => (f.id === id ? { ...f, versions: [newVer, ...f.versions] } : f)));
  invalidateFiles();
}

/** Never persisted (see file header) — local decoration only. */
export function createShareLink(id: string, params: { recipient?: string; permission: "view" | "comment" | "edit"; expiresAt?: string }) {
  const link: ShareLink = {
    id: `sl-${id}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    createdBy: "You",
    recipient: params.recipient,
    permission: params.permission,
    expiresAt: params.expiresAt,
    url: `https://connect.renometa.com/share/${id}`,
    revoked: false,
  };
  const current = _shareLinks.get(id) ?? [];
  _shareLinks.set(id, [link, ...current]);
  bumpLocal();
}

/** Never persisted (see file header) — local decoration only. */
export function revokeShareLink(fileId: string, linkId: string) {
  const links = (_shareLinks.get(fileId) ?? []).map((l) => (l.id === linkId ? { ...l, revoked: true } : l));
  _shareLinks.set(fileId, links);
  bumpLocal();
}

export type DeleteFileResult = { ok: true } | { ok: false; error: string };

/**
 * Metadata delete FIRST, then best-effort Storage cleanup (S5C.1, Part
 * 11) — matches this app's own established recoverability preference
 * (see accounting-integrity-style "never leave an inconsistent DB row"
 * patterns elsewhere in this codebase): a metadata row is the thing every
 * other surface (Files page, realtime, cache) reacts to, so it must never
 * be left pointing at a Storage object that turns out to be unremovable.
 * Deleting the DB row first means a Storage cleanup failure only leaves
 * an orphaned (harmless, invisible) object behind — never a UI-visible
 * row with a broken link. The exact stored path (never a guessed/rebuilt
 * one) is read from the row already in cache. Legacy rows with no real
 * storagePath (blob:/raw filename) skip the Storage call entirely — there
 * is nothing real to remove (Part 14).
 */
export async function deleteFile(id: string): Promise<DeleteFileResult> {
  const existing = getCachedFiles().find((f) => f.id === id);

  const { error } = await supabase.from("project_files").delete().eq("id", id);
  if (error) {
    console.error("[files-store] deleteFile failed:", error);
    return { ok: false, error: "Could not delete this file. Please try again." };
  }

  patchFilesCache((list) => list.filter((f) => f.id !== id));
  invalidateFiles();

  if (isResolvableStoragePath(existing?.storagePath)) {
    const path = existing!.storagePath as string;
    const { error: storageError } = await supabase.storage.from(FILES_BUCKET).remove([path]);
    if (storageError) {
      // The metadata is already gone (correct, user-visible state) — a
      // Storage cleanup failure is logged, not surfaced as a delete
      // failure, and never pretends the object is gone when it isn't.
      console.error("[files-store] deleteFile: storage object removal failed (metadata already removed):", storageError);
    } else {
      signedUrlCache.delete(path);
    }
  }

  return { ok: true };
}
