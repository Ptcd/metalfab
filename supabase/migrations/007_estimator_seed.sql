-- Estimator seed: rate card, steel shape catalog, assembly labor priors.
-- Initial values pulled from REV(0)_Gilmore Fine Arts School renovation (2).xlsx
-- — TCB's working Bluebeam-derived takeoff template. Treat these as Thomas's
-- current point estimates; the 2-hour interview will refine to ranges.
-- All additive — existing data unchanged. Idempotent: safe to re-run.

-- ============================================================
-- rate_card_versions — versioned $/hr, $/lb, factors. Each bid
-- snapshots a version_id so historical bids stay reproducible.
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_card_versions (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  effective_from           date NOT NULL DEFAULT current_date,
  effective_to             date,                     -- NULL = current
  source                   text,                     -- 'gilmore-2026-04', 'thomas-interview-2026-05', etc.
  notes                    text,

  -- Material $/lb
  steel_per_lb             numeric NOT NULL,
  stainless_per_lb         numeric NOT NULL,

  -- Labor $/hr
  fab_per_hr               numeric NOT NULL,
  det_per_hr               numeric NOT NULL,         -- detailing / shop drawings
  eng_per_hr               numeric NOT NULL,         -- PE / engineering
  foreman_per_hr           numeric NOT NULL,
  ironworker_per_hr        numeric NOT NULL,

  -- Finish
  galv_per_lb              numeric NOT NULL,
  paint_factor             numeric NOT NULL,         -- multiplier on material cost (legacy template convention)
  grating_per_sf           numeric NOT NULL,
  deck_per_sf              numeric NOT NULL,

  -- Logistics / fixed
  delivery_flat            numeric NOT NULL,         -- per delivery
  equipment_flat           numeric NOT NULL DEFAULT 0,

  -- Roll-up factors (decimals — 0.10 = 10%)
  waste_factor             numeric NOT NULL,         -- weight uplift (typ 0.10)
  sales_tax                numeric NOT NULL,
  overhead                 numeric NOT NULL,
  profit                   numeric NOT NULL,
  bond_default             numeric NOT NULL,         -- typ 0.028; bid-level override allowed

  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_card_versions_dates_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_rate_card_current
  ON rate_card_versions (effective_from DESC)
  WHERE effective_to IS NULL;

ALTER TABLE rate_card_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read rate_card_versions" ON rate_card_versions;
CREATE POLICY "Authenticated users can read rate_card_versions"
  ON rate_card_versions FOR SELECT TO authenticated USING (true);

-- ============================================================
-- steel_shapes — shape catalog with unit weight. AISC standard
-- shapes + custom entries observed in past bids. The `source`
-- field tracks provenance so we can audit suspicious weights.
-- ============================================================
CREATE TABLE IF NOT EXISTS steel_shapes (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  designation              text NOT NULL,            -- 'W8x10', 'HSS4x4x1/2', '1.5" pipe sch 40'
  shape_family             text NOT NULL,            -- 'W' | 'HSS' | 'PIPE' | 'ANGLE' | 'CHANNEL' | 'PLATE' | 'BAR' | 'CUSTOM'
  unit                     text NOT NULL CHECK (unit IN ('lb/ft', 'lb/ea')),
  unit_weight              numeric NOT NULL,         -- lb per ft (LF items) or lb per piece (EA items)
  description              text,
  aisc_table               text,                     -- 'Table 1-1' | 'Table 1-11' | etc. NULL for custom
  source                   text,                     -- 'aisc-15th-ed' | 'gilmore-2026-04' | etc.
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steel_shapes_designation_unique UNIQUE (designation, unit)
);

CREATE INDEX IF NOT EXISTS idx_steel_shapes_family ON steel_shapes (shape_family);
CREATE INDEX IF NOT EXISTS idx_steel_shapes_designation_trgm
  ON steel_shapes USING gin (designation gin_trgm_ops);

-- gin_trgm_ops requires pg_trgm extension; enable if absent
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE steel_shapes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read steel_shapes" ON steel_shapes;
CREATE POLICY "Authenticated users can read steel_shapes"
  ON steel_shapes FOR SELECT TO authenticated USING (true);

-- ============================================================
-- assembly_labor_priors — per-assembly-type hour estimates.
-- Mirrors how Thomas/the Bluebeam template actually allocates
-- labor: by assembly (Stair#14, Bollard set, Lintel set), not
-- by individual line item. Min/expected/max supports the
-- three-scenario bid output (conservative / expected / aggressive).
-- ============================================================
CREATE TABLE IF NOT EXISTS assembly_labor_priors (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  assembly_type            text NOT NULL,            -- 'pan_stair' | 'wall_handrail_run' | 'guardrail_run' | 'lintel_set' | 'bollard_set' | 'hss_framing' | 'w_framing' | 'mezzanine' | 'misc'
  size_band                text,                     -- 'small' | 'medium' | 'large' — by total weight or count
  description              text,

  -- Hours (point estimate from the seed file)
  fab_hrs_expected         numeric NOT NULL,
  det_hrs_expected         numeric NOT NULL,
  eng_hrs_expected         numeric NOT NULL DEFAULT 0,
  foreman_hrs_expected     numeric NOT NULL,
  ironworker_hrs_expected  numeric NOT NULL,
  deliveries_expected      numeric NOT NULL DEFAULT 0,

  -- Confidence interval (for the three-scenario simulator).
  -- Default = expected ± 25%; Thomas interview will tighten.
  fab_hrs_min              numeric,
  fab_hrs_max              numeric,
  ironworker_hrs_min       numeric,
  ironworker_hrs_max       numeric,

  -- Calibration sample
  source                   text NOT NULL,            -- 'gilmore-2026-04' (seed); later 'actuals-job-<id>'
  sample_count             int NOT NULL DEFAULT 1,   -- jobs informing this prior
  total_weight_lbs         numeric,                  -- the weight on the seed job (for size-band mapping)

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assembly_labor_priors_unique UNIQUE (assembly_type, size_band, source)
);

CREATE TRIGGER assembly_labor_priors_updated_at
  BEFORE UPDATE ON assembly_labor_priors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_assembly_labor_type ON assembly_labor_priors (assembly_type);

ALTER TABLE assembly_labor_priors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read assembly_labor_priors" ON assembly_labor_priors;
CREATE POLICY "Authenticated users can read assembly_labor_priors"
  ON assembly_labor_priors FOR SELECT TO authenticated USING (true);

-- ============================================================
-- SEED: rate card v1 from Gilmore Fine Arts School template
-- (REV(0), 2026-04-20). Effective until next versioned update.
-- ============================================================
INSERT INTO rate_card_versions (
  effective_from, source, notes,
  steel_per_lb, stainless_per_lb,
  fab_per_hr, det_per_hr, eng_per_hr, foreman_per_hr, ironworker_per_hr,
  galv_per_lb, paint_factor, grating_per_sf, deck_per_sf,
  delivery_flat, equipment_flat,
  waste_factor, sales_tax, overhead, profit, bond_default
) SELECT
  '2026-04-20', 'gilmore-2026-04',
  'Initial rate card seeded from Gilmore Fine Arts School Bluebeam takeoff template. Replace effective_to and insert new row when Thomas updates rates.',
  1.25, 7.50,
  100, 75, 200, 100, 100,
  0.95, 0.60, 35, 4,
  660, 0,
  0.10, 0.055, 0.15, 0.10, 0.028
WHERE NOT EXISTS (SELECT 1 FROM rate_card_versions WHERE source = 'gilmore-2026-04');

-- ============================================================
-- SEED: steel shapes observed in Gilmore takeoff. AISC weights
-- where standard; custom/derived entries flagged in source.
-- Bulk-load AISC shape tables in a follow-up migration.
-- ============================================================
INSERT INTO steel_shapes (designation, shape_family, unit, unit_weight, description, aisc_table, source)
VALUES
  -- Pipe
  ('1 1/2" pipe',           'PIPE',  'lb/ft', 2.72,   '1 1/2" dia. steel pipe (handrail)',                    'Table 1-14', 'gilmore-2026-04'),
  ('2" pipe (11 GA)',       'PIPE',  'lb/ft', 2.41,   '2" dia. steel pipe, 11 GA assumed',                    NULL,         'gilmore-2026-04'),
  ('6" pipe sch 80',        'PIPE',  'lb/ft', 28.57,  '6" dia. schedule 80 pipe (bollards)',                  'Table 1-14', 'gilmore-2026-04'),

  -- W shapes
  ('W8x10',                 'W',     'lb/ft', 10.0,   'W8x10 wide flange',                                    'Table 1-1',  'gilmore-2026-04'),
  ('W8x15',                 'W',     'lb/ft', 15.0,   'W8x15 wide flange',                                    'Table 1-1',  'gilmore-2026-04'),
  ('W8x21',                 'W',     'lb/ft', 21.0,   'W8x21 wide flange',                                    'Table 1-1',  'gilmore-2026-04'),

  -- HSS
  ('HSS4x4x1/4',            'HSS',   'lb/ft', 21.5,   'HSS4x4x1/4 square tube (NB: gilmore template uses 21.5; AISC = 12.21)', 'Table 1-11', 'gilmore-2026-04'),
  ('HSS4x4x1/2',            'HSS',   'lb/ft', 21.5,   'HSS4x4x1/2 square tube',                               'Table 1-11', 'gilmore-2026-04'),

  -- Plates and bars (lb/ft of given cross-section)
  ('PL 3/8 x 12',           'PLATE', 'lb/ft', 15.336, '3/8" x 12" plate strip (stair stringer)',              NULL,         'gilmore-2026-04'),
  ('PL 3/8 x 6',            'PLATE', 'lb/ft', 7.668,  '3/8" x 6" plate strip (lintel vertical PL)',           NULL,         'gilmore-2026-04'),

  -- Per-piece custom items (lb/ea — already includes piece dimensions)
  ('L2x2x1/4 - 6"L',        'ANGLE', 'lb/ea', 3.19,   'L2x2x1/4 angle, 6" long (per Gilmore template)',      NULL,         'gilmore-2026-04'),
  ('L1.25x1.25x1/8 - 9"L',  'ANGLE', 'lb/ea', 2.3925, 'L1 1/4 x 1 1/4 x 1/8 angle, 9" long',                  NULL,         'gilmore-2026-04'),
  ('L1.25x1.25x1/8 - 4"L',  'ANGLE', 'lb/ea', 1.0846, 'L1 1/4 x 1 1/4 x 1/8 angle, 4" long',                  NULL,         'gilmore-2026-04'),
  ('PL 7x7x1/2',            'PLATE', 'lb/ea', 6.958,  '7" x 7" x 1/2" bearing plate',                         NULL,         'gilmore-2026-04'),
  ('PL 10x10x1/2 BP',       'PLATE', 'lb/ea', 14.2,   '10" x 10" x 1/2" base plate',                          NULL,         'gilmore-2026-04'),
  ('PL 4x4x1/4 TP',         'PLATE', 'lb/ea', 1.136,  '4" x 4" x 1/4" top plate',                             NULL,         'gilmore-2026-04'),
  ('PL 6x3.5x3/8',          'PLATE', 'lb/ea', 2.2365, '6" x 3 1/2" x 3/8" plate',                             NULL,         'gilmore-2026-04'),
  ('Pan tread 3-3 x 1-11',  'CUSTOM','lb/ea', 10.64,  '3''-3" x 1''-11" 12 GA bent pan, tread + riser',       NULL,         'gilmore-2026-04'),
  ('Pan riser 3-0 x 9',     'CUSTOM','lb/ea', 6.8375, '3''-0" x 9" 12 GA bent pan, riser only',               NULL,         'gilmore-2026-04')
ON CONFLICT (designation, unit) DO NOTHING;

-- ============================================================
-- SEED: assembly labor priors from Gilmore phase totals.
-- Each row is a single observed job; sample_count starts at 1.
-- The auto-recalibration job (future) will fold in actuals.
-- ============================================================
INSERT INTO assembly_labor_priors (
  assembly_type, size_band, description,
  fab_hrs_expected, det_hrs_expected, eng_hrs_expected,
  foreman_hrs_expected, ironworker_hrs_expected, deliveries_expected,
  fab_hrs_min, fab_hrs_max, ironworker_hrs_min, ironworker_hrs_max,
  source, sample_count, total_weight_lbs
) VALUES
  ('pan_stair',          'medium', 'Stair#14: ~350 lbs incl. railings, stringers, pans, brackets, bolts',
   14, 7, 0, 14, 28, 0.4,
   10, 18, 21, 35,
   'gilmore-2026-04', 1, 350.05),

  ('wall_handrail_run',  'small',  'Stair#12: ~32 lbs, short interior wall-mounted handrail run',
   4, 2, 0, 4, 8, 0.1,
   3, 5, 6, 10,
   'gilmore-2026-04', 1, 31.93),

  ('guardrail_run',      'medium', 'Loading dock + generator railing run, ~477 lbs incl. 42" fall protection',
   18, 8, 0, 16, 32, 0.5,
   13, 23, 24, 40,
   'gilmore-2026-04', 1, 476.92),

  ('lintel_set',         'medium', '7 W-section lintels (W8x10 / W8x21) with 6"x3/8" vertical PL, ~1116 lbs',
   32, 12, 0, 32, 64, 0.5,
   24, 40, 48, 80,
   'gilmore-2026-04', 1, 1115.88),

  ('bollard_set',        'small',  '5 bollards, 6" sch 80 pipe, ~1571 lbs',
   16, 8, 0, 16, 32, 0.8,
   12, 20, 24, 40,
   'gilmore-2026-04', 1, 1571.35),

  ('hss_framing',        'medium', 'Stage partition: HSS4x4x1/2 beams + columns w/ base+top plates, ~2522 lbs',
   22, 10, 0, 24, 48, 1.2,
   16, 28, 36, 60,
   'gilmore-2026-04', 1, 2522.35),

  ('w_framing',          'medium', 'Stage left mezzanine: W8x15 beams + joists, HSS4x4x1/4 columns, ~1966 lbs',
   28, 14, 0, 24, 48, 1.0,
   21, 35, 36, 60,
   'gilmore-2026-04', 1, 1966.01)
ON CONFLICT (assembly_type, size_band, source) DO NOTHING;

-- ============================================================
-- Note on data quality
-- ============================================================
-- Two known anomalies in the Gilmore template that we preserve
-- as-imported (so historical bids reproduce exactly), but flag
-- for Colin to verify in the upcoming Thomas interview:
--
-- 1) HSS4x4x1/4 unit_weight = 21.5 lb/ft. AISC value is 12.21
--    lb/ft. Likely a template error or wall-thickness assumption
--    different from spec. Verify before reusing on a new bid.
--
-- 2) L2x2x1/4 - 6"L unit_weight = 3.19 lb/ea. The shape itself is
--    3.19 lb/ft, so a 6" piece should be ~1.60 lb. Suggests the
--    template entered lb/ft as lb/ea for short pieces. Worth
--    checking the rest of the per-piece angle/plate entries on
--    the next 1-2 bids.
