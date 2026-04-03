-- Add business column to distinguish TCB Metalworks vs On Kaul Auto Salvage bids
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS business text DEFAULT 'metalfab';

-- Tag existing BidNet bids as metalfab (they were all scraped for metal fab)
UPDATE opportunities SET business = 'metalfab' WHERE business IS NULL;

-- Index for quick filtering by business
CREATE INDEX IF NOT EXISTS idx_opportunities_business ON opportunities(business);
