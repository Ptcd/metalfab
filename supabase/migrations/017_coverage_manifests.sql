-- Coverage Manifest: per-opportunity completeness invariant.
--
-- The manifest enumerates every spec section + plan sheet + schedule
-- in the bid package and tags each as included / excluded / n/a /
-- needs_human_judgment per the TCB scope policy
-- (lib/coverage/tcb-scope-policy.js). The takeoff agent reconciles
-- against this artifact; the `manifest_coverage` validator hard-fails
-- the commit if any `included` entry is unaccounted for.
--
-- Built deterministically from the plan_intelligence digest by
-- scripts/coverage.js. One row per opportunity; latest run wins.

CREATE TABLE IF NOT EXISTS coverage_manifests (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id       uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,

  -- Full manifest. Schema is documented in lib/coverage/build-manifest.js.
  manifest             jsonb NOT NULL,

  -- Hot fields lifted from manifest for indexing / dashboard queries.
  summary              jsonb NOT NULL,
  unresolved_count     int  NOT NULL DEFAULT 0,
  needs_vision_count   int  NOT NULL DEFAULT 0,

  generated_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coverage_manifests_unique_opp UNIQUE (opportunity_id)
);

CREATE TRIGGER coverage_manifests_updated_at
  BEFORE UPDATE ON coverage_manifests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_coverage_manifests_unresolved
  ON coverage_manifests (unresolved_count);

CREATE INDEX IF NOT EXISTS idx_coverage_manifests_summary
  ON coverage_manifests USING gin (summary);

ALTER TABLE coverage_manifests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read coverage_manifests" ON coverage_manifests;
CREATE POLICY "Authenticated users can read coverage_manifests"
  ON coverage_manifests FOR SELECT TO authenticated USING (true);
