export interface ScoringConfig {
  id: string;
  keyword_primary: string[];
  keyword_secondary: string[];
  keyword_disqualify: string[];
  naics_codes: string[];
  dollar_min: number;
  dollar_max: number;
  score_green: number;
  score_yellow: number;
  updated_at: string;
}

export interface ScoringConfigUpdate {
  keyword_primary?: string[];
  keyword_secondary?: string[];
  keyword_disqualify?: string[];
  naics_codes?: string[];
  dollar_min?: number;
  dollar_max?: number;
  score_green?: number;
  score_yellow?: number;
}

export interface ScoreSignal {
  signal: string;
  delta: number;
  fired: boolean;
}

export interface ScoreResult {
  score: number;
  signals: ScoreSignal[];
}
