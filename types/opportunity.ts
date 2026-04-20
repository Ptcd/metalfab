export type OpportunityStatus =
  | 'new'
  | 'reviewing'
  | 'bidding'
  | 'won'
  | 'lost'
  | 'passed'
  | 'awaiting_qa'
  | 'qa_qualified'
  | 'qa_rejected';

export type DocumentCategory =
  | 'specification'
  | 'drawing'
  | 'addendum'
  | 'general'
  | 'form';

export interface BidDocument {
  filename: string;
  storage_path: string;
  downloaded_at: string;
  file_size: number;
  mime_type: string;
  category: DocumentCategory;
}

export type QaRecommendation = 'bid' | 'pass' | 'human_review_needed';

export type QaRiskFlag =
  | 'bonding_required'
  | 'prevailing_wage'
  | 'dbe_requirement'
  | 'pre_qualification_required'
  | 'davis_bacon'
  | 'union_only'
  | 'aws_certification_required'
  | 'aisc_certification_required'
  | 'pe_stamp_required'
  | 'insurance_above_standard'
  | 'performance_bond_above_100k';

export interface QaReport {
  scope_summary: string;
  steel_metals_present: boolean;
  steel_metals_estimated_value_usd: number | null;
  risk_flags: QaRiskFlag[];
  scope_exclusions: string[];
  due_date_confirmed: string | null;
  pre_bid_meeting: string | null;
  location_address: string | null;
  recommendation: QaRecommendation;
  recommendation_reasoning: string;
  analyzed_at: string;
}

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
  documents: BidDocument[];
  qa_report: QaReport | null;
  qa_needs_human_review: boolean;
  docs_purged_at: string | null;
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
