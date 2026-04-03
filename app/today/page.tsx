import { createServiceClient } from "@/lib/db/supabase";
import Link from "next/link";
import { ScoreBadge } from "../components/ScoreBadge";

export const dynamic = "force-dynamic";

function daysUntil(dateStr: string): number {
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatDeadline(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function urgencyTag(days: number): { label: string; className: string } {
  if (days <= 0) return { label: "EXPIRED", className: "bg-slate-500 text-white" };
  if (days <= 3) return { label: `${days}d LEFT`, className: "bg-red-600 text-white animate-pulse" };
  if (days <= 7) return { label: `${days}d left`, className: "bg-orange-500 text-white" };
  if (days <= 14) return { label: `${days}d left`, className: "bg-yellow-500 text-white" };
  return { label: `${days}d left`, className: "bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200" };
}

export default async function TodayPage() {
  const supabase = createServiceClient();

  const { data: config } = await supabase
    .from("scoring_config")
    .select("score_green, score_yellow")
    .limit(1)
    .single();

  const greenThreshold = config?.score_green ?? 70;
  const yellowThreshold = config?.score_yellow ?? 40;

  // Reviewing opportunities (your action items)
  const { data: reviewing } = await supabase
    .from("opportunities")
    .select("id, title, agency, score, response_deadline, notes, dollar_min, dollar_max, source_url, updated_at")
    .eq("status", "reviewing")
    .order("response_deadline", { ascending: true });

  // Bidding opportunities (actively pursuing)
  const { data: bidding } = await supabase
    .from("opportunities")
    .select("id, title, agency, score, response_deadline, notes, dollar_min, dollar_max")
    .eq("status", "bidding")
    .order("response_deadline", { ascending: true });

  // New (unreviewed — should be 0 after morning cron, nonzero = cron found stuff)
  const { count: newCount } = await supabase
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .eq("status", "new");

  // Recently passed (last 24 hours) — shows what the cron filtered out
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { count: recentlyPassed } = await supabase
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .eq("status", "passed")
    .gte("updated_at", yesterday.toISOString());

  // Stats
  const { count: totalReviewing } = await supabase
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .eq("status", "reviewing");
  const { count: totalBidding } = await supabase
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .eq("status", "bidding");
  const { count: totalWon } = await supabase
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .eq("status", "won");

  const now = new Date();

  // Split reviewing into urgent (<=7d) and upcoming
  const urgent = (reviewing ?? []).filter(
    (o) => o.response_deadline && daysUntil(o.response_deadline) <= 7 && daysUntil(o.response_deadline) > 0
  );
  const upcoming = (reviewing ?? []).filter(
    (o) => !o.response_deadline || daysUntil(o.response_deadline) > 7
  );

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
          Daily Brief
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalReviewing ?? 0}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Reviewing</p>
        </div>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{totalBidding ?? 0}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Bidding</p>
        </div>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{totalWon ?? 0}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Won</p>
        </div>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-slate-500">{recentlyPassed ?? 0}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Filtered (24h)</p>
        </div>
      </div>

      {/* New unreviewed alert */}
      {(newCount ?? 0) > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2">
            <span className="text-blue-600 dark:text-blue-400 text-lg font-bold">{newCount}</span>
            <span className="text-blue-800 dark:text-blue-200 text-sm font-medium">
              new opportunities need review
            </span>
          </div>
          <Link href="/dashboard?status=new" className="text-blue-600 dark:text-blue-400 text-sm underline mt-1 block">
            Review now →
          </Link>
        </div>
      )}

      {/* URGENT — deadlines within 7 days */}
      {urgent.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider mb-3">
            Urgent — Due This Week
          </h3>
          <div className="space-y-3">
            {urgent.map((opp) => {
              const days = daysUntil(opp.response_deadline);
              const tag = urgencyTag(days);
              return (
                <Link
                  key={opp.id}
                  href={`/opportunity/${opp.id}`}
                  className="block bg-white dark:bg-slate-800 border border-red-200 dark:border-red-900/50 rounded-lg p-4 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tag.className}`}>
                          {tag.label}
                        </span>
                        <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
                      </div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {opp.title}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {opp.agency} · Due {formatDeadline(opp.response_deadline)}
                      </p>
                      {opp.notes && (
                        <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">
                          {opp.notes}
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Active bids */}
      {(bidding?.length ?? 0) > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-3">
            Active Bids
          </h3>
          <div className="space-y-2">
            {bidding?.map((opp) => {
              const days = opp.response_deadline ? daysUntil(opp.response_deadline) : null;
              const tag = days != null ? urgencyTag(days) : null;
              return (
                <Link
                  key={opp.id}
                  href={`/opportunity/${opp.id}`}
                  className="block bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{opp.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{opp.agency}</p>
                    </div>
                    {tag && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ml-3 ${tag.className}`}>
                        {tag.label}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Upcoming — reviewing with more time */}
      {upcoming.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-3">
            In The Pipeline
          </h3>
          <div className="space-y-2">
            {upcoming.map((opp) => {
              const days = opp.response_deadline ? daysUntil(opp.response_deadline) : null;
              const tag = days != null ? urgencyTag(days) : null;
              return (
                <Link
                  key={opp.id}
                  href={`/opportunity/${opp.id}`}
                  className="block bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
                        {tag && (
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${tag.className}`}>
                            {tag.label}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{opp.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {opp.agency}
                        {opp.response_deadline && ` · Due ${formatDeadline(opp.response_deadline)}`}
                      </p>
                      {opp.notes && (
                        <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">
                          {opp.notes}
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Empty state */}
      {(reviewing?.length ?? 0) === 0 && (bidding?.length ?? 0) === 0 && (newCount ?? 0) === 0 && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-8 text-center">
          <p className="text-slate-500 dark:text-slate-400">No opportunities in the pipeline right now.</p>
          <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
            The daily cron runs at 6am CT — check back tomorrow morning.
          </p>
        </div>
      )}
    </div>
  );
}
