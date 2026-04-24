#!/usr/bin/env node
/**
 * check-awards.js — scan SAM.gov opportunity detail pages for award
 * notices on opps in `bidding`, `qa_qualified`, or `reviewing` status.
 *
 * Flow:
 *   1. Pull opps with source=samgov* and status in the watched set
 *      whose response_deadline has passed (or is within 3 days).
 *   2. Hit SAM.gov's public opp detail JSON to check for an "Award Notice"
 *      amendment or the "awardData" block.
 *   3. If an award is posted:
 *      - record winner, amount, posted date on the opp
 *      - create a rebid_check_award reminder (or complete it if already there)
 *      - write a pipeline_event
 *   4. Log the whole run into system_runs.
 *
 * Non-SAM sources (BidNet, DemandStar, plan rooms) aren't checked — each
 * has a custom award flow. Add per-portal checkers as needed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function loadWatched() {
  // Opps to check: bid-relevant statuses, SAM.gov source, either past
  // deadline or within 3 days, not already award-checked in the last 24h
  const threeDaysFromNow = new Date(Date.now() + 3 * 86400000).toISOString();
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/opportunities` +
    `?source=in.(samgov,samgov-sgs,usaspending)` +
    `&status=in.(bidding,qa_qualified,reviewing)` +
    `&response_deadline=lte.${threeDaysFromNow}` +
    `&or=(award_checked_at.is.null,award_checked_at.lt.${dayAgo})` +
    `&select=id,title,source_url,status,response_deadline,award_checked_at,customer_id` +
    `&limit=40`;
  const res = await fetch(url, { headers: headers() });
  const arr = await res.json();
  return Array.isArray(arr) ? arr : [];
}

function extractSamUuid(url) {
  if (!url) return null;
  const m = url.match(/sam\.gov\/(?:opp|workspace\/contract\/opp)\/([0-9a-f]{32})/i);
  return m ? m[1] : null;
}

async function checkSamAward(uuid) {
  const url = `https://sam.gov/api/prod/opps/v2/opportunities/${uuid}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return { error: `opp detail ${res.status}` };
  const body = await res.json();
  const data = body?.data || body?.data2 || body;

  // Award notice detection
  // SAM.gov uses notice type "Award Notice" with awardeeName / awardAmount fields
  const award = data?.awardee || data?.award || data?.awardData;
  const noticeType = (data?.type?.value || data?.type || '').toLowerCase();
  const hasAward =
    (award && (award.name || award.awardee || award.awardeeName)) ||
    noticeType.includes('award');

  if (!hasAward) return { posted: false };

  const winnerName =
    award?.name || award?.awardee || award?.awardeeName ||
    award?.company || null;
  const amount =
    Number(award?.amount) || Number(award?.value) || Number(award?.awardAmount) || null;
  const postedDate = award?.date || data?.postedDate || data?.modifiedDate || null;

  return {
    posted: true,
    winner_name: winnerName,
    amount_usd: Number.isFinite(amount) ? amount : null,
    posted_at: postedDate ? new Date(postedDate).toISOString() : new Date().toISOString(),
  };
}

async function markChecked(oppId, awardData) {
  const patch = {
    award_checked_at: new Date().toISOString(),
  };
  if (awardData.posted) {
    patch.award_winner_name = awardData.winner_name;
    patch.award_amount_usd = awardData.amount_usd;
    patch.award_posted_at = awardData.posted_at;
  }
  await fetch(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function writeEvent(oppId, eventType, newValue) {
  await fetch(`${SUPABASE_URL}/rest/v1/pipeline_events`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ opportunity_id: oppId, event_type: eventType, new_value: newValue }),
  });
}

async function createRebidReminder(opp, winnerName) {
  // If we already have an open rebid_check_award reminder for this opp, reuse it.
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/reminders?opportunity_id=eq.${opp.id}&reminder_type=eq.rebid_check_award&completed_at=is.null&select=id&limit=1`,
    { headers: headers() }
  ).then((r) => r.json());
  if (Array.isArray(existing) && existing[0]) return;

  const dueAt = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/reminders`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      opportunity_id: opp.id,
      reminder_type: 'rebid_check_award',
      due_at: dueAt,
      subject: `Award posted: ${opp.title.slice(0, 70)}`,
      body: `Winning GC: ${winnerName || 'unknown'}. If TCB's GC didn't win, send a re-bid email to the winner.`,
    }),
  });
}

async function run() {
  const runRow = await startRun('manual', 'check-awards');
  const opps = await loadWatched();
  console.log(`Watching ${opps.length} opps for awards`);
  let checked = 0, awarded = 0, errors = 0;

  for (const opp of opps) {
    const uuid = extractSamUuid(opp.source_url);
    if (!uuid) continue;
    checked++;
    try {
      const award = await checkSamAward(uuid);
      if (award.error) {
        errors++;
        await addError(runRow, 'sam_detail', `${opp.id}: ${award.error}`);
        continue;
      }
      await markChecked(opp.id, award);
      if (award.posted) {
        awarded++;
        console.log(`  ${opp.id.slice(0, 8)} AWARDED → ${award.winner_name || '(unknown)'} ${award.amount_usd ? `$${award.amount_usd.toLocaleString()}` : ''}`);
        await writeEvent(opp.id, 'award_detected', `${award.winner_name || 'unknown'}${award.amount_usd ? ` · $${award.amount_usd.toLocaleString()}` : ''}`);
        await createRebidReminder(opp, award.winner_name);
      }
    } catch (e) {
      errors++;
      await addError(runRow, 'check', `${opp.id}: ${e.message}`);
    }
  }

  await addStep(runRow, 'check-awards-done', { checked, awarded, errors });
  await finishRun(runRow, {
    status: errors === 0 ? 'success' : 'partial',
    opportunities_processed: checked,
    notes: `Checked ${checked} SAM opps, ${awarded} had awards posted`,
  });
  console.log(`Done: ${checked} checked, ${awarded} awarded, ${errors} errors`);
  return { ok: true, checked, awarded, errors };
}

module.exports = { runCheckAwards: run };
if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
