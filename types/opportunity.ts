export type OpportunityStatus = 'new' | 'reviewing' | 'bidding' | 'won' | 'lost' | 'passed';

export interface Opportunity {
  id: string;
  sam_notice_id: string | null;
  title: string;
  description: string | null;
  agency: string | null;
  sub_agency: string | null;
  naics_code: string | null;
  naics_description: string | null;
  dollar_min: number | null;
  dollar_max: number | null;
  posted_date: string | null;
  response_deadline: string | null;
  point_of_contact: string | null;
  contact_email: string | null;
  source_url: string | null;
  place_of_performance: string | null;
  source: string;
  raw_data: Record<string, unknown> | null;
  score: number;
  score_signals: ScoreSignal[];
  status: OpportunityStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScoreSignal {
  signal: string;
  delta: number;
  fired: boolean;
}

export interface OpportunityInsert {
  sam_notice_id?: string | null;
  title: string;
  description?: string | null;
  agency?: string | null;
  sub_agency?: string | null;
  naics_code?: string | null;
  naics_description?: string | null;
  dollar_min?: number | null;
  dollar_max?: number | null;
  posted_date?: string | null;
  response_deadline?: string | null;
  point_of_contact?: string | null;
  contact_email?: string | null;
  source_url?: string | null;
  place_of_performance?: string | null;
  source?: string;
  raw_data?: Record<string, unknown> | null;
  notes?: string | null;
}

export interface OpportunityUpdate {
  status?: OpportunityStatus;
  notes?: string | null;
  title?: string;
  description?: string | null;
  agency?: string | null;
  dollar_min?: number | null;
  dollar_max?: number | null;
  response_deadline?: string | null;
}
