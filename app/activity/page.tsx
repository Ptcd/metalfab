import { createServiceClient } from "@/lib/db/supabase";
import Link from "next/link";
import { StatusBadge } from "../components/StatusBadge";
import { ScoreBadge } from "../components/ScoreBadge";
import { OpportunityStatus } from "@/types/opportunity";
import { SystemRunsList, SystemRun } from "./SystemRunsList";

export const dynamic = "force-dynamic";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isUrgent(deadline: string | null): boolean {
  if (!deadline) return false;
  const diff = new Date(deadline).getTime() - Date.now();
  return diff > 0 && diff < 72 * 60 * 60 * 1000;
}

export default async function ActivityPage() {
  const supabase = createServiceClient();

  // Recent system runs (cron + Claude Code)
  const { data: systemRuns } = await supabase
    .from("system_runs")
    .select("id, run_type, started_at, ended_at, status, opportunities_processed, docs_downloaded, docs_purged, errors_encountered, steps_completed, notes")
    .order("started_at", { ascending: false })
    .limit(20);

  // Recent events
  const { data: events } = await supabase
    .from("pipeline_events")
    .select("*, opportunities!inner(id, title, agency)")
    .order("created_at", { ascending: false })
    .limit(30);

  // Upcoming deadlines (next 14 days)
  const now = new Date();
  const twoWeeks = new Date(now);
  twoWeeks.setDate(twoWeeks.getDate() + 14);

  const { data: upcoming } = await supabase
    .from("opportunities")
    .select("id, title, agency, response_deadline, score, status")
    .gte("response_deadline", now.toISOString())
    .lte("response_deadline", twoWeeks.toISOString())
    .in("status", ["new", "reviewing", "bidding"])
    .order("response_deadline", { ascending: true })
    .limit(20);

  // Stats
  const { data: allOpps } = await supabase.from("opportunities").select("status, updated_at");
  const statusCounts: Record<string, number> = {
    new: 0,
    reviewing: 0,
    awaiting_qa: 0,
    qa_qualified: 0,
    qa_rejected: 0,
    bidding: 0,
    won: 0,
    lost: 0,
    passed: 0,
  };
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  let wonThisMonth = 0;
  let lostThisMonth = 0;

  for (const opp of allOpps ?? []) {
    statusCounts[opp.status] = (statusCounts[opp.status] ?? 0) + 1;
    if (opp.updated_at >= monthStart) {
      if (opp.status === "won") wonThisMonth++;
      if (opp.status === "lost") lostThisMonth++;
    }
  }

  const totalActive = statusCounts.new + statusCounts.reviewing + statusCounts.bidding;

  // Config for thresholds
  const { data: config } = await supabase
    .from("scoring_config")
    .select("score_green, score_yellow")
    .limit(1)
    .single();

  const greenThreshold = config?.score_green ?? 70;
  const yellowThreshold = config?.score_yellow ?? 40;

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-6">Activity</h2>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Active" value={totalActive} />
        <StatCard label="Bidding" value={statusCounts.bidding} />
        <StatCard label="Won (month)" value={wonThisMonth} color="emerald" />
        <StatCard label="Lost (month)" value={lostThisMonth} color="red" />
      </div>

      {/* System runs */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">System Runs</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">Click a row to see errors + steps</p>
        </div>
        <SystemRunsList runs={(systemRuns as SystemRun[]) ?? []} />
      </section>

      {/* Upcoming deadlines */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Upcoming Deadlines</h3>
        {(upcoming?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-400">No upcoming deadlines in the next 14 days.</p>
        ) : (
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
            {upcoming?.map((opp) => (
              <Link
                key={opp.id}
                href={`/opportunity/${opp.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{opp.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{opp.agency}</p>
                </div>
                <div className="flex items-center gap-3">
                  <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
                  <span className={`text-sm ${isUrgent(opp.response_deadline) ? "text-red-600 dark:text-red-400 font-semibold" : "text-slate-600 dark:text-slate-300"}`}>
                    {new Date(opp.response_deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent events */}
      <section>
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Recent Activity</h3>
        {(events?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-400">No recent activity.</p>
        ) : (
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
            {events?.map((ev) => (
              <Link
                key={ev.id}
                href={`/opportunity/${ev.opportunity_id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div>
                  <p className="text-sm text-slate-900 dark:text-white">
                    <span className="font-medium">{ev.opportunities?.title ?? "Unknown"}</span>
                    {" — "}
                    <EventDescription type={ev.event_type} oldVal={ev.old_value} newVal={ev.new_value} />
                  </p>
                </div>
                <span className="text-xs text-slate-400 shrink-0 ml-4">{timeAgo(ev.created_at)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EventDescription({ type, oldVal, newVal }: { type: string; oldVal: string | null; newVal: string | null }) {
  switch (type) {
    case "status_change":
      return (
        <span>
          moved from <StatusBadge status={(oldVal ?? "new") as OpportunityStatus} /> to <StatusBadge status={(newVal ?? "new") as OpportunityStatus} />
        </span>
      );
    case "note_added":
      return <span className="text-slate-500 dark:text-slate-400">note updated</span>;
    case "created":
      return <span className="text-slate-500 dark:text-slate-400">added to pipeline</span>;
    default:
      return <span className="text-slate-500 dark:text-slate-400">{type}</span>;
  }
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  const textColor = color === "emerald"
    ? "text-emerald-600 dark:text-emerald-400"
    : color === "red"
    ? "text-red-600 dark:text-red-400"
    : "text-slate-900 dark:text-white";

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${textColor}`}>{value}</p>
    </div>
  );
}
