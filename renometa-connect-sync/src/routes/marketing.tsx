import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";


import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  Megaphone, Mail, MessageSquare, Send, Calendar as CalendarIcon, Users, Eye,
  MousePointerClick, Reply, AlertTriangle, MoreHorizontal, Copy, Trash2, X,
  Clock, CheckCircle2, FileEdit, Plus, Sparkles, Tag, Activity,
} from "lucide-react";
import {
  segments, getSegment, useBroadcasts, createBroadcast, deleteBroadcast,
  duplicateBroadcast, cancelScheduled, mergeTags, sampleMergeContext,
  renderMergeTags, type Broadcast, type BroadcastChannel, type SegmentId,
} from "@/lib/broadcasts-store";
import { messageTemplates } from "@/lib/message-templates";
import { cn } from "@/lib/utils";

type BroadcastsSearch = { composer: boolean; broadcastId: string };

export const Route = createFileRoute("/marketing")({
  validateSearch: (raw: Record<string, unknown>): BroadcastsSearch => ({
    composer: raw.composer === true || raw.composer === "true",
    broadcastId: typeof raw.broadcastId === "string" ? raw.broadcastId : "",
  }),
  component: MarketingPage,
});

function MarketingPage() {
  const { composer, broadcastId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const broadcasts = useBroadcasts();

  const stats = useMemo(() => {
    const sent = broadcasts.filter((b) => b.status === "sent");
    const totalRecipients = sent.reduce((sum, b) => sum + b.stats.recipients, 0);
    const totalDelivered = sent.reduce((sum, b) => sum + b.stats.delivered, 0) || 1;
    const totalOpens = sent.reduce((sum, b) => sum + b.stats.opens, 0);
    const totalClicks = sent.reduce((sum, b) => sum + b.stats.clicks, 0);
    const totalReplies = sent.reduce((sum, b) => sum + b.stats.replies, 0);
    return {
      total: broadcasts.length,
      sentCount: sent.length,
      scheduled: broadcasts.filter((b) => b.status === "scheduled").length,
      drafts: broadcasts.filter((b) => b.status === "draft").length,
      totalRecipients,
      totalDelivered,
      totalOpens,
      totalClicks,
      totalReplies,
      openRate: totalDelivered ? Math.round((totalOpens / totalDelivered) * 100) : 0,
      clickRate: totalDelivered ? Math.round((totalClicks / totalDelivered) * 100) : 0,
      replyRate: totalDelivered ? Math.round((totalReplies / totalDelivered) * 100) : 0,
    };
  }, [broadcasts]);

  const selected = broadcasts.find((b) => b.id === broadcastId);

  // Real engagement funnel from actual sent-broadcast stats — no fabricated
  // "appointments generated" stage, since broadcasts don't currently link to
  // appointment records.
  const funnel = useMemo(() => {
    const rows = [
      { label: "Recipients", value: stats.totalRecipients, color: "bg-info" },
      { label: "Delivered", value: stats.totalDelivered === 1 && stats.totalRecipients === 0 ? 0 : stats.totalDelivered, color: "bg-cyan" },
      { label: "Opened", value: stats.totalOpens, color: "bg-violet" },
      { label: "Clicked", value: stats.totalClicks, color: "bg-success" },
      { label: "Replied", value: stats.totalReplies, color: "bg-gold" },
    ];
    const max = Math.max(1, ...rows.map(r => r.value));
    return { rows, max };
  }, [stats]);

  return (
    <>
      <PageHeader
        icon={Megaphone}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Marketing"
        subtitle="Create campaigns, reach customers, and track engagement from one place."
        actions={
          <Button
            onClick={() => navigate({ search: (p) => ({ ...p, composer: true }) })}
          >
            <Plus className="mr-1.5 h-4 w-4" /> New broadcast
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <MetricTile icon={Megaphone} iconBg="bg-info-soft" iconColor="text-info" label="Sent" value={String(stats.sentCount)} sub={`${stats.scheduled} scheduled · ${stats.drafts} drafts`} />
        <MetricTile icon={Users} iconBg="bg-cyan-soft" iconColor="text-cyan-soft-foreground" label="Recipients reached" value={stats.totalRecipients.toLocaleString()} sub="across all sent broadcasts" />
        <MetricTile icon={Eye} iconBg="bg-success-soft" iconColor="text-success" label="Avg open rate" value={`${stats.openRate}%`} sub={`${stats.clickRate}% click · ${stats.replyRate}% reply`} />
        <MetricTile icon={Tag} iconBg="bg-gold-soft" iconColor="text-gold-hover" label="Segments" value={String(segments.length)} sub="Available recipient segments" />
      </div>

      <Tabs defaultValue="history" className="space-y-4">
        <TabsList>
          <TabsTrigger value="history">All broadcasts</TabsTrigger>
          <TabsTrigger value="segments">Segments</TabsTrigger>
        </TabsList>

        <TabsContent value="history">
          <BroadcastsTable
            broadcasts={broadcasts}
            onOpen={(id) => navigate({ search: (p) => ({ ...p, broadcastId: id }) })}
            onCompose={() => navigate({ search: (p) => ({ ...p, composer: true }) })}
          />
        </TabsContent>

        <TabsContent value="segments">
          <SegmentsGrid />
        </TabsContent>
      </Tabs>

      {stats.sentCount > 0 && (
        <Card className="mt-6">
          <CardHeader className="flex h-12 flex-row items-center gap-2 space-y-0 border-b border-border px-4 py-0">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-info-soft text-info">
              <Activity className="h-3.5 w-3.5" />
            </span>
            <CardTitle>Engagement funnel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {funnel.rows.map((r) => (
              <div key={r.label}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium text-foreground">{r.label}</span>
                  <span className="tabular-nums text-muted-foreground">{r.value.toLocaleString()}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary">
                  <div className={cn("h-full rounded-full", r.color)} style={{ width: `${(r.value / funnel.max) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <ComposerSheet
        open={composer}
        onClose={() => navigate({ search: (p) => ({ ...p, composer: false }) })}
      />
      <DetailSheet
        broadcast={selected}
        onClose={() => navigate({ search: (p) => ({ ...p, broadcastId: "" }) })}
      />
    </>
  );
}

// ---------- Subcomponents ----------

function MetricTile({
  icon: Icon, iconBg, iconColor, label, value, sub,
}: { icon: React.ComponentType<{ className?: string }>; iconBg: string; iconColor: string; label: string; value: string; sub: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", iconBg, iconColor)}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="mt-1 text-xl font-semibold tabular-nums leading-tight text-foreground">{value}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: Broadcast["status"] }) {
  const map: Record<Broadcast["status"], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
    draft:     { label: "Draft",     cls: "bg-muted text-foreground",                       icon: FileEdit },
    scheduled: { label: "Scheduled", cls: "bg-primary-soft text-primary",                   icon: Clock },
    sending:   { label: "Sending",   cls: "bg-primary-soft text-primary",                   icon: Send },
    sent:      { label: "Sent",      cls: "bg-success-soft text-success",                   icon: CheckCircle2 },
    failed:    { label: "Failed",    cls: "bg-destructive/10 text-destructive",             icon: AlertTriangle },
  };
  const cfg = map[status];
  const Icon = cfg.icon;
  return (
    <Badge variant="secondary" className={cn("gap-1 font-medium", cfg.cls)}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </Badge>
  );
}

function ChannelBadge({ channel }: { channel: BroadcastChannel }) {
  const Icon = channel === "email" ? Mail : MessageSquare;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Icon className="h-3.5 w-3.5" /> {channel === "email" ? "Email" : "SMS"}
    </span>
  );
}

function SegmentsGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {segments.map((s) => (
        <Card key={s.id}>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <CardTitle className="text-sm font-semibold">{s.name}</CardTitle>
              <Badge variant="secondary" className="bg-primary-soft text-primary">
                {s.count.toLocaleString()}
              </Badge>
            </div>
            <CardDescription className="text-xs">{s.description}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function BroadcastsTable({
  broadcasts, onOpen, onCompose,
}: {
  broadcasts: Broadcast[];
  onOpen: (id: string) => void;
  onCompose: () => void;
}) {
  if (broadcasts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Megaphone className="h-10 w-10 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">No broadcasts yet</h3>
            <p className="text-xs text-muted-foreground">Send your first one-to-many email or SMS campaign.</p>
          </div>
          <Button onClick={onCompose}>
            <Plus className="mr-1.5 h-4 w-4" /> New broadcast
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[36%]">Broadcast</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Segment</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Recipients</TableHead>
            <TableHead className="text-right">Opens</TableHead>
            <TableHead className="text-right">Clicks</TableHead>
            <TableHead className="text-right">Replies</TableHead>
            <TableHead className="w-[40px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {broadcasts.map((b) => {
            const openRate = b.stats.delivered ? Math.round((b.stats.opens / b.stats.delivered) * 100) : 0;
            const clickRate = b.stats.delivered ? Math.round((b.stats.clicks / b.stats.delivered) * 100) : 0;
            const replyRate = b.stats.delivered ? Math.round((b.stats.replies / b.stats.delivered) * 100) : 0;
            return (
              <TableRow
                key={b.id}
                className="cursor-pointer"
                onClick={() => onOpen(b.id)}
              >
                <TableCell>
                  <div className="font-medium text-sm">{b.name}</div>
                  <div className="text-xs text-muted-foreground line-clamp-1">
                    {b.subject ?? b.body.split("\n")[0]}
                  </div>
                </TableCell>
                <TableCell><ChannelBadge channel={b.channel} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{b.segmentName}</TableCell>
                <TableCell>
                  <StatusBadge status={b.status} />
                  {b.status === "scheduled" && b.scheduledFor && (
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {new Date(b.scheduledFor).toLocaleString()}
                    </div>
                  )}
                  {b.status === "sent" && b.sentAt && (
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {new Date(b.sentAt).toLocaleDateString()}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{b.stats.recipients}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {b.status === "sent" ? <span><span className="font-medium text-foreground">{b.stats.opens}</span> <span className="text-muted-foreground">({openRate}%)</span></span> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {b.status === "sent" ? <span><span className="font-medium text-foreground">{b.stats.clicks}</span> <span className="text-muted-foreground">({clickRate}%)</span></span> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {b.status === "sent" ? <span><span className="font-medium text-foreground">{b.stats.replies}</span> <span className="text-muted-foreground">({replyRate}%)</span></span> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onOpen(b.id)}>
                        <Eye className="mr-2 h-4 w-4" /> View details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          duplicateBroadcast(b.id);
                          toast.success("Broadcast duplicated as draft");
                        }}
                      >
                        <Copy className="mr-2 h-4 w-4" /> Duplicate
                      </DropdownMenuItem>
                      {b.status === "scheduled" && (
                        <DropdownMenuItem
                          onClick={() => {
                            cancelScheduled(b.id);
                            toast.success("Schedule cancelled — moved to drafts");
                          }}
                        >
                          <X className="mr-2 h-4 w-4" /> Cancel schedule
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          deleteBroadcast(b.id);
                          toast.success("Broadcast deleted");
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------- Composer Sheet ----------

function ComposerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<BroadcastChannel>("email");
  const [segmentId, setSegmentId] = useState<SegmentId>("past_clients");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fromName, setFromName] = useState("Renometa");
  const [scheduleKind, setScheduleKind] = useState<"now" | "later" | "draft">("now");
  const [scheduledFor, setScheduledFor] = useState("");

  const seg = getSegment(segmentId);
  const channelTemplates = messageTemplates.filter((t) => t.channel === channel);

  function reset() {
    setName(""); setSubject(""); setBody(""); setSegmentId("past_clients");
    setChannel("email"); setScheduleKind("now"); setScheduledFor("");
  }

  function applyTemplate(id: string) {
    const tpl = channelTemplates.find((t) => t.id === id);
    if (!tpl) return;
    setSubject(tpl.subject ?? "");
    setBody(tpl.body);
    if (!name) setName(tpl.name);
  }

  function insertTag(tag: string) {
    setBody((b) => `${b}{{${tag}}}`);
  }

  function handleSubmit() {
    if (!name.trim()) { toast.error("Give your broadcast a name"); return; }
    if (!body.trim()) { toast.error("Message body cannot be empty"); return; }
    if (channel === "email" && !subject.trim()) { toast.error("Email subject is required"); return; }
    if (scheduleKind === "later" && !scheduledFor) { toast.error("Pick a date and time to schedule"); return; }

    const schedule =
      scheduleKind === "now"   ? { kind: "now" as const } :
      scheduleKind === "later" ? { kind: "later" as const, iso: new Date(scheduledFor).toISOString() } :
                                 { kind: "draft" as const };

    createBroadcast({ name, channel, segmentId, subject, body, fromName, schedule });

    if (scheduleKind === "now") toast.success(`Sent to ${seg.count} recipients`);
    else if (scheduleKind === "later") toast.success(`Scheduled for ${new Date(scheduledFor).toLocaleString()}`);
    else toast.success("Saved as draft");

    reset();
    onClose();
  }

  const SMS_LIMIT = 160;
  const overSms = channel === "sms" && body.length > SMS_LIMIT;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-3xl flex flex-col p-0">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> New broadcast
          </SheetTitle>
          <SheetDescription>Compose a one-to-many email or SMS, pick a segment, and send or schedule.</SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] flex-1 overflow-hidden">
          <div className="overflow-y-auto px-6 py-5 space-y-5">
            <div className="grid gap-2">
              <Label>Broadcast name <span className="text-muted-foreground font-normal">(internal)</span></Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring kitchen promo" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Channel</Label>
                <Select value={channel} onValueChange={(v) => setChannel(v as BroadcastChannel)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email"><Mail className="mr-2 inline h-3.5 w-3.5" />Email</SelectItem>
                    <SelectItem value="sms"><MessageSquare className="mr-2 inline h-3.5 w-3.5" />SMS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Recipient segment</Label>
                <Select value={segmentId} onValueChange={(v) => setSegmentId(v as SegmentId)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {segments.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} <span className="ml-1 text-muted-foreground">({s.count})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-primary" />
              <span><span className="font-medium text-foreground">{seg.count}</span> recipients in <span className="font-medium text-foreground">{seg.name}</span></span>
              <span className="text-muted-foreground">— {seg.description}</span>
            </div>

            {channelTemplates.length > 0 && (
              <div className="grid gap-2">
                <Label className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Start from template</Label>
                <Select onValueChange={applyTemplate}>
                  <SelectTrigger><SelectValue placeholder="Pick a template…" /></SelectTrigger>
                  <SelectContent>
                    {channelTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {channel === "email" && (
              <>
                <div className="grid gap-2">
                  <Label>From name</Label>
                  <Input value={fromName} onChange={(e) => setFromName(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>Subject</Label>
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line — merge tags allowed" />
                </div>
              </>
            )}

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>{channel === "email" ? "Email body" : "SMS message"}</Label>
                <div className={cn("text-xs", overSms ? "text-destructive" : "text-muted-foreground")}>
                  {channel === "sms" && `${body.length} / ${SMS_LIMIT}`}
                </div>
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={channel === "email" ? 10 : 5}
                placeholder={channel === "email"
                  ? "Hi {{first_name}},\n\nWrite your message…"
                  : "Hey {{first_name}}, …"}
                className="font-mono text-sm"
              />
              <div className="flex flex-wrap gap-1">
                {mergeTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => insertTag(t)}
                    className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    {`{{${t}}}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Send</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant={scheduleKind === "now"   ? "default" : "outline"} size="sm" onClick={() => setScheduleKind("now")}>
                  <Send className="mr-1.5 h-3.5 w-3.5" /> Send now
                </Button>
                <Button type="button" variant={scheduleKind === "later" ? "default" : "outline"} size="sm" onClick={() => setScheduleKind("later")}>
                  <CalendarIcon className="mr-1.5 h-3.5 w-3.5" /> Schedule
                </Button>
                <Button type="button" variant={scheduleKind === "draft" ? "default" : "outline"} size="sm" onClick={() => setScheduleKind("draft")}>
                  <FileEdit className="mr-1.5 h-3.5 w-3.5" /> Save draft
                </Button>
              </div>
              {scheduleKind === "later" && (
                <Input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="mt-1 w-fit"
                />
              )}
            </div>
          </div>

          <aside className="border-l bg-muted/20 overflow-y-auto px-5 py-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" /> Preview
              <span className="font-normal lowercase text-muted-foreground/80">(merge tags filled with sample data)</span>
            </div>
            <div className="rounded-lg border bg-background p-4 shadow-sm">
              {channel === "email" ? (
                <>
                  <div className="text-[11px] text-muted-foreground">From</div>
                  <div className="text-sm font-medium">{fromName}</div>
                  <div className="mt-2 text-[11px] text-muted-foreground">Subject</div>
                  <div className="text-sm font-semibold">{renderMergeTags(subject || "(no subject)", sampleMergeContext)}</div>
                  <div className="my-3 border-t" />
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {renderMergeTags(body || "(empty)", sampleMergeContext)}
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="text-[11px] text-muted-foreground">SMS to {sampleMergeContext.first_name}</div>
                  <div className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground max-w-[85%] whitespace-pre-wrap">
                    {renderMergeTags(body || "(empty)", sampleMergeContext)}
                  </div>
                  {overSms && (
                    <div className="text-[11px] text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Will be split into multiple SMS segments
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>

        <SheetFooter className="border-t px-6 py-3 flex !justify-between">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit}>
            {scheduleKind === "now"   && (<><Send className="mr-1.5 h-4 w-4" /> Send to {seg.count}</>)}
            {scheduleKind === "later" && (<><CalendarIcon className="mr-1.5 h-4 w-4" /> Schedule for {seg.count}</>)}
            {scheduleKind === "draft" && (<><FileEdit className="mr-1.5 h-4 w-4" /> Save draft</>)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------- Detail Sheet ----------

function DetailSheet({ broadcast, onClose }: { broadcast: Broadcast | undefined; onClose: () => void }) {
  const open = Boolean(broadcast);
  if (!broadcast) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent />
      </Sheet>
    );
  }

  const b = broadcast;
  const rate = (n: number) => (b.stats.delivered ? Math.round((n / b.stats.delivered) * 100) : 0);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <ChannelBadge channel={b.channel} />
            <StatusBadge status={b.status} />
          </div>
          <SheetTitle className="text-xl">{b.name}</SheetTitle>
          <SheetDescription>
            Sent to <span className="font-medium text-foreground">{b.segmentName}</span>
            {b.sentAt && <> · {new Date(b.sentAt).toLocaleString()}</>}
            {b.scheduledFor && <> · scheduled for {new Date(b.scheduledFor).toLocaleString()}</>}
          </SheetDescription>
        </SheetHeader>

        {b.status === "sent" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
            <StatPill icon={Users}              label="Recipients" value={b.stats.recipients} />
            <StatPill icon={Eye}                label="Opens"      value={b.stats.opens}    sub={`${rate(b.stats.opens)}%`} />
            <StatPill icon={MousePointerClick}  label="Clicks"     value={b.stats.clicks}   sub={`${rate(b.stats.clicks)}%`} />
            <StatPill icon={Reply}              label="Replies"    value={b.stats.replies}  sub={`${rate(b.stats.replies)}%`} />
            <StatPill icon={CheckCircle2}       label="Delivered"  value={b.stats.delivered} />
            <StatPill icon={AlertTriangle}      label="Bounces"    value={b.stats.bounces} />
            <StatPill icon={X}                  label="Unsubs"     value={b.stats.unsubscribes} />
          </div>
        )}

        <div className="mt-6 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</h3>
          <div className="rounded-lg border bg-background p-4">
            {b.channel === "email" && b.subject && (
              <>
                <div className="text-[11px] text-muted-foreground">Subject</div>
                <div className="text-sm font-semibold mb-3">{renderMergeTags(b.subject, sampleMergeContext)}</div>
              </>
            )}
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {renderMergeTags(b.body, sampleMergeContext)}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Preview shown with sample merge tag values.</p>
        </div>

        <SheetFooter className="mt-6 flex !justify-between border-t pt-4">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                duplicateBroadcast(b.id);
                toast.success("Duplicated as draft");
              }}
            >
              <Copy className="mr-1.5 h-4 w-4" /> Duplicate
            </Button>
            {b.status === "scheduled" && (
              <Button
                variant="outline"
                onClick={() => {
                  cancelScheduled(b.id);
                  toast.success("Schedule cancelled");
                  onClose();
                }}
              >
                <X className="mr-1.5 h-4 w-4" /> Cancel schedule
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={() => {
                deleteBroadcast(b.id);
                toast.success("Broadcast deleted");
                onClose();
              }}
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function StatPill({
  icon: Icon, label, value, sub,
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}
