import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Star, Trophy, MessageSquare, ExternalLink, ThumbsUp, AlertCircle,
  TrendingUp, Send, Clock, Award, CheckCircle2,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/insights/reputation")({
  head: () => ({
    meta: [
      { title: "Reputation — Insights" },
      { name: "description", content: "Reviews, ratings, and reputation across Google, Yelp, Houzz, and Angi." },
    ],
  }),
  component: ReputationPage,
});

type Platform = "google" | "yelp" | "houzz" | "angi";
type Sentiment = "positive" | "neutral" | "negative";

type Review = {
  id: string;
  platform: Platform;
  author: string;
  rating: number;
  date: string;
  project: string;
  body: string;
  responded: boolean;
  response?: string;
  sentiment: Sentiment;
  helpful: number;
};

const PLATFORM_META: Record<Platform, { label: string; color: string; rating: number; total: number }> = {
  google: { label: "Google", color: "bg-blue-500", rating: 4.8, total: 142 },
  yelp: { label: "Yelp", color: "bg-rose-500", rating: 4.6, total: 38 },
  houzz: { label: "Houzz", color: "bg-emerald-500", rating: 4.9, total: 67 },
  angi: { label: "Angi", color: "bg-amber-500", rating: 4.7, total: 24 },
};

const REVIEWS: Review[] = [
  { id: "r1", platform: "google", author: "Sarah Henderson", rating: 5, date: "2026-04-12", project: "Kitchen remodel", body: "Absolutely stellar work. The team finished on schedule and the cabinets are gorgeous. Maria kept us informed every step of the way.", responded: true, response: "Thank you Sarah! It was a joy working on your kitchen.", sentiment: "positive", helpful: 12 },
  { id: "r2", platform: "houzz", author: "Mark Chen", rating: 5, date: "2026-04-09", project: "Master bath", body: "Best contractor we've ever hired. Clean, professional, and the tile work is perfect.", responded: true, sentiment: "positive", helpful: 8 },
  { id: "r3", platform: "google", author: "Priya Patel", rating: 4, date: "2026-04-05", project: "Whole-home reno", body: "Great craftsmanship overall. Communication during the framing phase could have been a touch better but they made it right.", responded: false, sentiment: "positive", helpful: 5 },
  { id: "r4", platform: "yelp", author: "Tom Rivera", rating: 2, date: "2026-04-02", project: "Deck addition", body: "Project ran 3 weeks long and we had to chase for updates. The end result is good but the experience was rough.", responded: false, sentiment: "negative", helpful: 14 },
  { id: "r5", platform: "angi", author: "Lisa Wong", rating: 5, date: "2026-03-28", project: "Powder room", body: "Quick, clean, fairly priced. Will use again for our basement.", responded: true, sentiment: "positive", helpful: 3 },
  { id: "r6", platform: "google", author: "Daniel Kim", rating: 5, date: "2026-03-24", project: "Outdoor kitchen", body: "James and his crew are artists. The grill station is the highlight of our backyard now.", responded: true, sentiment: "positive", helpful: 9 },
  { id: "r7", platform: "houzz", author: "Eva Martinez", rating: 3, date: "2026-03-20", project: "Bath refresh", body: "Final result is fine but they left a few punch list items unaddressed for two weeks.", responded: false, sentiment: "neutral", helpful: 6 },
  { id: "r8", platform: "google", author: "Robert Singh", rating: 5, date: "2026-03-18", project: "Kitchen remodel", body: "Phenomenal. Worth every penny. The 3D renders matched the final result exactly.", responded: true, sentiment: "positive", helpful: 11 },
];

const ratingTrend = [
  { month: "Nov", rating: 4.6, reviews: 18 },
  { month: "Dec", rating: 4.7, reviews: 22 },
  { month: "Jan", rating: 4.7, reviews: 26 },
  { month: "Feb", rating: 4.8, reviews: 31 },
  { month: "Mar", rating: 4.8, reviews: 34 },
  { month: "Apr", rating: 4.8, reviews: 28 },
];

const requestStats = [
  { label: "Sent this month", value: 42, icon: Send },
  { label: "Reviews received", value: 18, icon: CheckCircle2 },
  { label: "Conversion rate", value: "43%", icon: TrendingUp },
  { label: "Avg time to review", value: "3.2d", icon: Clock },
];

const ratingBreakdown = [
  { stars: 5, count: 198, pct: 73 },
  { stars: 4, count: 51, pct: 19 },
  { stars: 3, count: 14, pct: 5 },
  { stars: 2, count: 6, pct: 2 },
  { stars: 1, count: 2, pct: 1 },
];

function ReputationPage() {
  const [filter, setFilter] = useState<"all" | Platform>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "needs-response" | "responded">("all");
  const [selected, setSelected] = useState<Review | null>(null);

  const filtered = useMemo(() => REVIEWS.filter((r) => {
    if (filter !== "all" && r.platform !== filter) return false;
    if (statusFilter === "needs-response" && r.responded) return false;
    if (statusFilter === "responded" && !r.responded) return false;
    return true;
  }), [filter, statusFilter]);

  const overallRating = (Object.values(PLATFORM_META).reduce((s, p) => s + p.rating * p.total, 0) /
    Object.values(PLATFORM_META).reduce((s, p) => s + p.total, 0)).toFixed(1);
  const totalReviews = Object.values(PLATFORM_META).reduce((s, p) => s + p.total, 0);
  const needsResponse = REVIEWS.filter((r) => !r.responded).length;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reputation</h1>
          <p className="text-sm text-muted-foreground">Reviews, ratings, and review-request performance.</p>
        </div>
        <Button onClick={() => toast.success("Review request sent")}>
          <Send className="mr-2 h-4 w-4" /> Request reviews
        </Button>
      </header>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Overall rating</span>
              <Trophy className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-semibold">{overallRating}</span>
              <Stars value={Number(overallRating)} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{totalReviews} reviews across 4 platforms</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Needs response</span>
              <AlertCircle className="h-4 w-4 text-rose-500" />
            </div>
            <div className="mt-2 text-3xl font-semibold">{needsResponse}</div>
            <div className="mt-1 text-xs text-muted-foreground">Avg response time: 6h</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Sentiment</span>
              <ThumbsUp className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="mt-2 text-3xl font-semibold">92%</div>
            <div className="mt-1 text-xs text-muted-foreground">Positive across last 90 days</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Award badges</span>
              <Award className="h-4 w-4 text-blue-500" />
            </div>
            <div className="mt-2 text-3xl font-semibold">3</div>
            <div className="mt-1 text-xs text-muted-foreground">Houzz Best of, Angi Super Service</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">By platform</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(Object.keys(PLATFORM_META) as Platform[]).map((p) => {
              const m = PLATFORM_META[p];
              return (
                <div key={p} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-md ${m.color} flex items-center justify-center text-sm font-semibold text-white`}>
                      {m.label[0]}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-xs text-muted-foreground">{m.total} reviews</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center gap-1 text-sm font-semibold">
                      {m.rating} <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                    </div>
                    <button className="text-[11px] text-primary hover:underline">View <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" /></button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Rating trend</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={ratingTrend}>
                <defs>
                  <linearGradient id="rt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis domain={[4, 5]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Area type="monotone" dataKey="rating" stroke="hsl(var(--primary))" fill="url(#rt)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="mt-3 grid grid-cols-5 gap-2 border-t pt-3">
              {ratingBreakdown.map((b) => (
                <div key={b.stars} className="text-center">
                  <div className="flex items-center justify-center gap-0.5 text-xs font-medium">
                    {b.stars}<Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full bg-primary" style={{ width: `${b.pct}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{b.count}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Review-request performance</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          {requestStats.map((s) => (
            <div key={s.label} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <s.icon className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
              <div className="mt-2 text-2xl font-semibold">{s.value}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Recent reviews</CardTitle>
          <div className="flex items-center gap-2">
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                <TabsTrigger value="needs-response" className="text-xs">Needs response</TabsTrigger>
                <TabsTrigger value="responded" className="text-xs">Responded</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList>
              <TabsTrigger value="all">All platforms</TabsTrigger>
              {(Object.keys(PLATFORM_META) as Platform[]).map((p) => (
                <TabsTrigger key={p} value={p}>{PLATFORM_META[p].label}</TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={filter} className="mt-4 space-y-3">
              {filtered.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No reviews match these filters.</div>}
              {filtered.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="w-full rounded-lg border p-4 text-left transition-colors hover:bg-secondary/50"
                >
                  <div className="flex items-start gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="text-xs">{r.author.split(" ").map((n) => n[0]).join("")}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{r.author}</span>
                        <span className={`h-1.5 w-1.5 rounded-full ${PLATFORM_META[r.platform].color}`} />
                        <span className="text-xs text-muted-foreground">{PLATFORM_META[r.platform].label}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{r.project}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{r.date}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Stars value={r.rating} />
                        {!r.responded && <Badge variant="destructive" className="text-[10px]">Needs response</Badge>}
                        {r.responded && <Badge variant="secondary" className="text-[10px]">Responded</Badge>}
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm text-foreground/80">{r.body}</p>
                      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" /> {r.helpful}</span>
                        <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {r.responded ? "1 reply" : "Reply"}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <ReviewSheet review={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-3.5 w-3.5 ${i <= Math.round(value) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`} />
      ))}
    </div>
  );
}

function ReviewSheet({ review, onClose }: { review: Review | null; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <Sheet open={!!review} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        {review && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${PLATFORM_META[review.platform].color}`} />
                <SheetTitle>{PLATFORM_META[review.platform].label} review</SheetTitle>
              </div>
              <SheetDescription>{review.project} · {review.date}</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-5">
              <div className="flex items-center gap-3">
                <Avatar><AvatarFallback>{review.author.split(" ").map((n) => n[0]).join("")}</AvatarFallback></Avatar>
                <div>
                  <div className="text-sm font-medium">{review.author}</div>
                  <Stars value={review.rating} />
                </div>
              </div>
              <div className="rounded-lg border bg-secondary/30 p-4 text-sm">{review.body}</div>

              {review.responded && review.response && (
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your response</div>
                  <div className="rounded-lg border-l-2 border-primary bg-primary/5 p-3 text-sm">{review.response}</div>
                </div>
              )}

              {!review.responded && (
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Draft response</div>
                  <Textarea
                    placeholder="Thank the customer and address any concerns…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={5}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => { toast.success("Response posted"); onClose(); }}>
                      <Send className="mr-1.5 h-3.5 w-3.5" /> Post response
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDraft("Thanks so much for the kind words! It was a pleasure working with you.")}>
                      AI draft
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" /> {review.helpful} found helpful</span>
                <button className="flex items-center gap-1 text-primary hover:underline">
                  Open on {PLATFORM_META[review.platform].label} <ExternalLink className="h-3 w-3" />
                </button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
