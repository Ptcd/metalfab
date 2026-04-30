-- Bid-vs-actual capture. One row per takeoff_line on a won/completed
-- job, populated by Thomas after the job is fabricated. Closes the
-- calibration loop: predicted (in takeoff_lines) vs actual (here)
-- becomes the data we mine to auto-tune the rate card and assembly
-- priors.

CREATE TABLE IF NOT EXISTS bid_actuals (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  takeoff_run_id           uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  takeoff_line_id          uuid NOT NULL REFERENCES takeoff_lines(id) ON DELETE CASCADE,
  opportunity_id           uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,

  -- Snapshot of the prediction at log time (so the line can change
  -- post-actual and we still have what was predicted). Sourced from
  -- the takeoff_line at insert.
  predicted_quantity       numeric,
  predicted_quantity_unit  text,
  predicted_total_weight_lbs numeric,
  predicted_fab_hrs        numeric,
  predicted_det_hrs        numeric,
  predicted_foreman_hrs    numeric,
  predicted_ironworker_hrs numeric,
  predicted_line_total_usd numeric,

  -- What actually happened
  actual_quantity          numeric,
  actual_total_weight_lbs  numeric,
  actual_fab_hrs           numeric,
  actual_det_hrs           numeric,
  actual_foreman_hrs       numeric,
  actual_ironworker_hrs    numeric,
  actual_material_cost_usd numeric,
  actual_labor_cost_usd    numeric,
  actual_finish_cost_usd   numeric,
  actual_total_cost_usd    numeric,

  -- Variance signals (computed via generated columns? Use plain
  -- columns for portability — the API populates them on insert/update.)
  weight_delta_pct         numeric,                   -- (actual - predicted) / predicted
  ironworker_delta_pct     numeric,
  total_delta_pct          numeric,

  notes                    text,
  recorded_by              text,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bid_actuals_unique_line UNIQUE (takeoff_line_id)
);

CREATE INDEX IF NOT EXISTS idx_bid_actuals_run        ON bid_actuals (takeoff_run_id);
CREATE INDEX IF NOT EXISTS idx_bid_actuals_opp        ON bid_actuals (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_bid_actuals_recorded   ON bid_actuals (recorded_at DESC);

CREATE TRIGGER bid_actuals_updated_at
  BEFORE UPDATE ON bid_actuals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE bid_actuals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read bid_actuals" ON bid_actuals;
CREATE POLICY "Authenticated users can read bid_actuals"
  ON bid_actuals FOR SELECT TO authenticated USING (true);

-- Aggregation view: per-category predicted vs actual averages, used
-- by future calibration code to nudge the rate card and assembly
-- priors based on real outcomes.
CREATE OR REPLACE VIEW bid_actuals_by_category AS
SELECT
  tl.category,
  COUNT(*) AS sample_count,
  AVG(ba.weight_delta_pct) AS avg_weight_delta_pct,
  AVG(ba.ironworker_delta_pct) AS avg_iw_delta_pct,
  AVG(ba.total_delta_pct) AS avg_total_delta_pct,
  AVG(ba.actual_fab_hrs / NULLIF(ba.predicted_fab_hrs, 0)) AS avg_fab_ratio,
  AVG(ba.actual_ironworker_hrs / NULLIF(ba.predicted_ironworker_hrs, 0)) AS avg_iw_ratio,
  AVG(ba.actual_total_weight_lbs / NULLIF(ba.predicted_total_weight_lbs, 0)) AS avg_weight_ratio
FROM bid_actuals ba
JOIN takeoff_lines tl ON tl.id = ba.takeoff_line_id
WHERE ba.actual_total_weight_lbs IS NOT NULL OR ba.actual_ironworker_hrs IS NOT NULL
GROUP BY tl.category;
