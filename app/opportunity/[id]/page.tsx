import { createServiceClient } from "@/lib/db/supabase";
import { Opportunity } from "@/types/opportunity";
import { notFound } from "next/navigation";
import { OpportunityDetail } from "./OpportunityDetail";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: { id: string } }) {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error || !data) notFound();

  // Load config for thresholds
  const { data: config } = await supabase
    .from("scoring_config")
    .select("score_green, score_yellow")
    .limit(1)
    .single();

  return (
    <OpportunityDetail
      opportunity={data as Opportunity}
      greenThreshold={config?.score_green ?? 70}
      yellowThreshold={config?.score_yellow ?? 40}
    />
  );
}
