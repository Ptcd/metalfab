-- Extend pipeline_events.event_type allowed values to cover the
-- takeoff / approval / proposal lifecycle. Several existing routes
-- (approve, reopen, proposal/generate, audit-commit) write event
-- types not covered by migration 006's constraint — those inserts
-- have been silently failing the CHECK validation.

ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS valid_event_type;
ALTER TABLE pipeline_events
  ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
      -- Original
      'status_change', 'note_added', 'score_updated', 'created',
      -- 004 QA layer
      'docs_downloaded', 'docs_purged', 'qa_analyzed', 'qa_error',
      -- 005 manual entry
      'doc_uploaded', 'customer_linked', 'referrer_set',
      -- 006 bids / reminders / geo
      'bid_submitted', 'email_sent', 'email_received',
      'award_detected', 'rebid_target_identified',
      'reminder_created', 'reminder_completed',
      -- New: takeoff / approval / proposal lifecycle
      'takeoff_approved', 'takeoff_reopened', 'takeoff_force_approved',
      'proposal_generated', 'proposal_sent',
      'audit_completed', 'arbitration_completed', 'rfi_drafted'
    )
  );
