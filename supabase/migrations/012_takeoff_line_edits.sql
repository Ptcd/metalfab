-- Audit log for every change Thomas / Colin makes to a takeoff line in
-- the editable grid. The system's first guess goes into takeoff_lines;
-- every subsequent edit drops a row here so we can later mine the
-- system_value → human_value deltas as calibration data.
--
-- Schema is intentionally simple — full before/after JSON on each edit.
-- After 5-10 bids we can pivot this into per-category priors that fold
-- back into the takeoff prompt.

CREATE TABLE IF NOT EXISTS takeoff_line_edits (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  takeoff_line_id uuid NOT NULL REFERENCES takeoff_lines(id) ON DELETE CASCADE,
  takeoff_run_id  uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,

  -- What changed
  edit_type       text NOT NULL CHECK (edit_type IN ('field_change', 'add', 'delete')),
  field_name      text,                              -- e.g. 'quantity', 'fab_hrs', 'finish' — null for add/delete
  before_value    jsonb,                             -- prior value or full row on delete
  after_value     jsonb,                             -- new value or full row on add

  edited_by       text,                              -- user id
  edited_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_line_edits_line ON takeoff_line_edits (takeoff_line_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS idx_takeoff_line_edits_run  ON takeoff_line_edits (takeoff_run_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS idx_takeoff_line_edits_field ON takeoff_line_edits (field_name) WHERE field_name IS NOT NULL;

ALTER TABLE takeoff_line_edits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read takeoff_line_edits" ON takeoff_line_edits;
CREATE POLICY "Authenticated users can read takeoff_line_edits"
  ON takeoff_line_edits FOR SELECT TO authenticated USING (true);
