import { createServiceClient } from "@/lib/db/supabase";
import { ScoringConfig } from "@/types/scoring";
import { ConfigEditor } from "./ConfigEditor";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("scoring_config")
    .select("*")
    .limit(1)
    .single();

  if (error || !data) {
    return <div className="text-red-500">Failed to load config: {error?.message}</div>;
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-6">Scoring Config</h2>
      <ConfigEditor config={data as ScoringConfig} />
    </div>
  );
}
