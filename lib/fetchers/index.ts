import { createServiceClient } from '@/lib/db/supabase';
import { scoreOpportunity } from '@/lib/scoring/engine';
import { fetchSamGovOpportunities } from './samgov';
import { ScoringConfig } from '@/types/scoring';
import { OpportunityInsert } from '@/types/opportunity';

export interface FetchResult {
  fetched: number;
  inserted: number;
  errors: string[];
}

async function getScoringConfig(): Promise<ScoringConfig> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('scoring_config')
    .select('*')
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load scoring config: ${error?.message}`);
  }

  return data as ScoringConfig;
}

export async function runFetchPipeline(daysBack: number = 1): Promise<FetchResult> {
  const config = await getScoringConfig();
  const supabase = createServiceClient();
  const errors: string[] = [];

  // Fetch from SAM.gov
  let opportunities: OpportunityInsert[] = [];
  try {
    opportunities = await fetchSamGovOpportunities(config.naics_codes, daysBack);
  } catch (err) {
    errors.push(`SAM.gov fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Score and insert each opportunity
  let inserted = 0;
  for (const opp of opportunities) {
    const { score, signals } = scoreOpportunity(
      {
        title: opp.title,
        description: opp.description ?? null,
        naics_code: opp.naics_code ?? null,
        dollar_min: opp.dollar_min ?? null,
        dollar_max: opp.dollar_max ?? null,
      },
      config
    );

    const { error } = await supabase.from('opportunities').upsert(
      {
        ...opp,
        score,
        score_signals: signals,
        status: 'new',
      },
      { onConflict: 'sam_notice_id', ignoreDuplicates: true }
    );

    if (error) {
      errors.push(`Insert error for ${opp.sam_notice_id}: ${error.message}`);
    } else {
      inserted++;
    }
  }

  return {
    fetched: opportunities.length,
    inserted,
    errors,
  };
}
