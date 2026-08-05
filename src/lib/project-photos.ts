// src/lib/project-photos.ts
//
// Phase 13.3A - Project Execution foundation. Domain layer for Project
// photos. Operates on the EXISTING public.project_files table (extended
// additively by supabase/migrations/20260813_project_execution_daily_logs_photos.sql)
// rather than a new project_photos table - see that migration's header
// comment for the full reasoning.
//
// Phase 13.3B (this pass) - private storage hardening. New uploads go to
// the private "project-media" bucket under an org/project/photo-scoped
// path and render through short-lived signed URLs. Legacy rows
// (storage_bucket = "project-photos") keep rendering through their
// existing public URL - that bucket stays public and untouched in this
// pass; see supabase/migrations/20260814_secure_project_media.sql. Every
// photo row now carries its own storage_bucket, so the two families can
// coexist in the same gallery without any component needing to guess
// which one it is looking at.
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";

export type PhotoCategory =
  | "before" | "progress" | "issue" | "delivery" | "inspection" | "completion" | "after" | "document" | "other";

export const PHOTO_CATEGORY_ORDER: PhotoCategory[] = [
  "before", "progress", "issue", "delivery", "inspection", "completion", "after", "document", "other",
];

export const PHOTO_CATEGORY_LABELS: Record<PhotoCategory, string> = {
  before: "Before", progress: "Progress", issue: "Issue", delivery: "Delivery",
  inspection: "Inspection", completion: "Completion", after: "After", document: "Document", other: "Other",
};

export type ProjectExecutionSource = "connect" | "field" | "portal" | "automation" | "import";

export type ProjectPhoto = {
  id: string;
  projectId: string;
  phaseId: string | null;
  dailyLogId: string | null;
  taskId: string | null;
  milestoneId: string | null;
  /** "project-media" (new, private) or "project-photos" (legacy, public). Never assume one or the other - always read this field. */
  storageBucket: string;
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  category: PhotoCategory;
  caption: string | null;
  takenAt: string | null;
  position: number;
  isCover: boolean;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
  source: ProjectExecutionSource;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Presentation-only, resolved by this module - never persisted.
   * null while unresolved/failed; components render a placeholder/retry
   * state rather than reaching into Storage themselves (Part 12).
   */
  resolvedUrl: string | null;
  /** Epoch ms - only meaningful for project-media (signed) URLs; null for legacy public URLs, which do not expire. */
  urlExpiresAt: number | null;
};

/** New uploads always go here - private, org/project/photo-scoped path, signed URLs only. */
export const PRIVATE_PROJECT_MEDIA_BUCKET = "project-media";
/** Legacy bucket - still public in this phase. Existing rows only; never written to by new uploads. */
export const LEGACY_PROJECT_PHOTO_BUCKET = "project-photos";
/** One hour - matches the "reasonable default" the app has no prior convention for. Refreshed 5 minutes before expiry (see REFRESH_MARGIN_MS below). */
export const PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Same filter the original Photos tab used - project_files also stores non-image documents, this narrows to images only. */
const IMAGE_FILTER = "mime_type.ilike.image/%,file_type.eq.image";

type RawPhotoRow = Record<string, any>;

function mapRow(row: RawPhotoRow): Omit<ProjectPhoto, "resolvedUrl" | "urlExpiresAt"> {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id ?? null,
    dailyLogId: row.daily_log_id ?? null,
    taskId: row.task_id ?? null,
    milestoneId: row.milestone_id ?? null,
    // Defensive fallback only - never written back to the row on read (Part 3).
    storageBucket: row.storage_bucket ?? LEGACY_PROJECT_PHOTO_BUCKET,
    storagePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type ?? null,
    fileSize: row.file_size ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    category: (row.category as PhotoCategory) ?? "other",
    caption: row.caption ?? null,
    takenAt: row.taken_at ?? null,
    position: row.position ?? 0,
    isCover: !!row.is_cover,
    isCustomerVisible: !!row.is_customer_visible,
    isFieldVisible: row.is_field_visible !== false,
    source: (row.source as ProjectExecutionSource) ?? "connect",
    uploadedBy: row.uploaded_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

// -- Signed URL cache (Part 9/10) ------------------------------------------
// Simple in-memory cache, keyed by bucket:path. Never persisted (not
// localStorage, not the database) - signed URLs are transient presentation
// values only. A failed signed-url request is simply not cached; it never
// poisons a previously-good cached entry.
type SignedUrlCacheEntry = { url: string; expiresAt: number };
const signedUrlCache = new Map<string, SignedUrlCacheEntry>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function cacheKey(bucket: string, path: string): string {
  return bucket + ":" + path;
}

function getCachedUrl(bucket: string, path: string): string | null {
  const entry = signedUrlCache.get(cacheKey(bucket, path));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt - REFRESH_MARGIN_MS) {
    signedUrlCache.delete(cacheKey(bucket, path));
    return null;
  }
  return entry.url;
}

function setCachedUrl(bucket: string, path: string, url: string, ttlSeconds: number): void {
  signedUrlCache.set(cacheKey(bucket, path), { url, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** Clears any cached signed URL - called on delete and on any path/bucket change (Part 10). */
export function clearPhotoUrlCache(bucket: string, path: string): void {
  signedUrlCache.delete(cacheKey(bucket, path));
}

/**
 * Canonical single-photo URL resolver (Part 8). project-media -> signed URL
 * (cached, auto-refreshed near expiry). project-photos (legacy) -> public
 * URL, unchanged behavior. Any other/unknown bucket value never falls back
 * to a public URL - it fails safe and returns null.
 */
export async function resolveProjectPhotoUrl(
  photo: Pick<ProjectPhoto, "storageBucket" | "storagePath">,
  opts?: { forceRefresh?: boolean },
): Promise<{ url: string | null; expiresAt: number | null }> {
  if (photo.storageBucket === LEGACY_PROJECT_PHOTO_BUCKET) {
    const { data } = supabase.storage.from(LEGACY_PROJECT_PHOTO_BUCKET).getPublicUrl(photo.storagePath);
    return { url: data.publicUrl, expiresAt: null };
  }

  if (photo.storageBucket === PRIVATE_PROJECT_MEDIA_BUCKET) {
    if (!opts?.forceRefresh) {
      const cached = getCachedUrl(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath);
      if (cached) {
        const entry = signedUrlCache.get(cacheKey(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath));
        return { url: cached, expiresAt: entry ? entry.expiresAt : null };
      }
    }
    const { data, error } = await supabase.storage
      .from(PRIVATE_PROJECT_MEDIA_BUCKET)
      .createSignedUrl(photo.storagePath, PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS);
    if (error || !data || !data.signedUrl) {
      console.error("[project-photos] createSignedUrl failed:", error);
      return { url: null, expiresAt: null };
    }
    setCachedUrl(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath, data.signedUrl, PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS);
    return { url: data.signedUrl, expiresAt: Date.now() + PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS * 1000 };
  }

  // Unknown bucket - never guess public. Fails safe.
  console.error('[project-photos] unrecognized storage bucket "' + photo.storageBucket + '" - refusing to resolve a URL');
  return { url: null, expiresAt: null };
}

/**
 * Batch resolver (Part 9) - one createSignedUrls() call for every
 * not-yet-cached project-media photo in the set, instead of one network
 * request per image per render. Legacy public URLs are synchronous/free
 * (getPublicUrl does not hit the network) and are resolved inline.
 */
async function resolvePhotoUrls<T extends Pick<ProjectPhoto, "id" | "storageBucket" | "storagePath">>(
  photos: T[],
): Promise<Map<string, { url: string | null; expiresAt: number | null }>> {
  const result = new Map<string, { url: string | null; expiresAt: number | null }>();
  const pendingPrivatePaths: string[] = [];

  for (const photo of photos) {
    if (photo.storageBucket === LEGACY_PROJECT_PHOTO_BUCKET) {
      const { data } = supabase.storage.from(LEGACY_PROJECT_PHOTO_BUCKET).getPublicUrl(photo.storagePath);
      result.set(photo.id, { url: data.publicUrl, expiresAt: null });
    } else if (photo.storageBucket === PRIVATE_PROJECT_MEDIA_BUCKET) {
      const cached = getCachedUrl(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath);
      if (cached) {
        const entry = signedUrlCache.get(cacheKey(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath));
        result.set(photo.id, { url: cached, expiresAt: entry ? entry.expiresAt : null });
      } else {
        pendingPrivatePaths.push(photo.storagePath);
      }
    } else {
      result.set(photo.id, { url: null, expiresAt: null });
    }
  }

  if (pendingPrivatePaths.length > 0) {
    const { data, error } = await supabase.storage
      .from(PRIVATE_PROJECT_MEDIA_BUCKET)
      .createSignedUrls(pendingPrivatePaths, PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS);
    if (error) {
      console.error("[project-photos] createSignedUrls batch failed:", error);
    } else {
      for (const entry of data ?? []) {
        if (entry.signedUrl && !entry.error) {
          setCachedUrl(PRIVATE_PROJECT_MEDIA_BUCKET, entry.path ?? "", entry.signedUrl, PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS);
        }
      }
    }
    for (const photo of photos) {
      if (photo.storageBucket === PRIVATE_PROJECT_MEDIA_BUCKET && !result.has(photo.id)) {
        const cached = getCachedUrl(PRIVATE_PROJECT_MEDIA_BUCKET, photo.storagePath);
        result.set(photo.id, { url: cached, expiresAt: cached ? Date.now() + PROJECT_MEDIA_SIGNED_URL_TTL_SECONDS * 1000 : null });
      }
    }
  }

  return result;
}

async function attachResolvedUrls(rows: Omit<ProjectPhoto, "resolvedUrl" | "urlExpiresAt">[]): Promise<ProjectPhoto[]> {
  const resolved = await resolvePhotoUrls(rows);
  return rows.map((row) => {
    const r = resolved.get(row.id);
    return { ...row, resolvedUrl: r ? r.url : null, urlExpiresAt: r ? r.expiresAt : null };
  });
}

/** Forces a fresh URL for one photo and updates the cache - used by the lightbox's near-expiry check and by download (Part 13/14). */
export async function refreshPhotoUrl(photo: Pick<ProjectPhoto, "storageBucket" | "storagePath">): Promise<{ url: string | null; expiresAt: number | null }> {
  return resolveProjectPhotoUrl(photo, { forceRefresh: true });
}

export async function fetchProjectPhotos(projectId: string): Promise<{ photos: ProjectPhoto[]; error: string | null }> {
  const { data, error } = await supabase
    .from("project_files")
    .select("*")
    .eq("project_id", projectId)
    .or(IMAGE_FILTER)
    .order("position", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[project-photos] fetchProjectPhotos failed:", error);
    return { photos: [], error: error.message };
  }
  const rows = (data ?? []).map(mapRow);
  return { photos: await attachResolvedUrls(rows), error: null };
}

// -- Safe path/filename construction (Part 4) ------------------------------

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};

const MIN_PRINTABLE_CODE_POINT = 32;
const DEL_CODE_POINT = 127;

/** Removes ASCII control characters (below 0x20, plus DEL) without relying on a regex control-character class. */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= MIN_PRINTABLE_CODE_POINT && code !== DEL_CODE_POINT) out += ch;
  }
  return out;
}

/** Strips path separators/control characters, collapses whitespace, and guarantees a non-empty, extension-preserving result. */
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

  const ext = rawExt || MIME_EXTENSION[mimeType] || "jpg";
  return (cleanedName || "photo") + "." + ext;
}

/** organizations/{orgId}/projects/{projectId}/photos/{photoId}/{safeFileName} - the photoId folder guarantees no collision even if two uploads share a sanitized file name. */
function buildPrivatePhotoPath(orgId: string, projectId: string, photoId: string, safeFileName: string): string {
  return "organizations/" + orgId + "/projects/" + projectId + "/photos/" + photoId + "/" + safeFileName;
}

export type UploadPhotoInput = {
  projectId: string;
  file: File;
  category?: PhotoCategory;
  caption?: string | null;
  phaseId?: string | null;
  dailyLogId?: string | null;
  taskId?: string | null;
  milestoneId?: string | null;
  takenAt?: string | null;
  isCustomerVisible?: boolean;
  isFieldVisible?: boolean;
};

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Reuses the existing application-wide upload ceiling rather than inventing a new one. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/**
 * Uploads one photo - always to the private project-media bucket, under
 * organizations/{orgId}/projects/{projectId}/photos/{photoId}/{safeFileName}
 * (Part 4/6). Order: validate -> generate photoId -> build safe path ->
 * upload to Storage -> read dimensions -> insert the project_files row
 * (reusing the same photoId as its primary key) -> resolve a signed URL ->
 * return the complete model. If the DB insert fails after a successful
 * Storage upload, the orphaned project-media object is removed so a
 * failed upload never leaves a dangling file with no record; Storage
 * failure never creates a DB row.
 */
export async function uploadProjectPhoto(input: UploadPhotoInput): Promise<{ photo?: ProjectPhoto; error: string | null }> {
  const { file } = input;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { error: file.name + ": unsupported file type (" + (file.type || "unknown") + "). Use JPEG, PNG, or WEBP." };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { error: file.name + ": file is too large (max " + Math.round(MAX_PHOTO_BYTES / (1024 * 1024)) + "MB)." };
  }

  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };
  const { data: { user } } = await supabase.auth.getUser();

  const photoId = crypto.randomUUID();
  const safeFileName = sanitizeFileName(file.name, file.type);
  const privatePath = buildPrivatePhotoPath(orgId, input.projectId, photoId, safeFileName);

  const { error: uploadError } = await supabase.storage
    .from(PRIVATE_PROJECT_MEDIA_BUCKET)
    .upload(privatePath, file, { contentType: file.type });
  if (uploadError) {
    console.error("[project-photos] storage upload failed:", uploadError);
    return { error: file.name + ": upload failed (" + uploadError.message + ")" };
  }

  const dimensions = await readImageDimensions(file).catch(() => null);

  const { data, error: dbError } = await supabase
    .from("project_files")
    .insert({
      id: photoId,
      org_id: orgId,
      project_id: input.projectId,
      storage_bucket: PRIVATE_PROJECT_MEDIA_BUCKET,
      file_name: file.name,
      file_path: privatePath,
      file_type: "image",
      mime_type: file.type,
      file_size: file.size,
      width: dimensions ? dimensions.width : null,
      height: dimensions ? dimensions.height : null,
      category: input.category ?? "progress",
      caption: input.caption?.trim() || null,
      phase_id: input.phaseId ?? null,
      daily_log_id: input.dailyLogId ?? null,
      task_id: input.taskId ?? null,
      milestone_id: input.milestoneId ?? null,
      position: 0,
      is_cover: false,
      taken_at: input.takenAt ?? null,
      is_customer_visible: input.isCustomerVisible ?? false,
      is_field_visible: input.isFieldVisible ?? true,
      source: "connect",
      uploaded_by: user?.id ?? null,
    })
    .select("*")
    .single();

  if (dbError || !data) {
    // Clean up the orphaned Storage object - a failed DB insert must never leave an unreferenced file behind.
    const { error: cleanupError } = await supabase.storage.from(PRIVATE_PROJECT_MEDIA_BUCKET).remove([privatePath]);
    console.error("[project-photos] db insert failed, storage object removed:", dbError);
    if (cleanupError) {
      console.error("[project-photos] secondary cleanup also failed - orphaned object left in project-media:", privatePath, cleanupError);
      return { error: file.name + ": could not save photo details, and cleanup of the uploaded file also failed. It may need manual removal." };
    }
    return { error: file.name + ": could not save photo details" };
  }

  const mapped = mapRow(data);
  const resolved = await resolveProjectPhotoUrl(mapped);
  return { photo: { ...mapped, resolvedUrl: resolved.url, urlExpiresAt: resolved.expiresAt }, error: null };
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read image dimensions")); };
    img.src = url;
  });
}

export type UpdatePhotoInput = {
  category?: PhotoCategory;
  caption?: string | null;
  phaseId?: string | null;
  dailyLogId?: string | null;
  taskId?: string | null;
  milestoneId?: string | null;
  takenAt?: string | null;
  isCustomerVisible?: boolean;
  isFieldVisible?: boolean;
  position?: number;
};

/** Metadata-only - never touches Storage, never changes bucket/path, so the caller should keep the photo's existing resolvedUrl in UI state rather than re-resolving (Part 16). */
export async function updatePhotoDetails(id: string, patch: UpdatePhotoInput): Promise<{ photo?: ProjectPhoto; error: string | null }> {
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.caption !== undefined) update.caption = patch.caption?.trim() || null;
  if (patch.phaseId !== undefined) update.phase_id = patch.phaseId;
  if (patch.dailyLogId !== undefined) update.daily_log_id = patch.dailyLogId;
  if (patch.taskId !== undefined) update.task_id = patch.taskId;
  if (patch.milestoneId !== undefined) update.milestone_id = patch.milestoneId;
  if (patch.takenAt !== undefined) update.taken_at = patch.takenAt;
  if (patch.isCustomerVisible !== undefined) update.is_customer_visible = patch.isCustomerVisible;
  if (patch.isFieldVisible !== undefined) update.is_field_visible = patch.isFieldVisible;
  if (patch.position !== undefined) update.position = patch.position;

  const { data, error } = await supabase.from("project_files").update(update).eq("id", id).select("*").single();
  if (error || !data) {
    console.error("[project-photos] updatePhotoDetails failed:", error);
    return { error: error?.message ?? "Could not update photo" };
  }
  const mapped = mapRow(data);
  return { photo: { ...mapped, resolvedUrl: null, urlExpiresAt: null }, error: null };
}

/**
 * Best-effort two-step cover swap (Part 17): clear any existing cover for
 * the Project, then set the new one - works identically for a legacy
 * project-photos row or a new project-media row; cover status never
 * depends on bucket type. The database's partial unique index
 * (idx_project_files_one_cover_per_project) is the actual guarantee - this
 * is not a single atomic transaction from the browser, but the index makes
 * "two covers at once" impossible even if this sequence is interrupted.
 */
export async function setCoverPhoto(projectId: string, photoId: string): Promise<{ error: string | null }> {
  const { error: clearError } = await supabase
    .from("project_files").update({ is_cover: false }).eq("project_id", projectId).eq("is_cover", true);
  if (clearError) {
    console.error("[project-photos] setCoverPhoto clear failed:", clearError);
    return { error: clearError.message };
  }
  const { error: setError } = await supabase.from("project_files").update({ is_cover: true }).eq("id", photoId);
  if (setError) {
    console.error("[project-photos] setCoverPhoto set failed:", setError);
    return { error: setError.message };
  }
  return { error: null };
}

/**
 * Deletes from the row's own bucket (Part 15) - legacy rows delete from
 * project-photos, new rows from project-media; never hard-coded. If
 * Storage deletion fails, the DB row is intentionally left in place
 * (better an orphaned-but-visible record than a DB row pointing at
 * nothing) and the caller should surface a retry rather than silently
 * removing it from the UI.
 */
export async function deleteProjectPhoto(photo: Pick<ProjectPhoto, "id" | "storageBucket" | "storagePath">): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage.from(photo.storageBucket).remove([photo.storagePath]);
  if (storageError) {
    console.error("[project-photos] storage delete failed:", storageError);
    return { error: "Could not remove the stored file (" + storageError.message + "). Try again." };
  }
  const { error: dbError } = await supabase.from("project_files").delete().eq("id", photo.id);
  if (dbError) {
    console.error("[project-photos] db delete failed after storage delete:", dbError);
    return { error: "Photo file was removed but the record could not be deleted. Refresh and try again." };
  }
  clearPhotoUrlCache(photo.storageBucket, photo.storagePath);
  return { error: null };
}

// -- Field/Portal-ready projections (Part 25/26/27, Phase 13.3A) ----------
// Unused by any route today. Take an already-resolved photo (i.e. the
// result of fetchProjectPhotos/uploadProjectPhoto) rather than re-deriving
// a URL themselves - one resolver, reused everywhere (Part 18).

export type FieldProjectPhoto = {
  id: string; projectId: string; url: string | null; caption: string | null; category: PhotoCategory;
  phaseId: string | null; takenAt: string | null;
};

export function toFieldProjectPhoto(photo: ProjectPhoto): FieldProjectPhoto | null {
  if (!photo.isFieldVisible) return null;
  return {
    id: photo.id, projectId: photo.projectId, url: photo.resolvedUrl, caption: photo.caption,
    category: photo.category, phaseId: photo.phaseId, takenAt: photo.takenAt,
  };
}

export type PortalProjectPhoto = {
  id: string; caption: string | null; category: PhotoCategory; url: string | null; takenAt: string | null;
};

/** No internal metadata (uploader, storage path, linkage ids) - see Part 26. */
export function toPortalProjectPhoto(photo: ProjectPhoto): PortalProjectPhoto | null {
  if (!photo.isCustomerVisible) return null;
  return { id: photo.id, caption: photo.caption, category: photo.category, url: photo.resolvedUrl, takenAt: photo.takenAt };
}
