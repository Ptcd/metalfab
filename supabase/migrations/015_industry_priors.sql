-- Industry priors: RSMeans-style typical ranges per scope category.
-- Used by the takeoff validator to bracket the system's outputs:
-- if line says 50 lintels at 0.1 hr/EA, the prior says typical is
-- 8-12 lintels averaging 1-2 hr/EA for a small commercial renovation
-- — flag the outlier.
--
-- Numbers below are seeded from common-knowledge construction
-- estimating defaults for misc fabrications. They're not gospel —
-- they're a sanity net. Calibrate to actuals once bid_actuals fills.

CREATE TABLE IF NOT EXISTS industry_priors (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category                 text NOT NULL,            -- matches takeoff_lines.category
  building_type            text,                     -- 'small_commercial_renovation' | 'industrial_factory' | 'warehouse_addition' | NULL = generic

  -- Typical quantity ranges per project of this type
  qty_min                  numeric,
  qty_typical              numeric,
  qty_max                  numeric,
  qty_unit                 text,                     -- 'EA' | 'LF' | 'LBS'

  -- Per-unit labor (the system-supplied hours per EA / LF — outliers
  -- flagged when system value is < 0.5x or > 2x typical)
  fab_hrs_per_unit_min     numeric,
  fab_hrs_per_unit_typ     numeric,
  fab_hrs_per_unit_max     numeric,

  ironworker_hrs_per_unit_min  numeric,
  ironworker_hrs_per_unit_typ  numeric,
  ironworker_hrs_per_unit_max  numeric,

  -- Per-unit weight (catches obvious unit-weight errors)
  weight_lbs_per_unit_min  numeric,
  weight_lbs_per_unit_typ  numeric,
  weight_lbs_per_unit_max  numeric,

  source                   text NOT NULL,            -- 'rsmeans-style-default' | 'tcb-actuals-...' | 'thomas-interview-...'
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT industry_priors_unique UNIQUE (category, building_type, source)
);

CREATE INDEX IF NOT EXISTS idx_industry_priors_category ON industry_priors (category);

ALTER TABLE industry_priors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read industry_priors" ON industry_priors;
CREATE POLICY "Authenticated users can read industry_priors"
  ON industry_priors FOR SELECT TO authenticated USING (true);

-- Seed: generic small-commercial-renovation priors. ON CONFLICT DO
-- NOTHING so re-runs are idempotent.
INSERT INTO industry_priors (
  category, building_type,
  qty_min, qty_typical, qty_max, qty_unit,
  fab_hrs_per_unit_min, fab_hrs_per_unit_typ, fab_hrs_per_unit_max,
  ironworker_hrs_per_unit_min, ironworker_hrs_per_unit_typ, ironworker_hrs_per_unit_max,
  weight_lbs_per_unit_min, weight_lbs_per_unit_typ, weight_lbs_per_unit_max,
  source, notes
) VALUES
  -- LINTELS: small renovation typically has 4-12 EA at L4x4x3/8 spans 4-8 LF
  ('lintel', 'small_commercial_renovation',
   4, 8, 12, 'EA',
   0.5, 1.0, 2.0,    1.0, 2.0, 3.5,    30, 50, 80,
   'rsmeans-style-default', 'L4x4x3/8 angles, 5 LF avg, galvanized'),

  -- BOLLARDS: 2-8 EA typical for protected entries
  ('bollard', 'small_commercial_renovation',
   2, 4, 8, 'EA',
   0.5, 1.0, 2.0,    1.0, 2.0, 3.5,    100, 130, 180,
   'rsmeans-style-default', '6" Sch 80 pipe, 4 LF each, concrete-filled'),

  -- PIPE SUPPORTS: 2-8 EA typical
  ('pipe_support', 'small_commercial_renovation',
   2, 4, 8, 'EA',
   1.5, 2.5, 5.0,    3.0, 4.0, 8.0,    40, 70, 120,
   'rsmeans-style-default', 'Fabricated steel stand, base plate + U-bolt'),

  -- SHELF ANGLES: 0-50 LF typical
  ('shelf_angle', 'small_commercial_renovation',
   0, 20, 50, 'LF',
   0.10, 0.15, 0.25,    0.15, 0.20, 0.35,    4, 5, 9,
   'rsmeans-style-default', 'L3x3x1/4 to L4x4x3/8 galvanized'),

  -- EMBEDS: 4-16 EA typical
  ('embed', 'small_commercial_renovation',
   4, 8, 16, 'EA',
   0.20, 0.30, 0.50,    0.40, 0.50, 0.80,    5, 7, 15,
   'rsmeans-style-default', 'PL 6x6x1/2 with welded shear studs'),

  -- HM FRAMES: 4-30 EA on a typical interior reno
  ('hollow_metal_frame', 'small_commercial_renovation',
   4, 12, 30, 'EA',
   0.5, 1.0, 1.5,    1.5, 2.0, 3.0,    70, 80, 110,
   'rsmeans-style-default', '16 GA welded HM frame, painted, 3-0x7-0 typ'),

  -- STAIRS: 1-3 flights for a small reno (rare)
  ('stair', 'small_commercial_renovation',
   0, 1, 3, 'EA',
   12, 16, 24,    24, 32, 48,    300, 400, 600,
   'rsmeans-style-default', 'Pan stair, 8-9 risers, 3-6 wide'),

  -- HANDRAILS: typically only on stairs
  ('handrail', 'small_commercial_renovation',
   0, 0, 30, 'LF',
   0.3, 0.5, 0.9,    0.5, 0.8, 1.5,    2.5, 2.7, 4,
   'rsmeans-style-default', '1-1/2" pipe wall-mounted handrail'),

  -- GUARDRAILS
  ('guardrail', 'small_commercial_renovation',
   0, 0, 50, 'LF',
   0.4, 0.6, 1.0,    0.7, 1.0, 1.8,    8, 10, 14,
   'rsmeans-style-default', '42" H steel guardrail, posts 4-0 o.c.'),

  -- STRUCTURAL BEAMS
  ('structural_beam', 'small_commercial_renovation',
   0, 1, 5, 'EA',
   2, 6, 14,    4, 10, 24,    150, 800, 2000,
   'rsmeans-style-default', 'W-shape beams, varies widely; this is per-beam totals'),

  -- BASE PLATES
  ('base_plate', 'small_commercial_renovation',
   0, 4, 12, 'EA',
   0.3, 0.5, 1.0,    0.5, 1.0, 2.0,    8, 15, 30,
   'rsmeans-style-default', '7x10x3/4 typical for column or beam bearing')
ON CONFLICT (category, building_type, source) DO NOTHING;
