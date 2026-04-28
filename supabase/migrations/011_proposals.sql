-- Proposals: one row per generated proposal PDF for an opportunity.
-- Auto-incremented per-fiscal-year proposal number, snapshot of the
-- takeoff_run pricing at the time of generation, link to the PDF in
-- Supabase Storage.

CREATE TABLE IF NOT EXISTS proposals (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id           uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  takeoff_run_id           uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE RESTRICT,

  -- Auto-incremented per-year proposal number, e.g. 'TCB-2026-0007'
  proposal_number          text NOT NULL,

  -- Pricing snapshot at generation time
  scenario                 text NOT NULL CHECK (scenario IN ('conservative','expected','aggressive')),
  bid_total_usd            numeric NOT NULL,

  -- Storage
  storage_path             text NOT NULL,            -- 'proposals/<opp_id>/TCB-2026-0007.pdf'
  filename                 text NOT NULL,
  file_size                int,

  -- Lifecycle
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','superseded')),
  sent_at                  timestamptz,
  sent_to                  text,                     -- email address (mirror of bid_submissions.gc_contact_email)

  generator_version        text NOT NULL,            -- 'proposal-pdf-v1'
  generated_at             timestamptz NOT NULL DEFAULT now(),
  generated_by             text,                     -- user_id or 'system'
  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_opp     ON proposals (opportunity_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_status  ON proposals (status);
CREATE INDEX IF NOT EXISTS idx_proposals_number  ON proposals (proposal_number);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read proposals" ON proposals;
CREATE POLICY "Authenticated users can read proposals"
  ON proposals FOR SELECT TO authenticated USING (true);

-- Per-year sequence used for proposal_number generation. The API route
-- bumps and reads this in a single RPC; using a sequence per year via
-- a small helper function avoids race conditions if two proposals are
-- generated simultaneously.
CREATE TABLE IF NOT EXISTS proposal_number_sequence (
  fiscal_year     int PRIMARY KEY,
  next_number     int NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION next_proposal_number(year_in int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  result int;
BEGIN
  INSERT INTO proposal_number_sequence (fiscal_year, next_number)
  VALUES (year_in, 1)
  ON CONFLICT (fiscal_year) DO UPDATE
    SET next_number = proposal_number_sequence.next_number + 1
  RETURNING next_number INTO result;
  RETURN result;
END;
$$;
