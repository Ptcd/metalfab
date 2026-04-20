-- QA Layer + Storage Management
-- Adds document download, Claude Code QA workflow, system_runs observability,
-- and new config fields. Retains all existing columns and policies.

-- ============================================================
-- opportunities: documents + qa_report + new statuses
-- ============================================================

-- Drop old CHECK so we can extend the status enum
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS valid_status;

ALTER TABLE opportunities
  ADD CONSTRAINT valid_status CHECK (
    status IN (
      'new', 'reviewing', 'bidding', 'won', 'lost', 'passed',
      'awaiting_qa', 'qa_qualified', 'qa_rejected'
    )
  );

-- documents: jsonb array of {filename, storage_path, downloaded_at, file_size, mime_type, category}
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]'::jsonb;

-- qa_report lives in raw_data.qa_report but we add a direct column for querying + indexing
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS qa_report jsonb;

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS docs_purged_at timestamptz;

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS qa_needs_human_review boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_opportunities_awaiting_qa
  ON opportunities (status)
  WHERE status = 'awaiting_qa';

CREATE INDEX IF NOT EXISTS idx_opportunities_qa_qualified
  ON opportunities (updated_at DESC)
  WHERE status = 'qa_qualified';

-- ============================================================
-- pipeline_events: extend event_type enum
-- ============================================================

ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS valid_event_type;

ALTER TABLE pipeline_events
  ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
      'status_change', 'note_added', 'score_updated', 'created',
      'docs_downloaded', 'docs_purged', 'qa_analyzed', 'qa_error'
    )
  );

-- ============================================================
-- scoring_config: new QA + digest fields
-- ============================================================

ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS qa_analysis_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS qa_min_score_threshold int NOT NULL DEFAULT 20;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS estimator_email text;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS owner_email text;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS doc_retention_won_days int NOT NULL DEFAULT 90;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS doc_retention_lost_days int NOT NULL DEFAULT 14;

-- ============================================================
-- system_runs: observability for cron + Claude Code runs
-- ============================================================

CREATE TABLE IF NOT EXISTS system_runs (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_type               text NOT NULL,            -- 'scrape', 'digest', 'cleanup', 'qa_prepare', 'qa_commit'
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  status                 text NOT NULL DEFAULT 'running', -- 'running', 'success', 'partial', 'failed'
  steps_completed        jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors_encountered     jsonb NOT NULL DEFAULT '[]'::jsonb,
  opportunities_processed int NOT NULL DEFAULT 0,
  docs_downloaded        int NOT NULL DEFAULT 0,
  docs_purged            int NOT NULL DEFAULT 0,
  notes                  text,
  CONSTRAINT valid_run_type CHECK (
    run_type IN ('scrape', 'digest', 'cleanup', 'qa_prepare', 'qa_commit', 'manual')
  ),
  CONSTRAINT valid_run_status CHECK (
    status IN ('running', 'success', 'partial', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_system_runs_started ON system_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_runs_type ON system_runs (run_type, started_at DESC);

ALTER TABLE system_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read system_runs"
  ON system_runs FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- Storage bucket: bid-docs
-- ============================================================
-- Creates the bucket; policies defined below. This is idempotent.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bid-docs',
  'bid-docs',
  false,
  104857600, -- 100 MB per file
  ARRAY[
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'application/octet-stream',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies on storage.objects for this bucket.
-- Service role (scrapers, cron) bypasses RLS automatically.
-- Authenticated users can read; only service role writes.

DROP POLICY IF EXISTS "authenticated read bid-docs" ON storage.objects;
CREATE POLICY "authenticated read bid-docs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'bid-docs');
