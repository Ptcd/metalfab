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

// Human-readable labels for every status — use these anywhere we show a
// dropdown, filter option, or badge to a VA. The underscored values only
// belong in the database.
export const STATUS_LABELS: Record<OpportunityStatus, string> = {
  new: 'Inbox (unscreened)',
  reviewing: 'Under Review',
  awaiting_qa: 'Awaiting AI Analysis',
  qa_qualified: 'Ready for Estimator',
  qa_rejected: 'AI Rejected',
  bidding: 'Bidding',
  won: 'Won',
  lost: 'Lost',
  passed: 'Passed',
};

// Inbound categories come off the GC's bid package; internal categories are
// artifacts TCB produces (shop drawings, proposals, takeoffs, jobsite photos).
export type DocumentCategory =
  // inbound (from GC / agency)
  | 'specification'
  | 'drawing'
  | 'addendum'
  | 'general'
  | 'form'
  // internal (TCB produced)
  | 'shop_drawing'
  | 'proposal'
  | 'takeoff'
  | 'estimate'
  | 'rfi'
  | 'rfi_response'
  | 'submittal'
  | 'photo'
  | 'contract'
  | 'internal';

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  specification: 'Specification',
  drawing: 'Drawing',
  addendum: 'Addendum',
  general: 'General',
  form: 'Form',
  shop_drawing: 'Shop Drawing',
  proposal: 'Proposal',
  takeoff: 'Takeoff',
  estimate: 'Estimate',
  rfi: 'RFI',
  rfi_response: 'RFI Response',
  submittal: 'Submittal',
  photo: 'Photo',
  contract: 'Contract',
  internal: 'Internal',
};

export const INBOUND_CATEGORIES: DocumentCategory[] = [
  'specification', 'drawing', 'addendum', 'general', 'form',
];
export const INTERNAL_CATEGORIES: DocumentCategory[] = [
  'shop_drawing', 'proposal', 'takeoff', 'estimate',
  'rfi', 'rfi_response', 'submittal', 'photo', 'contract', 'internal',
];

export interface BidDocument {
  filename: string;
  storage_path: string;
  downloaded_at: string;
  file_size: number;
  mime_type: string;
  category: DocumentCategory;
  // Optional — present on manually uploaded artifacts
  uploaded_by?: string | null;
  description?: string | null;
  version?: number;
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

export type SourceChannel = 'scraper' | 'email' | 'manual' | 'api' | 'referral';
export type AddedVia = 'scraper' | 'quick-add' | 'pdf-drop' | 'email-forward' | 'api' | 'email-ingest';
export type Confidence = 'hot' | 'warm' | 'cold';

export interface Customer {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  notes: string | null;
  first_seen: string;
  last_contact: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerInsert {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  notes?: string | null;
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
  source_channel: SourceChannel;
  added_by: string | null;
  added_via: AddedVia | null;
  referrer: string | null;
  customer_id: string | null;
  estimated_value: number | null;
  confidence: Confidence | null;
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
  source_channel?: SourceChannel;
  added_by?: string | null;
  added_via?: AddedVia | null;
  referrer?: string | null;
  customer_id?: string | null;
  estimated_value?: number | null;
  confidence?: Confidence | null;
  raw_data?: Record<string, unknown> | null;
  notes?: string | null;
  status?: OpportunityStatus;
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
