-- Takeoff Engine: per-opportunity scope + quantity + priced line items.
-- Output of Module 2. Consumes plan_intelligence, rate_card_versions,
-- assembly_labor_priors, steel_shapes; feeds Module 3 (Bid Pricer) and
-- Module 4 (Audit Agent).
--
-- Two tables. takeoff_runs is the bid header (one per estimate
-- attempt; multiple attempts per opp are fine — UI surfaces the latest).
-- takeoff_lines is each line item with provenance, quantity, weight,
-- labor, finish, and resolved cost.

CREATE TABLE IF NOT EXISTS takeoff_runs (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id           uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,

  -- Bid stage shapes the prompt + the assumption density. From plan_intelligence.
  stage                    text NOT NULL CHECK (stage IN ('pre_gmp_rfp','final_cd','unknown')),
  rate_card_version_id     uuid REFERENCES rate_card_versions(id),

  -- Generation metadata
  generated_by             text NOT NULL,             -- 'oauth-claude-code' | 'manual' | 'api'
  generator_version        text,                      -- prompt template version
  generated_at             timestamptz NOT NULL DEFAULT now(),

  -- Roll-up (computed on commit; nullable until lines exist)
  total_weight_lbs         numeric,
  total_fab_hrs            numeric,
  total_det_hrs            numeric,
  total_foreman_hrs        numeric,
  total_ironworker_hrs     numeric,
  total_deliveries         numeric,
  material_subtotal_usd    numeric,
  labor_subtotal_usd       numeric,
  finish_subtotal_usd      numeric,
  fixed_costs_usd          numeric,                   -- delivery + bond + etc.
  subtotal_usd             numeric,
  overhead_usd             numeric,
  profit_usd               numeric,
  bid_total_usd            numeric,

  -- Three-scenario output (Module 5 will populate these; nullable in v1)
  conservative_bid_usd     numeric,
  expected_bid_usd         numeric,
  aggressive_bid_usd       numeric,

  -- Confidence + readiness
  confidence_avg           numeric,                   -- 0-1
  flagged_lines_count      int NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','approved','submitted','superseded','failed')),

  notes                    text,
  raw_output               jsonb,                     -- exact JSON from generator

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_runs_opp        ON takeoff_runs (opportunity_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_takeoff_runs_status     ON takeoff_runs (status);

CREATE TRIGGER takeoff_runs_updated_at
  BEFORE UPDATE ON takeoff_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE takeoff_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read takeoff_runs" ON takeoff_runs;
CREATE POLICY "Authenticated users can read takeoff_runs"
  ON takeoff_runs FOR SELECT TO authenticated USING (true);

-- ============================================================
-- takeoff_lines — one row per scope item with full provenance + cost
-- ============================================================
CREATE TABLE IF NOT EXISTS takeoff_lines (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  takeoff_run_id           uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  line_no                  int NOT NULL,              -- 1-based ordering within run

  -- Scope identity
  category                 text NOT NULL,             -- 'lintel' | 'pipe_support' | 'frame' | 'bollard' | …
  description              text NOT NULL,
  in_tcb_scope             boolean NOT NULL DEFAULT true,
  assembly_type            text,                      -- maps to assembly_labor_priors.assembly_type

  -- Provenance — where did this line come from?
  source_kind              text NOT NULL CHECK (source_kind IN ('spec','qa','drawing','assumption','industry_default')),
  source_filename          text,
  source_section           text,                      -- '05 50 00' or 'Q9'
  source_page              int,
  source_evidence          text,                      -- short verbatim quote

  -- Quantity (point estimate + optional band)
  quantity                 numeric NOT NULL,
  quantity_unit            text NOT NULL,             -- 'EA' | 'LF' | 'SF' | 'LBS' | 'LS'
  quantity_band            text NOT NULL DEFAULT 'point'
    CHECK (quantity_band IN ('point','range','assumed_typical')),
  quantity_min             numeric,
  quantity_max             numeric,

  -- Material — links to steel_shapes catalog when known
  steel_shape_id           uuid REFERENCES steel_shapes(id),
  steel_shape_designation  text,
  unit_weight              numeric,                   -- lb/ft or lb/ea
  unit_weight_unit         text,                      -- 'lb/ft' | 'lb/ea'
  total_weight_lbs         numeric,
  material_grade           text,                      -- 'A36' | 'A992' | …

  -- Labor (per line; sum populates takeoff_runs roll-up)
  fab_hrs                  numeric,
  det_hrs                  numeric,
  foreman_hrs              numeric,
  ironworker_hrs           numeric,

  -- Finish
  finish                   text,                      -- 'galvanized' | 'shop_primer' | 'powder_coat' | 'none'
  finish_surface_sf        numeric,
  finish_cost_usd          numeric,

  -- Resolved costs
  material_cost_usd        numeric,
  labor_cost_usd           numeric,
  line_total_usd           numeric,

  -- Confidence + flags
  confidence               numeric NOT NULL DEFAULT 0.5,
  flagged_for_review       boolean NOT NULL DEFAULT false,
  assumptions              text,                      -- explicit assumption notes
  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT takeoff_lines_unique_no UNIQUE (takeoff_run_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_takeoff_lines_run      ON takeoff_lines (takeoff_run_id, line_no);
CREATE INDEX IF NOT EXISTS idx_takeoff_lines_category ON takeoff_lines (category);
CREATE INDEX IF NOT EXISTS idx_takeoff_lines_flagged  ON takeoff_lines (flagged_for_review)
  WHERE flagged_for_review = true;

ALTER TABLE takeoff_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read takeoff_lines" ON takeoff_lines;
CREATE POLICY "Authenticated users can read takeoff_lines"
  ON takeoff_lines FOR SELECT TO authenticated USING (true);
