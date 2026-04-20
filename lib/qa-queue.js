/**
 * lib/qa-queue.js — helpers for moving opportunities into the QA queue.
 *
 * Call `promoteToAwaitingQa(opportunityId)` after docs are downloaded. It
 * only promotes if qa_analysis_enabled is true, the opp has documents,
 * and score >= qa_min_score_threshold.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

let _cachedConfig = null;
async function getQaConfig() {
  if (_cachedConfig) return _cachedConfig;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/scoring_config?select=qa_analysis_enabled,qa_min_score_threshold&limit=1`,
    { headers: headers() }
  );
  const arr = await res.json();
  _cachedConfig = Array.isArray(arr) && arr[0]
    ? arr[0]
    : { qa_analysis_enabled: true, qa_min_score_threshold: 20 };
  return _cachedConfig;
}

async function promoteToAwaitingQa(opportunityId) {
  const cfg = await getQaConfig();
  if (!cfg.qa_analysis_enabled) return { promoted: false, reason: 'qa_disabled' };

  const oppRes = await fetch(
    `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opportunityId}&select=score,status,documents`,
    { headers: headers() }
  );
  const [opp] = await oppRes.json();
  if (!opp) return { promoted: false, reason: 'not_found' };
  if ((opp.documents || []).length === 0) return { promoted: false, reason: 'no_documents' };
  if ((opp.score || 0) < cfg.qa_min_score_threshold) {
    return { promoted: false, reason: 'below_threshold' };
  }
  if (!['new', 'reviewing'].includes(opp.status)) {
    return { promoted: false, reason: `status_${opp.status}` };
  }

  const priorStatus = opp.status;
  const patch = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opportunityId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'awaiting_qa' }),
  });
  if (!patch.ok) {
    const text = await patch.text();
    return { promoted: false, reason: `patch_failed:${patch.status}`, error: text.slice(0, 200) };
  }

  // event log
  await fetch(`${SUPABASE_URL}/rest/v1/pipeline_events`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      opportunity_id: opportunityId,
      event_type: 'status_change',
      old_value: priorStatus,
      new_value: 'awaiting_qa',
    }),
  }).catch(() => {});

  return { promoted: true };
}

module.exports = { promoteToAwaitingQa, getQaConfig };
