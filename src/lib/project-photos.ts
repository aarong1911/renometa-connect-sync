// src/lib/project-photos.ts
//
// Phase 13.3A — Project Execution foundation. Domain layer for Project
// photos. Deliberately operates on the EXISTING public.project_files
// table (extended additively by
// supabase/migrations/20260813_project_execution_daily_logs_photos.sql)
// rather than a new project_photos table — see that migration's header
// comment for the full reasoning. The existing "project-photos" Storage
// bucket (public) and `{projectId}/{timestamp}-{rand}.{ext}` object-path
// convention are reused unchanged from the working upload flow already in
// src/routes/projects.index.tsx.
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
};

const PHOTOS_BUCKET = "project-photos";
/** Same filter the pre-existing Photos tab already used — project_files also stores non-image documents, this narrows to images only. */
const IMAGE_FILTER = "mime_type.ilike.image/%,file_type.eq.image";

function mapRow(row: any): ProjectPhoto {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id ?? null,
    dailyLogId: row.daily_log_id ?? null,
    taskId: row.task_id ?? null,
    milestoneId: row.milestone_id ?? null,
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

/** Public bucket — same convention the existing Photos tab already used (no signed-URL infrastructure exists elsewhere in this codebase for this bucket; see migration header). */
export function getPhotoUrl(photo: Pick<ProjectPhoto, "storagePath">): string {
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(photo.storagePath);
  return data.publicUrl;
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
  return { photos: (data ?? []).map(mapRow), error: null };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
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
 * Uploads one photo: Storage first, then the project_files row. If the DB
 * insert fails after a successful Storage upload, the orphaned Storage
 * object is removed (Part 8/40) so a failed upload never leaves a
 * dangling file with no record. Storage failure never creates a DB row.
 */
export async function uploadProjectPhoto(input: UploadPhotoInput): Promise<{ photo?: ProjectPhoto; error: string | null }> {
  const { file } = input;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { error: `${file.name}: unsupported file type (${file.type || "unknown"}). Use JPEG, PNG, or WEBP.` };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { error: `${file.name}: file is too large (max ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB).` };
  }

  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };
  const { data: { user } } = await supabase.auth.getUser();

  const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
  const path = `${input.projectId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${sanitizeFileName(file.name)}.${ext}`;

  const { error: uploadError } = await supabase.storage.from(PHOTOS_BUCKET).upload(path, file, { contentType: file.type });
  if (uploadError) {
    console.error("[project-photos] storage upload failed:", uploadError);
    return { error: `${file.name}: upload failed (${uploadError.message})` };
  }

  const dimensions = await readImageDimensions(file).catch(() => null);

  const { data, error: dbError } = await supabase
    .from("project_files")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      file_name: file.name,
      file_path: path,
      file_type: "image",
      mime_type: file.type,
      file_size: file.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      category: input.category ?? "progress",
      caption: input.caption?.trim() || null,
      phase_id: input.phaseId ?? null,
      daily_log_id: input.dailyLogId ?? null,
      task_id: input.taskId ?? null,
      milestone_id: input.milestoneId ?? null,
      taken_at: input.takenAt ?? null,
      is_customer_visible: input.isCustomerVisible ?? false,
      is_field_visible: input.isFieldVisible ?? true,
      source: "connect",
      uploaded_by: user?.id ?? null,
    })
    .select("*")
    .single();

  if (dbError || !data) {
    // Clean up the orphaned Storage object — a failed DB insert must never leave an unreferenced file behind.
    await supabase.storage.from(PHOTOS_BUCKET).remove([path]);
    console.error("[project-photos] db insert failed, storage object removed:", dbError);
    return { error: `${file.name}: could not save photo details` };
  }
  return { photo: mapRow(data), error: null };
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
  return { photo: mapRow(data), error: null };
}

/**
 * Best-effort two-step cover swap (Part 22): clear any existing cover for
 * the Project, then set the new one. The database's partial unique index
 * (idx_project_files_one_cover_per_project) is the actual guarantee — this
 * is not a single atomic transaction from the browser, but the index makes
 * "two covers at once" impossible even if this sequence is interrupted; a
 * true RPC-wrapped transaction is deferred as unnecessary for this phase.
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

/** Deletes the Storage object first, then the DB row — if Storage deletion fails, the DB row is intentionally left in place (better an orphaned-but-visible record than a DB row pointing at nothing) and the caller should surface a retry rather than silently removing it from the UI (Part 41). */
export async function deleteProjectPhoto(photo: Pick<ProjectPhoto, "id" | "storagePath">): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage.from(PHOTOS_BUCKET).remove([photo.storagePath]);
  if (storageError) {
    console.error("[project-photos] storage delete failed:", storageError);
    return { error: `Could not remove the stored file (${storageError.message}). Try again.` };
  }
  const { error: dbError } = await supabase.from("project_files").delete().eq("id", photo.id);
  if (dbError) {
    console.error("[project-photos] db delete failed after storage delete:", dbError);
    return { error: "Photo file was removed but the record could not be deleted. Refresh and try again." };
  }
  return { error: null };
}

// ── Field/Portal-ready projections (Part 25/26/27) ───────────────────────

export type FieldProjectPhoto = {
  id: string; projectId: string; url: string; caption: string | null; category: PhotoCategory;
  phaseId: string | null; takenAt: string | null;
};

export function toFieldProjectPhoto(photo: ProjectPhoto): FieldProjectPhoto | null {
  if (!photo.isFieldVisible) return null;
  return {
    id: photo.id, projectId: photo.projectId, url: getPhotoUrl(photo), caption: photo.caption,
    category: photo.category, phaseId: photo.phaseId, takenAt: photo.takenAt,
  };
}

export type PortalProjectPhoto = {
  id: string; caption: string | null; category: PhotoCategory; url: string; takenAt: string | null;
};

/** No internal metadata (uploader, storage path, linkage ids) — see Part 26. */
export function toPortalProjectPhoto(photo: ProjectPhoto): PortalProjectPhoto | null {
  if (!photo.isCustomerVisible) return null;
  return { id: photo.id, caption: photo.caption, category: photo.category, url: getPhotoUrl(photo), takenAt: photo.takenAt };
}
