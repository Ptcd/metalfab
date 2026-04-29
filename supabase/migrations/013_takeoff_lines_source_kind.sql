-- Expand takeoff_lines.source_kind to include 'audit' (lines added from
-- the audit's missing-items diff) and 'manual' (lines hand-added by
-- Thomas in the editable grid). Older values stay valid.

ALTER TABLE takeoff_lines DROP CONSTRAINT IF EXISTS takeoff_lines_source_kind_check;
ALTER TABLE takeoff_lines ADD CONSTRAINT takeoff_lines_source_kind_check
  CHECK (source_kind IN ('spec','qa','drawing','assumption','industry_default','audit','manual'));

-- Audit log was losing 'delete' rows because the takeoff_line_id FK
-- was ON DELETE CASCADE — deleting a line cascaded out the very
-- audit row that recorded the delete. Drop and re-add with SET NULL
-- so the audit history survives the line.
ALTER TABLE takeoff_line_edits ALTER COLUMN takeoff_line_id DROP NOT NULL;
ALTER TABLE takeoff_line_edits DROP CONSTRAINT IF EXISTS takeoff_line_edits_takeoff_line_id_fkey;
ALTER TABLE takeoff_line_edits ADD CONSTRAINT takeoff_line_edits_takeoff_line_id_fkey
  FOREIGN KEY (takeoff_line_id) REFERENCES takeoff_lines(id) ON DELETE SET NULL;
