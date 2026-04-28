-- Takeoff Audit: input-orthogonal adversarial pass over a takeoff_run.
--
-- The audit's job is to catch what the takeoff missed. It runs against
-- the same source materials but with a different framing: "what scope
-- would an angry GC claim was included but TCB excluded?" It produces
-- (a) an independent expected-items list, (b) a per-finding list of
-- issues, and (c) a verdict that gates submission.
--
-- Two-source independence: the audit sees the takeoff's *conclusions*
-- (line categories + descriptions + quantities) but not the takeoff's
-- *reasoning* (assumptions, source_evidence). This keeps the audit
-- from rubber-stamping the takeoff's logic.

CREATE TABLE IF NOT EXISTS takeoff_audits (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  takeoff_run_id         uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,

  generated_by           text NOT NULL,             -- 'oauth-claude-code' | 'manual'
  generator_version      text,
  generated_at           timestamptz NOT NULL DEFAULT now(),

  -- Independent scope list the audit produced
  expected_items         jsonb,                     -- [{ category, description, source_section, source_page, source_evidence }]

  -- Findings — every issue the audit raised
  findings               jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Diff against the takeoff
  missing_items          jsonb,                     -- in audit, not in takeoff
  unexpected_items       jsonb,                     -- in takeoff, not in audit

  -- Severity tally
  errors_count           int NOT NULL DEFAULT 0,
  warnings_count         int NOT NULL DEFAULT 0,
  info_count             int NOT NULL DEFAULT 0,

  -- Overall gate
  verdict                text NOT NULL DEFAULT 'review_recommended'
    CHECK (verdict IN ('passed', 'review_recommended', 'block_submission')),

  raw_output             jsonb,                     -- full audit JSON for diffing later runs

  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT takeoff_audits_unique_run UNIQUE (takeoff_run_id)
);

CREATE INDEX IF NOT EXISTS idx_takeoff_audits_verdict ON takeoff_audits (verdict);

ALTER TABLE takeoff_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read takeoff_audits" ON takeoff_audits;
CREATE POLICY "Authenticated users can read takeoff_audits"
  ON takeoff_audits FOR SELECT TO authenticated USING (true);
