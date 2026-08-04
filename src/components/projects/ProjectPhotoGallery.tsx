// src/components/projects/ProjectPhotoGallery.tsx
//
// Phase 13.3A — Project → Photos. Replaces the previous inline
// upload/grid/lightbox block in projects.index.tsx with a real gallery:
// categories, phase/Daily Log linkage, cover photo, customer/field
// visibility, and a richer lightbox. Operates on the extended
// project_files table via src/lib/project-photos.ts — see that file and
// the migration header for why this isn't a separate project_photos table.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, ChevronLeft, ChevronRight, Download, Image as ImageIcon, Loader2, MoreHorizontal, Star, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";

import { cn } from "@/lib/utils";
import type { ProjectPhase } from "@/lib/project-planning";
import { VisibilityBadge } from "@/components/projects/VisibilityBadge";
import {
  fetchProjectPhotos, uploadProjectPhoto, updatePhotoDetails, setCoverPhoto, deleteProjectPhoto, getPhotoUrl,
  PHOTO_CATEGORY_ORDER, PHOTO_CATEGORY_LABELS, MAX_PHOTO_BYTES,
  type ProjectPhoto, type PhotoCategory,
} from "@/lib/project-photos";

export function ProjectPhotoGallery({ projectId, phases }: { projectId: string; phases: ProjectPhase[] }) {
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<ProjectPhoto | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<"all" | PhotoCategory>("all");
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    const { photos: rows } = await fetchProjectPhotos(projectId);
    setPhotos(rows);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [projectId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return photos.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (phaseFilter !== "all" && p.phaseId !== phaseFilter) return false;
      if (!q) return true;
      return (p.caption ?? "").toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q);
    });
  }, [photos, categoryFilter, phaseFilter, search]);

  const phasesById = useMemo(() => new Map(phases.map((p) => [p.id, p])), [phases]);

  const handleUploaded = (newPhotos: ProjectPhoto[]) => {
    setPhotos((prev) => [...newPhotos, ...prev]);
  };

  const handleSetCover = async (photo: ProjectPhoto) => {
    const { error } = await setCoverPhoto(projectId, photo.id);
    if (error) { toast.error("Could not set cover photo", { description: error }); return; }
    setPhotos((prev) => prev.map((p) => ({ ...p, isCover: p.id === photo.id })));
    toast.success("Cover photo updated");
  };

  const handleDelete = async (photo: ProjectPhoto) => {
    if (!window.confirm("Delete this photo? This cannot be undone.")) return;
    const { error } = await deleteProjectPhoto(photo);
    if (error) { toast.error("Could not delete photo", { description: error }); return; }
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setLightboxIndex(null);
    toast.success("Photo deleted");
  };

  const handleUpdateDetails = async (id: string, patch: Parameters<typeof updatePhotoDetails>[1]) => {
    const { photo, error } = await updatePhotoDetails(id, patch);
    if (error || !photo) { toast.error("Could not update photo", { description: error ?? undefined }); return; }
    setPhotos((prev) => prev.map((p) => (p.id === id ? photo : p)));
    toast.success("Photo updated");
    setEditingPhoto(null);
  };

  const hasActiveFilters = categoryFilter !== "all" || phaseFilter !== "all" || search.trim() !== "";

  return (
    <div role="tabpanel" id="project-panel-photos" aria-labelledby="project-tab-photos" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Project Photos</h3>
          <p className="text-xs text-muted-foreground">Organize before, progress, issue, inspection, and completion photos.</p>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setUploadOpen(true)}>
          <Camera className="h-3.5 w-3.5" /> Upload Photos
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search caption or file name…" className="h-8 min-w-40 flex-1 text-xs" />
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as typeof categoryFilter)}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {PHOTO_CATEGORY_ORDER.map((c) => <SelectItem key={c} value={c}>{PHOTO_CATEGORY_LABELS[c]}</SelectItem>)}
          </SelectContent>
        </Select>
        {phases.length > 0 && (
          <Select value={phaseFilter} onValueChange={setPhaseFilter}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All phases</SelectItem>
              {phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {hasActiveFilters && (
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setCategoryFilter("all"); setPhaseFilter("all"); setSearch(""); }}>Clear Filters</Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} photo{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-14 text-center cursor-pointer hover:bg-secondary/20 transition" onClick={() => (photos.length === 0 ? setUploadOpen(true) : undefined)}>
          <ImageIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">{photos.length === 0 ? "No Project photos yet" : "No records match these filters"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{photos.length === 0 ? "Upload before, progress, issue, inspection, and completion photos." : ""}</p>
          {photos.length === 0 ? (
            <Button size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={(e) => { e.stopPropagation(); setUploadOpen(true); }}>Upload Photos</Button>
          ) : (
            <Button size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={(e) => { e.stopPropagation(); setCategoryFilter("all"); setPhaseFilter("all"); setSearch(""); }}>Clear Filters</Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {filtered.map((photo, i) => (
            <ProjectPhotoCard
              key={photo.id} photo={photo} phaseName={photo.phaseId ? phasesById.get(photo.phaseId)?.name : undefined}
              onView={() => setLightboxIndex(i)} onEdit={() => setEditingPhoto(photo)}
              onSetCover={() => void handleSetCover(photo)} onDelete={() => void handleDelete(photo)}
            />
          ))}
        </div>
      )}

      <ProjectPhotoUploadDialog open={uploadOpen} projectId={projectId} phases={phases} onClose={() => setUploadOpen(false)} onUploaded={handleUploaded} />

      {editingPhoto && (
        <PhotoDetailsDialog photo={editingPhoto} phases={phases} onClose={() => setEditingPhoto(null)} onSave={(patch) => void handleUpdateDetails(editingPhoto.id, patch)} />
      )}

      {lightboxIndex !== null && filtered[lightboxIndex] && (
        <ProjectPhotoLightbox
          photos={filtered} index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onEdit={(p) => { setLightboxIndex(null); setEditingPhoto(p); }}
          onDelete={(p) => void handleDelete(p)}
        />
      )}
    </div>
  );
}

function ProjectPhotoCard({
  photo, phaseName, onView, onEdit, onSetCover, onDelete,
}: {
  photo: ProjectPhoto; phaseName?: string;
  onView: () => void; onEdit: () => void; onSetCover: () => void; onDelete: () => void;
}) {
  const url = getPhotoUrl(photo);
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-secondary">
      <button
        type="button" onClick={onView}
        className="block aspect-square w-full cursor-pointer"
        aria-label={`View photo${photo.caption ? `: ${photo.caption}` : ""}`}
      >
        <img
          src={url} alt={photo.caption || photo.fileName}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent p-2 pt-6">
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="h-4.5 rounded border-white/30 bg-black/40 px-1.5 text-[9.5px] text-white">{PHOTO_CATEGORY_LABELS[photo.category]}</Badge>
          {photo.isCover && <Badge variant="outline" className="h-4.5 gap-0.5 rounded border-amber-300/50 bg-amber-500/40 px-1.5 text-[9.5px] text-white"><Star className="h-2.5 w-2.5 fill-current" />Cover</Badge>}
        </div>
        {(photo.caption || phaseName) && <p className="mt-1 truncate text-[10px] text-white">{photo.caption || phaseName}</p>}
      </div>
      <div className="absolute right-1.5 top-1.5 opacity-0 transition group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full bg-black/60 text-white hover:bg-black/80" aria-label="Photo actions">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onView}>View</DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>Edit details</DropdownMenuItem>
            {!photo.isCover && <DropdownMenuItem onClick={onSetCover}>Set as cover</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>Download</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

type BatchDefaults = { category: PhotoCategory; phaseId: string; isCustomerVisible: boolean; isFieldVisible: boolean };

function ProjectPhotoUploadDialog({
  open, projectId, phases, onClose, onUploaded,
}: {
  open: boolean; projectId: string; phases: ProjectPhase[];
  onClose: () => void; onUploaded: (photos: ProjectPhoto[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [defaults, setDefaults] = useState<BatchDefaults>({ category: "progress", phaseId: "none", isCustomerVisible: false, isFieldVisible: true });
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setUploading(true);
    setProgress({ done: 0, total: files.length });
    const uploaded: ProjectPhoto[] = [];
    let failures = 0;
    for (const file of files) {
      const { photo, error } = await uploadProjectPhoto({
        projectId, file, category: defaults.category,
        phaseId: defaults.phaseId === "none" ? null : defaults.phaseId,
        isCustomerVisible: defaults.isCustomerVisible, isFieldVisible: defaults.isFieldVisible,
      });
      if (error || !photo) { failures++; toast.error(error ?? `Could not upload ${file.name}`); }
      else uploaded.push(photo);
      setProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
    }
    setUploading(false);
    setProgress(null);
    if (uploaded.length > 0) {
      onUploaded(uploaded);
      toast.success(`${uploaded.length} photo${uploaded.length > 1 ? "s" : ""} uploaded${failures > 0 ? ` (${failures} failed)` : ""}`);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (uploaded.length > 0) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !uploading && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Photos</DialogTitle>
          <DialogDescription>JPEG, PNG, or WEBP · up to {Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB each. These defaults apply to every photo in this batch — edit any photo individually afterward.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={defaults.category} onValueChange={(v) => setDefaults((d) => ({ ...d, category: v as PhotoCategory }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PHOTO_CATEGORY_ORDER.map((c) => <SelectItem key={c} value={c}>{PHOTO_CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {phases.length > 0 && (
              <div className="space-y-1.5">
                <Label>Phase</Label>
                <Select value={defaults.phaseId} onValueChange={(v) => setDefaults((d) => ({ ...d, phaseId: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No phase</SelectItem>
                    {phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={defaults.isFieldVisible} onCheckedChange={(v) => setDefaults((d) => ({ ...d, isFieldVisible: !!v }))} /> Field Visible
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={defaults.isCustomerVisible} onCheckedChange={(v) => setDefaults((d) => ({ ...d, isCustomerVisible: !!v }))} /> Customer Visible
            </label>
          </div>

          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
          <button
            type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center hover:bg-secondary/20 disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Uploading {progress?.done ?? 0} of {progress?.total ?? 0}…</p>
              </>
            ) : (
              <>
                <Camera className="h-6 w-6 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">Click to choose photos</p>
              </>
            )}
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={uploading}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhotoDetailsDialog({
  photo, phases, onClose, onSave,
}: {
  photo: ProjectPhoto; phases: ProjectPhase[];
  onClose: () => void; onSave: (patch: Parameters<typeof updatePhotoDetails>[1]) => void;
}) {
  const [caption, setCaption] = useState(photo.caption ?? "");
  const [category, setCategory] = useState<PhotoCategory>(photo.category);
  const [phaseId, setPhaseId] = useState(photo.phaseId ?? "none");
  const [isCustomerVisible, setIsCustomerVisible] = useState(photo.isCustomerVisible);
  const [isFieldVisible, setIsFieldVisible] = useState(photo.isFieldVisible);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit Photo</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <img src={getPhotoUrl(photo)} alt={photo.caption || photo.fileName} className="max-h-48 w-full rounded-lg object-cover" />
          <div className="space-y-1.5">
            <Label>Caption</Label>
            <Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Optional caption" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as PhotoCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PHOTO_CATEGORY_ORDER.map((c) => <SelectItem key={c} value={c}>{PHOTO_CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {phases.length > 0 && (
              <div className="space-y-1.5">
                <Label>Phase</Label>
                <Select value={phaseId} onValueChange={setPhaseId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No phase</SelectItem>
                    {phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={isFieldVisible} onCheckedChange={(v) => setIsFieldVisible(!!v)} /> Field Visible
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={isCustomerVisible} onCheckedChange={(v) => setIsCustomerVisible(!!v)} /> Customer Visible
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ caption: caption || null, category, phaseId: phaseId === "none" ? null : phaseId, isCustomerVisible, isFieldVisible })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectPhotoLightbox({
  photos, index, onClose, onNavigate, onEdit, onDelete,
}: {
  photos: ProjectPhoto[]; index: number;
  onClose: () => void; onNavigate: (i: number) => void;
  onEdit: (photo: ProjectPhoto) => void; onDelete: (photo: ProjectPhoto) => void;
}) {
  const photo = photos[index];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && index < photos.length - 1) onNavigate(index + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, photos.length, onClose, onNavigate]);

  if (!photo) return null;
  const url = getPhotoUrl(photo);

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Photo: ${photo.caption || photo.fileName}`}>
      <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={onClose} aria-label="Close">
        <X className="h-5 w-5" />
      </button>
      {index > 0 && (
        <button className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }} aria-label="Previous photo">
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {index < photos.length - 1 && (
        <button className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }} aria-label="Next photo">
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
      <div className="flex max-h-[90vh] max-w-4xl flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <img src={url} alt={photo.caption || photo.fileName} className="max-h-[70vh] max-w-full rounded-xl object-contain shadow-2xl" />
        <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg bg-black/40 px-3 py-2 text-white">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{photo.caption || photo.fileName}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-white/70">
              <span>{PHOTO_CATEGORY_LABELS[photo.category]}</span>
              <VisibilityBadge isCustomerVisible={photo.isCustomerVisible} isFieldVisible={photo.isFieldVisible} />
              <span>{index + 1} of {photos.length}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onEdit(photo)}>Edit</Button>
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
              <Download className="h-3 w-3" /> Download
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => onDelete(photo)}>Delete</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
