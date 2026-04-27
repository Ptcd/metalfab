-- Plan Intelligence: per-opportunity deterministic preprocessing of bid PDFs.
-- Runs *before* any Claude vision call. Output is the structured digest the
-- takeoff engine consumes. One row per opportunity; latest run wins.

CREATE TABLE IF NOT EXISTS plan_intelligence (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id       uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,

  -- Full digest. Schema is documented in lib/plan-intelligence/index.js.
  digest               jsonb NOT NULL,

  -- Hot fields lifted from digest.summary for indexing / dashboard queries.
  summary              jsonb NOT NULL,
  ready_for_takeoff    boolean NOT NULL DEFAULT false,

  generated_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_intelligence_unique_opp UNIQUE (opportunity_id)
);

CREATE TRIGGER plan_intelligence_updated_at
  BEFORE UPDATE ON plan_intelligence
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_plan_intelligence_ready
  ON plan_intelligence (ready_for_takeoff);

CREATE INDEX IF NOT EXISTS idx_plan_intelligence_summary
  ON plan_intelligence USING gin (summary);

ALTER TABLE plan_intelligence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read plan_intelligence" ON plan_intelligence;
CREATE POLICY "Authenticated users can read plan_intelligence"
  ON plan_intelligence FOR SELECT TO authenticated USING (true);
