import { createFileRoute, Link } from "@tanstack/react-router";
import { Star, Plug } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/insights/reputation")({
  head: () => ({
    meta: [
      { title: "Reputation — Insights" },
      { name: "description", content: "Reviews, ratings, and reputation across your connected review platforms." },
    ],
  }),
  component: ReputationPage,
});

// No review-platform integration (Google Business Profile, Yelp, Houzz,
// Angi, …) exists yet in this app — see settings.integrations.tsx / the
// meta-integrations skill for what's actually wired up. This page
// previously rendered entirely hardcoded reviews/ratings and a fake
// "Request reviews" success toast; until a real platform is connected
// there is no metric to show, so this is an honest empty state rather
// than fabricated numbers.
function ReputationPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reputation</h1>
          <p className="text-sm text-muted-foreground">Reviews, ratings, and review-request performance.</p>
        </div>
      </header>

      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary">
            <Star className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="text-sm font-medium">No review platform connected</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Connect Google, Yelp, Houzz, or Angi to see ratings, reviews, and
              review-request performance here.
            </p>
          </div>
          <Button asChild size="sm" className="mt-2">
            <Link to="/settings/integrations">
              <Plug className="mr-1.5 h-3.5 w-3.5" /> Go to Integrations
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
