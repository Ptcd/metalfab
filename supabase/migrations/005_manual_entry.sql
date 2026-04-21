-- Manual-entry support: customers table + opportunity provenance fields.
-- Does not break existing scraper inserts (all new columns are nullable /
-- have defaults).

-- ============================================================
-- customers (rolodex of GCs, referrers, repeat buyers)
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           text NOT NULL,
  company        text,
  email          text,
  phone          text,
  role           text,              -- 'GC', 'architect', 'owner', 'referral'
  notes          text,
  first_seen     date NOT NULL DEFAULT current_date,
  last_contact   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_unique_email UNIQUE (email)
);

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_customers_name ON customers USING gin (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(company,'')));
CREATE INDEX idx_customers_role ON customers (role);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read customers"
  ON customers FOR SELECT TO authenticated USING (true);

-- ============================================================
-- opportunities: provenance + estimation + customer link
-- ============================================================

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_channel text
  CHECK (source_channel IN ('scraper', 'email', 'manual', 'api', 'referral'))
  DEFAULT 'scraper';

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS added_by text;
-- 'colin' | 'gohar' | 'system' — user label, no FK until per-user accounts
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS added_via text
  CHECK (added_via IN ('scraper', 'quick-add', 'pdf-drop', 'email-forward', 'api', 'email-ingest'));

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS referrer text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

-- TCB-portion estimate typed in by the estimator (separate from scraper dollar_min/max)
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS estimated_value numeric;

-- Gut-call priority
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS confidence text
  CHECK (confidence IN ('hot', 'warm', 'cold'));

-- Backfill: everything currently in the table came from scrapers
UPDATE opportunities
   SET source_channel = 'scraper',
       added_via = 'scraper'
 WHERE source_channel IS NULL;

CREATE INDEX IF NOT EXISTS idx_opportunities_source_channel ON opportunities (source_channel);
CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_added_by ON opportunities (added_by) WHERE added_by IS NOT NULL;

-- ============================================================
-- pipeline_events: add 'doc_uploaded' event type
-- ============================================================

ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS valid_event_type;
ALTER TABLE pipeline_events
  ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
      'status_change', 'note_added', 'score_updated', 'created',
      'docs_downloaded', 'docs_purged', 'qa_analyzed', 'qa_error',
      'doc_uploaded', 'customer_linked', 'referrer_set'
    )
  );
