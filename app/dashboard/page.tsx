import { createServiceClient } from "@/lib/db/supabase";
import { Opportunity } from "@/types/opportunity";
import { PipelineTable } from "./PipelineTable";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { status?: string; score_min?: string; score_max?: string; search?: string };
}) {
  const supabase = createServiceClient();

  // Default to "reviewing" — these are the vetted opportunities ready for human decision
  // "new" will be empty after each morning auto-triage run
  const activeStatus = searchParams.status ?? "reviewing";

  let query = supabase
    .from("opportunities")
    .select("*", { count: "exact" })
    .order("score", { ascending: false })
    .order("response_deadline", { ascending: true })
    .limit(100);

  // "all" shows everything, otherwise filter by status
  if (activeStatus !== "all") query = query.eq("status", activeStatus);

  // Hide expired opps on the unscreened `new` queue only — once a human has
  // put something in reviewing, they should still see it even if the deadline
  // slipped (they may need to change its status).
  if (activeStatus === "new") {
    query = query.or("response_deadline.is.null,response_deadline.gte." + new Date().toISOString());
  }
  if (searchParams.score_min) query = query.gte("score", parseInt(searchParams.score_min));
  if (searchParams.score_max) query = query.lte("score", parseInt(searchParams.score_max));
  if (searchParams.search) {
    query = query.or(
      `title.ilike.%${searchParams.search}%,agency.ilike.%${searchParams.search}%`
    );
  }

  // Load config for score thresholds
  const { data: config } = await supabase
    .from("scoring_config")
    .select("score_green, score_yellow")
    .limit(1)
    .single();

  const { data, count } = await query;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Pipeline</h2>
      </div>
      <PipelineTable
        opportunities={(data as Opportunity[]) ?? []}
        count={count ?? 0}
        greenThreshold={config?.score_green ?? 70}
        yellowThreshold={config?.score_yellow ?? 40}
        filters={searchParams}
      />
    </div>
  );
}
