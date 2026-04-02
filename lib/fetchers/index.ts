import { createServiceClient } from '@/lib/db/supabase';
import { scoreOpportunity } from '@/lib/scoring/engine';
import { fetchSamGovOpportunities } from './samgov';
import { fetchSamGovSGSOpportunities } from './samgov-sgs';
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

async function scoreAndInsert(
  opportunities: OpportunityInsert[],
  config: ScoringConfig,
  errors: string[]
): Promise<number> {
  const supabase = createServiceClient();
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

  return inserted;
}

export async function runFetchPipeline(daysBack: number = 1): Promise<FetchResult> {
  const config = await getScoringConfig();
  const errors: string[] = [];
  const allOpportunities: OpportunityInsert[] = [];

  // 1. Fetch from official SAM.gov API (requires API key)
  let officialFetchFailed = false;
  try {
    const official = await fetchSamGovOpportunities(config.naics_codes, daysBack);
    allOpportunities.push(...official);
  } catch (err) {
    officialFetchFailed = true;
    errors.push(`SAM.gov API fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Fetch from SAM.gov SGS (undocumented frontend API, no key required)
  //    Runs as a supplement to the official API, or as a fallback when it fails.
  const useSGS = process.env.ENABLE_SGS_FETCHER === 'true' || officialFetchFailed;
  if (useSGS) {
    try {
      const sgsOpps = await fetchSamGovSGSOpportunities();
      allOpportunities.push(...sgsOpps);
    } catch (err) {
      errors.push(`SAM.gov SGS fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Score and insert all opportunities
  const inserted = await scoreAndInsert(allOpportunities, config, errors);

  return {
    fetched: allOpportunities.length,
    inserted,
    errors,
  };
}
