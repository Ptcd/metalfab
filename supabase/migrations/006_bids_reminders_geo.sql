-- Phase 4: bid submissions, reminders, geo scoring, outbound email threading,
-- award monitoring fields. All additive — existing data unchanged.

-- ============================================================
-- bid_submissions — one row per quote TCB sends to a GC
-- ============================================================
CREATE TABLE IF NOT EXISTS bid_submissions (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id     uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  customer_id        uuid REFERENCES customers(id) ON DELETE SET NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  submitted_by       text,                       -- 'colin' | 'gohar' | 'other'
  amount_usd         numeric,
  proposal_storage_path text,                    -- bid-docs/<opp>/proposal-xyz.pdf
  proposal_filename  text,
  notes              text,
  method             text,                       -- 'email' | 'portal' | 'phone' | 'other'
  gc_contact_email   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bid_submissions_opp ON bid_submissions (opportunity_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bid_submissions_customer ON bid_submissions (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE bid_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read bid_submissions" ON bid_submissions;
CREATE POLICY "Authenticated users can read bid_submissions"
  ON bid_submissions FOR SELECT TO authenticated USING (true);

-- ============================================================
-- reminders — anything that needs to nag the VA on /today
-- ============================================================
CREATE TABLE IF NOT EXISTS reminders (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id    uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  customer_id       uuid REFERENCES customers(id) ON DELETE CASCADE,
  reminder_type     text NOT NULL,
  -- Types: 'deadline_approaching' | 'bid_followup_3d' | 'bid_followup_10d' |
  --        'pre_bid_meeting' | 'rebid_check_award' | 'custom'
  due_at            timestamptz NOT NULL,
  subject           text NOT NULL,               -- one-liner shown on /today
  body              text,                        -- optional longer context
  completed_at      timestamptz,
  snoozed_until     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_reminder_type CHECK (
    reminder_type IN (
      'deadline_approaching', 'bid_followup_3d', 'bid_followup_10d',
      'pre_bid_meeting', 'rebid_check_award', 'custom'
    )
  ),
  CONSTRAINT has_target CHECK (
    opportunity_id IS NOT NULL OR customer_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at)
  WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_opp ON reminders (opportunity_id);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read reminders" ON reminders;
CREATE POLICY "Authenticated users can read reminders"
  ON reminders FOR SELECT TO authenticated USING (true);

-- ============================================================
-- email_threads — outbound CRM sends + reply-matching keys
-- ============================================================
CREATE TABLE IF NOT EXISTS email_threads (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id       uuid REFERENCES customers(id) ON DELETE CASCADE,
  opportunity_id    uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  direction         text NOT NULL,               -- 'outbound' | 'inbound'
  message_id        text,                        -- RFC 5322 Message-ID
  in_reply_to       text,                        -- RFC 5322 In-Reply-To
  subject           text,
  from_address      text,
  to_addresses      text[],                      -- multiple recipients possible
  body_text         text,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  template_key      text,                        -- 'intro' | 'followup_7d' | 'rebid' | 'custom'
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_direction CHECK (direction IN ('outbound', 'inbound'))
);

CREATE INDEX IF NOT EXISTS idx_email_threads_customer ON email_threads (customer_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_msgid ON email_threads (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_replyto ON email_threads (in_reply_to) WHERE in_reply_to IS NOT NULL;

ALTER TABLE email_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read email_threads" ON email_threads;
CREATE POLICY "Authenticated users can read email_threads"
  ON email_threads FOR SELECT TO authenticated USING (true);

-- ============================================================
-- Geo scoring — bonus for target states, penalty for far-out
-- ============================================================
ALTER TABLE scoring_config
  ADD COLUMN IF NOT EXISTS target_states text[] NOT NULL DEFAULT ARRAY['WI','IL','IA','MN','IN'];
ALTER TABLE scoring_config
  ADD COLUMN IF NOT EXISTS target_state_bonus int NOT NULL DEFAULT 15;
ALTER TABLE scoring_config
  ADD COLUMN IF NOT EXISTS out_of_region_penalty int NOT NULL DEFAULT 20;

-- ============================================================
-- Award monitoring fields on opportunity
-- ============================================================
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS award_checked_at timestamptz;
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS award_winner_name text;
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS award_amount_usd numeric;
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS award_posted_at timestamptz;

-- ============================================================
-- pipeline_events: new event types
-- ============================================================
ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS valid_event_type;
ALTER TABLE pipeline_events
  ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
      'status_change', 'note_added', 'score_updated', 'created',
      'docs_downloaded', 'docs_purged', 'qa_analyzed', 'qa_error',
      'doc_uploaded', 'customer_linked', 'referrer_set',
      'bid_submitted', 'email_sent', 'email_received',
      'award_detected', 'rebid_target_identified', 'reminder_created',
      'reminder_completed'
    )
  );
