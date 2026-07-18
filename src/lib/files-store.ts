// src/lib/files-store.ts
// Supabase-backed document store for the Files module.
// Maintains the same exported API as the original localStorage version.
import { useSyncExternalStore, useEffect } from "react";
import { supabase } from "@/lib/supabase";

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

// ── Org ID helper ─────────────────────────────────────────────────────────────

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

// ── In-memory store (synced with Supabase) ────────────────────────────────────

let _files: FileRecord[] = [];
let _loaded = false;
// In-memory overrides for fields not in DB (starred, shareLinks)
const _starred = new Set<string>();
const _shareLinks = new Map<string, ShareLink[]>();

const _listeners = new Set<() => void>();

function emit() { _listeners.forEach(l => l()); }

async function fetchFiles() {
  const orgId = await getOrgId();
  if (!orgId) { _loaded = true; emit(); return; }

  const { data, error } = await supabase
    .from("project_files")
    .select(`
      *,
      projects!project_id(name),
      uploader:profiles!uploaded_by(first_name, last_name)
    `)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) { console.error("[files-store]", error); _loaded = true; emit(); return; }

  _files = (data ?? []).map((row: any): FileRecord => {
    const uploaderName = row.uploader
      ? `${row.uploader.first_name ?? ""} ${row.uploader.last_name ?? ""}`.trim() || "Unknown"
      : "Unknown";

    const sizeStr = row.file_size ? formatBytes(Number(row.file_size)) : "—";
    const ext = inferExt(row.file_name ?? "");
    const category = mimeToCategory(row.mime_type, row.file_type, row.file_name ?? "");

    // Build file URL from storage path
    let url: string | undefined;
    if (row.file_path) {
      const { data: urlData } = supabase.storage.from("project-files").getPublicUrl(row.file_path);
      url = urlData?.publicUrl;
    }

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
      starred: _starred.has(row.id),
      shared: false,
      versions: [{
        id: `${row.id}-v${row.version ?? 1}`,
        version: row.version ?? 1,
        uploaded: row.created_at,
        uploadedBy: uploaderName,
        size: sizeStr,
      }],
      shareLinks: _shareLinks.get(row.id) ?? [],
      activity: [{
        id: `${row.id}-upload`,
        at: row.created_at,
        who: uploaderName,
        action: "uploaded",
      }],
      url,
      ext,
    };
  });

  _loaded = true;
  emit();
}

void fetchFiles();

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useFiles(): FileRecord[] {
  useEffect(() => { if (!_loaded) void fetchFiles(); }, []);
  return useSyncExternalStore(
    cb => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _files,
    () => [],
  );
}

export function useFilesLoading(): boolean { return !_loaded; }

export async function refreshFiles() { await fetchFiles(); }

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addFile(params: { name: string; size: number; projectId?: string; url?: string }) {
  const orgId = await getOrgId();
  const { data: { user } } = await supabase.auth.getUser();
  if (!orgId || !user) return;

  const ext = inferExt(params.name);
  const mimeGuess = ext === "pdf" ? "application/pdf" : ext.match(/png|jpg|jpeg|gif|webp/) ? `image/${ext}` : "application/octet-stream";

  // If we have a real file URL/blob, we'd upload to storage here
  // For now, insert a row with metadata
  const { error } = await supabase.from("project_files").insert({
    org_id: orgId,
    project_id: params.projectId ?? null,
    file_name: params.name,
    file_path: params.url ?? params.name,
    file_size: params.size,
    mime_type: mimeGuess,
    uploaded_by: user.id,
    version: 1,
  });

  if (error) { console.error("[files-store] addFile failed:", error); return; }
  await fetchFiles();
}

export async function renameFile(id: string, newName: string) {
  await supabase.from("project_files").update({ file_name: newName }).eq("id", id);
  _files = _files.map(f => f.id === id ? { ...f, name: newName } : f);
  emit();
}

export async function moveFile(id: string, projectId: string | undefined) {
  await supabase.from("project_files").update({ project_id: projectId ?? null }).eq("id", id);
  await fetchFiles();
}

export async function setCategory(id: string, category: FileCategory) {
  await supabase.from("project_files").update({ file_type: category.toLowerCase() }).eq("id", id);
  _files = _files.map(f => f.id === id ? { ...f, category } : f);
  emit();
}

export function toggleStar(id: string) {
  if (_starred.has(id)) _starred.delete(id);
  else _starred.add(id);
  _files = _files.map(f => f.id === id ? { ...f, starred: _starred.has(id) } : f);
  emit();
}

export async function setTags(id: string, tags: string[]) {
  await supabase.from("project_files").update({ tags }).eq("id", id);
  _files = _files.map(f => f.id === id ? { ...f, tags } : f);
  emit();
}

export async function addVersion(id: string, params: { size: number; note?: string }) {
  const file = _files.find(f => f.id === id);
  if (!file) return;
  const nextVer = (file.versions[0]?.version ?? 0) + 1;
  await supabase.from("project_files").update({ version: nextVer }).eq("id", id);
  const newVer: FileVersion = {
    id: `${id}-v${nextVer}`,
    version: nextVer,
    uploaded: new Date().toISOString(),
    uploadedBy: "You",
    size: formatBytes(params.size),
    note: params.note,
  };
  _files = _files.map(f => f.id === id
    ? { ...f, versions: [newVer, ...f.versions] }
    : f
  );
  emit();
}

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
  _files = _files.map(f => f.id === id ? { ...f, shareLinks: _shareLinks.get(id) ?? [], shared: true } : f);
  emit();
}

export function revokeShareLink(fileId: string, linkId: string) {
  const links = (_shareLinks.get(fileId) ?? []).map(l => l.id === linkId ? { ...l, revoked: true } : l);
  _shareLinks.set(fileId, links);
  _files = _files.map(f => f.id === fileId ? { ...f, shareLinks: links } : f);
  emit();
}

export async function deleteFile(id: string) {
  await supabase.from("project_files").delete().eq("id", id);
  _files = _files.filter(f => f.id !== id);
  emit();
}