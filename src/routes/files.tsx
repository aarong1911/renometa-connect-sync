import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Search, Upload, FolderOpen, FileText, Image as ImageIcon, FileSpreadsheet,
  FileVideo, FileArchive, Presentation, Box, File as FileIcon,
  Download, Share2, MoreHorizontal, Star, Trash2, Pencil, FolderInput,
  Tag as TagIcon, Plus, X, Link2, Copy, Clock, ShieldCheck, History,
  HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import {
  useFiles, addFile, renameFile, moveFile, setCategory, toggleStar,
  setTags, addVersion, createShareLink, revokeShareLink, deleteFile,
  fileIcon, formatBytes, approxBytes,
  FILE_CATEGORIES, type FileCategory, type FileRecord,
} from "@/lib/files-store";
import { useProjects } from "@/lib/projects-store";
import { formatDate, formatDateShort } from "@/lib/format";
import { useTopbarAction } from "@/lib/topbar-action";

type FilesSearch = { fileId?: string };

export const Route = createFileRoute("/files")({
  validateSearch: (raw: Record<string, unknown>): FilesSearch => ({
    fileId: typeof raw.fileId === "string" ? raw.fileId : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Files — RenoMeta" },
      { name: "description", content: "Workspace document library: contracts, blueprints, permits, photos, and shared files." },
    ],
  }),
  component: FilesPage,
});

type FolderKey = "all" | "starred" | "recent" | "shared" | "workspace" | FileCategory;

const FOLDER_GROUPS: Array<{ label: string; items: Array<{ key: FolderKey; label: string; icon: React.ComponentType<{ className?: string }> }> }> = [
  {
    label: "Library",
    items: [
      { key: "all", label: "All files", icon: FolderOpen },
      { key: "recent", label: "Recent", icon: Clock },
      { key: "starred", label: "Starred", icon: Star },
      { key: "shared", label: "Shared", icon: Share2 },
      { key: "workspace", label: "Workspace", icon: Box },
    ],
  },
  {
    label: "Categories",
    items: [
      { key: "Contract", label: "Contracts", icon: ShieldCheck },
      { key: "Blueprint", label: "Blueprints", icon: Presentation },
      { key: "Permit", label: "Permits", icon: FileText },
      { key: "Photos", label: "Photos", icon: ImageIcon },
      { key: "Other", label: "Other", icon: FileIcon },
    ],
  },
];

function FilesPage() {
  const { fileId } = useSearch({ from: "/files" });
  const navigate = useNavigate({ from: "/files" });
  const files = useFiles();
  const { projects } = useProjects();

  const [folder, setFolder] = useState<FolderKey>("all");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<FileRecord | null>(null);

  // Deep-link
  useEffect(() => {
    if (fileId) {
      const found = files.find((f) => f.id === fileId);
      if (found && found.id !== selected?.id) setSelected(found);
    } else if (selected) {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, files]);

  // Sync selected when underlying file updates
  useEffect(() => {
    if (!selected) return;
    const fresh = files.find((f) => f.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
    if (!fresh) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files
      .filter((f) => {
        if (folder === "starred") return f.starred;
        if (folder === "shared") return f.shared;
        if (folder === "workspace") return !f.projectId;
        if (folder === "recent") {
          // last 30 days
          return Date.now() - new Date(f.uploadedAt).getTime() < 30 * 86_400_000;
        }
        if (folder !== "all" && folder !== folder) return true;
        if (folder !== "all" && (folder === "Contract" || folder === "Blueprint" || folder === "Permit" || folder === "Photos" || folder === "Other")) {
          return f.category === folder;
        }
        return true;
      })
      .filter((f) => projectFilter === "all" || (projectFilter === "_workspace" ? !f.projectId : f.projectId === projectFilter))
      .filter((f) => {
        if (!q) return true;
        return (
          f.name.toLowerCase().includes(q) ||
          f.tags.some((t) => t.toLowerCase().includes(q)) ||
          (f.projectName ?? "").toLowerCase().includes(q) ||
          f.uploadedBy.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));
  }, [files, folder, projectFilter, search]);

  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: files.length,
      starred: files.filter((f) => f.starred).length,
      shared: files.filter((f) => f.shared).length,
      workspace: files.filter((f) => !f.projectId).length,
      recent: files.filter((f) => Date.now() - new Date(f.uploadedAt).getTime() < 30 * 86_400_000).length,
    };
    FILE_CATEGORIES.forEach((c) => (counts[c] = files.filter((f) => f.category === c).length));
    return counts;
  }, [files]);

  const stats = useMemo(() => {
    const totalBytes = files.reduce((s, f) => s + approxBytes(f.size), 0);
    return {
      total: files.length,
      shared: files.filter((f) => f.shared).length,
      thisWeek: files.filter((f) => Date.now() - new Date(f.uploadedAt).getTime() < 7 * 86_400_000).length,
      storage: formatBytes(totalBytes),
    };
  }, [files]);

  const onFiles = (list: FileList | null, projectId?: string) => {
    if (!list) return;
    let added = 0;
    Array.from(list).forEach((f) => {
      const url = URL.createObjectURL(f);
      addFile({ name: f.name, size: f.size, projectId, url });
      added += 1;
    });
    if (added) toast.success(`${added} file${added > 1 ? "s" : ""} uploaded`);
  };

  const openFile = (f: FileRecord) => navigate({ search: { fileId: f.id }, replace: true });

  useTopbarAction(
    <Button size="sm" onClick={() => fileInputRef.current?.click()}>
      <Upload className="mr-1.5 h-4 w-4" />
      Upload
    </Button>,
  );

  return (
    <>
      <PageHeader
        icon={FolderOpen}
        iconBg="bg-gold-soft"
        iconColor="text-gold-hover"
        title="Files"
        subtitle="Documents, drawings, permits, photos, and shared assets"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
            />
            <Button variant="outline" size="sm">
              <FolderInput className="mr-1.5 h-4 w-4" />
              New folder
            </Button>
          </>
        }
      />

      {/* Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard icon={FolderOpen} tone="info" label="Total files" value={stats.total} />
        <MetricCard icon={Share2} tone="violet" label="Shared" value={stats.shared} />
        <MetricCard icon={Clock} tone="success" label="Added this week" value={stats.thisWeek} />
        <MetricCard icon={HardDrive} tone="gold" label="Storage used" value={stats.storage} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        {/* Folder sidebar */}
        <aside className="space-y-4">
          {FOLDER_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((it) => {
                  const active = folder === it.key;
                  const Icon = it.icon;
                  return (
                    <button
                      key={it.key}
                      onClick={() => setFolder(it.key)}
                      className={
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors " +
                        (active
                          ? "bg-primary text-primary-foreground"
                          : "text-foreground hover:bg-secondary")
                      }
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{it.label}</span>
                      <span
                        className={
                          "text-[10px] tabular-nums " +
                          (active ? "text-primary-foreground/80" : "text-muted-foreground")
                        }
                      >
                        {folderCounts[it.key as string] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <Separator />
          <ProjectFolders projects={projects} activeFolder={folder} projectFilter={projectFilter} setProjectFilter={setProjectFilter} setFolder={setFolder} />
        </aside>

        {/* Library */}
        <div>
          <Card className="mb-3 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search files, tags, projects, owners…"
                  className="h-9 pl-8"
                />
              </div>
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="h-9 w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  <SelectItem value="_workspace">Workspace only</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="ml-auto text-xs text-muted-foreground">
                {filtered.length} of {files.length}
              </div>
            </div>
          </Card>

          <Card
            className="overflow-hidden"
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              onFiles(e.dataTransfer.files);
            }}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Name</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                      No files match. Drop files here or click Upload.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((f) => (
                    <TableRow
                      key={f.id}
                      className="cursor-pointer"
                      onClick={() => openFile(f)}
                    >
                      <TableCell className="py-2.5">
                        <div className="flex items-center gap-2.5">
                          <FileGlyph ext={f.ext} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{f.name}</span>
                              {f.starred && <Star className="h-3 w-3 fill-warning text-warning" />}
                              {f.shared && <Share2 className="h-3 w-3 text-primary" />}
                            </div>
                            {f.tags.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {f.tags.slice(0, 3).map((t) => (
                                  <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {f.projectName ?? <span className="italic text-muted-foreground/70">Workspace</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px] font-medium">{f.category}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground tabular-nums">{f.size}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div>{formatDateShort(f.uploadedAt)}</div>
                        <div className="text-[11px]">{f.uploadedBy}</div>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <FileRowMenu file={f} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>

      <FileDrawer
        file={selected}
        onOpenChange={(o) => { if (!o) navigate({ search: { fileId: undefined }, replace: true }); }}
      />
    </>
  );
}

// ---------- Sidebar: project folders ----------

function ProjectFolders({
  projects,
  activeFolder,
  projectFilter,
  setProjectFilter,
  setFolder,
}: {
  projects: import("@/lib/projects-store").Project[];
  activeFolder: FolderKey;
  projectFilter: string;
  setProjectFilter: (v: string) => void;
  setFolder: (f: FolderKey) => void;
}) {
  const visible = projects.slice(0, 8);
  return (
    <div>
      <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      <div className="space-y-0.5">
        {visible.map((p) => {
          const active = activeFolder === "all" && projectFilter === p.id;
          return (
            <button
              key={p.id}
              onClick={() => { setFolder("all"); setProjectFilter(p.id); }}
              className={
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors " +
                (active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground")
              }
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">{p.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- File row menu ----------

function FileRowMenu({ file }: { file: FileRecord }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => { toast.success(`Downloading ${file.name}`); }}>
          <Download className="mr-2 h-4 w-4" /> Download
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => toggleStar(file.id)}>
          <Star className="mr-2 h-4 w-4" /> {file.starred ? "Remove star" : "Star"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => { deleteFile(file.id); toast.success("File deleted"); }}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- Glyph + stat card ----------

function FileGlyph({ ext }: { ext: string }) {
  const kind = fileIcon(ext);
  const map: Record<string, { Icon: React.ComponentType<{ className?: string }>; color: string }> = {
    image: { Icon: ImageIcon, color: "bg-pink-500/10 text-pink-600 dark:text-pink-400" },
    pdf: { Icon: FileText, color: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
    cad: { Icon: Presentation, color: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
    doc: { Icon: FileText, color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
    sheet: { Icon: FileSpreadsheet, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    slides: { Icon: Presentation, color: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    video: { Icon: FileVideo, color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
    archive: { Icon: FileArchive, color: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
    file: { Icon: FileIcon, color: "bg-secondary text-muted-foreground" },
  };
  const { Icon, color } = map[kind];
  return (
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${color}`}>
      <Icon className="h-4 w-4" />
      <span className="sr-only">{ext}</span>
    </div>
  );
}


// ---------- Drawer ----------

function FileDrawer({ file, onOpenChange }: { file: FileRecord | null; onOpenChange: (o: boolean) => void }) {
  const { projects } = useProjects();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const versionInputRef = useRef<HTMLInputElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    if (file) { setName(file.name); setRenaming(false); setTagInput(""); }
  }, [file?.id]);

  if (!file) return <Sheet open={false} onOpenChange={onOpenChange}><SheetContent /></Sheet>;

  const isImage = fileIcon(file.ext) === "image" && file.url;

  const addTag = () => {
    const v = tagInput.trim();
    if (!v) return;
    if (file.tags.includes(v)) { setTagInput(""); return; }
    setTags(file.id, [...file.tags, v]);
    setTagInput("");
  };

  const removeTag = (t: string) => setTags(file.id, file.tags.filter((x) => x !== t));

  return (
    <Sheet open={!!file} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-3 border-b border-border pb-4">
          <div className="flex items-start gap-3">
            <FileGlyph ext={file.ext} />
            <div className="min-w-0 flex-1">
              {renaming ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-8"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const trimmed = name.trim();
                      if (trimmed && trimmed !== file.name) {
                        renameFile(file.id, trimmed);
                        toast.success("File renamed");
                      }
                      setRenaming(false);
                    }}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setName(file.name); setRenaming(false); }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <SheetTitle className="truncate text-base">{file.name}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    {file.projectName ?? "Workspace"} · {file.size} · v{file.versions[0]?.version ?? 1}
                  </SheetDescription>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => toggleStar(file.id)}
              aria-label={file.starred ? "Unstar" : "Star"}
            >
              <Star className={"h-4 w-4 " + (file.starred ? "fill-warning text-warning" : "")} />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => toast.success(`Downloading ${file.name}`)}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Download
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShareOpen(true)}>
              <Share2 className="mr-1.5 h-3.5 w-3.5" /> Share
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Rename
            </Button>
            <input
              ref={versionInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  addVersion(file.id, { size: f.size, note: f.name });
                  toast.success("New version uploaded");
                }
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="outline" onClick={() => versionInputRef.current?.click()}>
              <History className="mr-1.5 h-3.5 w-3.5" /> New version
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => { deleteFile(file.id); toast.success("File deleted"); onOpenChange(false); }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </SheetHeader>

        {/* Preview */}
        <div className="my-4 flex h-44 items-center justify-center rounded-md border border-dashed border-border bg-secondary/30">
          {isImage ? (
            <img src={file.url} alt={file.name} className="h-full w-full rounded-md object-cover" />
          ) : (
            <div className="text-center">
              <FileGlyph ext={file.ext} />
              <div className="mt-2 text-xs text-muted-foreground">Preview not available</div>
            </div>
          )}
        </div>

        <Tabs defaultValue="details">
          <TabsList className="grid grid-cols-4">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="sharing">Sharing</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          {/* Details */}
          <TabsContent value="details" className="mt-3 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Category">
                <Select value={file.category} onValueChange={(v) => setCategory(file.id, v as FileCategory)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FILE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Project">
                <Select
                  value={file.projectId ?? "_workspace"}
                  onValueChange={(v) => moveFile(file.id, v === "_workspace" ? undefined : v)}
                >
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_workspace">Workspace</SelectItem>
                    {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Size"><div className="text-sm tabular-nums">{file.size}</div></Field>
              <Field label="Type"><div className="text-sm uppercase">{file.ext}</div></Field>
              <Field label="Uploaded"><div className="text-sm">{formatDate(file.uploadedAt)}</div></Field>
              <Field label="Uploaded by"><div className="text-sm">{file.uploadedBy}</div></Field>
            </div>

            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {file.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                    <TagIcon className="h-3 w-3" />
                    {t}
                    <button
                      onClick={() => removeTag(t)}
                      className="ml-0.5 rounded text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${t}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <div className="flex items-center gap-1">
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                    placeholder="Add tag…"
                    className="h-7 w-28 text-xs"
                  />
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={addTag}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Versions */}
          <TabsContent value="versions" className="mt-3 space-y-2">
            {file.versions.map((v, i) => (
              <div key={v.id} className="flex items-center justify-between rounded-md border border-border p-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-xs font-semibold text-primary">
                    v{v.version}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{v.note ?? `Version ${v.version}`}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(v.uploaded)} · {v.size} · {v.uploadedBy}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {i === 0 && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => toast.success(`Downloading v${v.version}`)}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </TabsContent>

          {/* Sharing */}
          <TabsContent value="sharing" className="mt-3 space-y-3">
            <Button size="sm" onClick={() => setShareOpen(true)}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> Create share link
            </Button>
            {file.shareLinks.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                Not shared yet. Create a link to share this file with clients or teammates.
              </div>
            ) : (
              <div className="space-y-2">
                {file.shareLinks.map((l) => (
                  <div key={l.id} className={"rounded-md border border-border p-2.5 " + (l.revoked ? "opacity-60" : "")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px] capitalize">{l.permission}</Badge>
                          {l.recipient && <span className="truncate text-xs text-muted-foreground">{l.recipient}</span>}
                          {l.revoked && <Badge variant="outline" className="text-[10px]">Revoked</Badge>}
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{l.url}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Created {formatDateShort(l.createdAt)} by {l.createdBy}
                          {l.expiresAt && ` · expires ${formatDateShort(l.expiresAt)}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          onClick={() => { void navigator.clipboard.writeText(l.url); toast.success("Link copied"); }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        {!l.revoked && (
                          <Button
                            size="sm" variant="ghost"
                            className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => { revokeShareLink(file.id, l.id); toast.success("Link revoked"); }}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Activity */}
          <TabsContent value="activity" className="mt-3">
            <div className="space-y-3">
              {file.activity.map((a) => (
                <div key={a.id} className="flex items-start gap-2.5">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-secondary text-[10px]">
                      {a.who.split(" ").map((p) => p[0]).join("").slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">
                      <span className="font-medium">{a.who}</span>{" "}
                      <span className="text-muted-foreground">{readableAction(a.action)}</span>
                      {a.detail && <span className="text-muted-foreground"> — {a.detail}</span>}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{formatDateShort(a.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} file={file} />
      </SheetContent>
    </Sheet>
  );
}

function readableAction(a: string): string {
  switch (a) {
    case "uploaded": return "uploaded the file";
    case "renamed": return "renamed the file";
    case "moved": return "moved the file";
    case "tagged": return "updated tags";
    case "shared": return "created a share link";
    case "share-revoked": return "revoked a share link";
    case "version-added": return "uploaded a new version";
    case "downloaded": return "downloaded the file";
    case "starred": return "starred the file";
    case "unstarred": return "unstarred the file";
    case "deleted": return "deleted the file";
    default: return a;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

// ---------- Share dialog ----------

function ShareDialog({
  open, onOpenChange, file,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  file: FileRecord;
}) {
  const [recipient, setRecipient] = useState("");
  const [permission, setPermission] = useState<"view" | "comment" | "edit">("view");
  const [expires, setExpires] = useState<string>("never");
  const [note, setNote] = useState("");

  useEffect(() => { if (open) { setRecipient(""); setPermission("view"); setExpires("never"); setNote(""); } }, [open]);

  const submit = () => {
    let expiresAt: string | undefined;
    if (expires !== "never") {
      const days = parseInt(expires, 10);
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }
    createShareLink(file.id, { recipient: recipient.trim() || undefined, permission, expiresAt });
    toast.success("Share link created");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share file</DialogTitle>
          <DialogDescription className="truncate">{file.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Recipient (optional)</Label>
            <Input
              className="mt-1 h-9"
              placeholder="name@example.com"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Permission</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as typeof permission)}>
                <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">View only</SelectItem>
                  <SelectItem value="comment">Can comment</SelectItem>
                  <SelectItem value="edit">Can edit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Expires</Label>
              <Select value={expires} onValueChange={setExpires}>
                <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="7">In 7 days</SelectItem>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="90">In 90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Textarea
              className="mt-1"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a message for the recipient…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit}>Create link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
