-- 017_takeoff_run_status.sql
--
-- Adds supersession tracking to takeoff_runs. Before this:
--   * Each commit appended a new takeoff_run row.
--   * Nothing knew which run was current vs stale.
--   * The opp UI had to guess (usually picked latest by created_at).
--
-- After this:
--   * status: 'current' | 'superseded' | 'archived' | 'rejected'
--   * superseded_by: fk to the run that replaced this one
--   * Commit script marks the prior run as superseded and links it
--     to the new run atomically.
--   * Frontend filters where status = 'current'.

ALTER TABLE takeoff_runs
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'superseded', 'archived', 'rejected')),
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES takeoff_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  -- Run-level confidence is now reported as both weighted (by line dollar
  -- contribution) and unweighted (uniform mean). The existing
  -- `confidence_avg` column holds the weighted version going forward.
  ADD COLUMN IF NOT EXISTS confidence_unweighted_avg numeric;

-- Helpful index for the common "give me the current run for opp X" query
CREATE INDEX IF NOT EXISTS takeoff_runs_current_idx
  ON takeoff_runs(opportunity_id)
  WHERE status = 'current';

-- One-time backfill: for every opp with multiple runs, keep the latest as
-- 'current' and mark older ones 'superseded' linked to the next-newer run.
-- Wrapped in DO so re-running this migration is idempotent.
DO $$
DECLARE
  rec RECORD;
  prev_id uuid;
  prev_opp uuid;
BEGIN
  prev_opp := NULL;
  prev_id  := NULL;
  FOR rec IN
    SELECT id, opportunity_id, created_at
    FROM takeoff_runs
    ORDER BY opportunity_id, created_at DESC
  LOOP
    IF rec.opportunity_id IS DISTINCT FROM prev_opp THEN
      -- newest run for this opp; keep it 'current'
      prev_opp := rec.opportunity_id;
      prev_id  := rec.id;
    ELSE
      -- older run; mark as superseded by the previously seen run
      UPDATE takeoff_runs
        SET status = 'superseded',
            superseded_by = prev_id,
            superseded_at = COALESCE(superseded_at, now())
        WHERE id = rec.id
          AND status = 'current';
      prev_id := rec.id; -- so the next-older run is superseded by *its* successor
    END IF;
  END LOOP;
END $$;
