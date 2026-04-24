#!/usr/bin/env node
/**
 * seed-reminders.js — nightly sweep that creates reminders from opportunity
 * and QA-report data. Idempotent: won't create a duplicate reminder for the
 * same (opportunity_id, reminder_type) that's still open.
 *
 * Seeds:
 *   - deadline_approaching: opps in bidding/qa_qualified/reviewing with
 *     response_deadline 3 and 7 days out
 *   - pre_bid_meeting: opps with a qa_report.pre_bid_meeting date that
 *     hasn't passed, reminder due 24h before the meeting
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

async function existsReminder(oppId, type) {
  const url = `${SUPABASE_URL}/rest/v1/reminders?opportunity_id=eq.${oppId}&reminder_type=eq.${type}&completed_at=is.null&select=id&limit=1`;
  const res = await fetch(url, { headers: headers() });
  const arr = await res.json();
  return Array.isArray(arr) && arr.length > 0;
}

async function insertReminder(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/reminders`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`insert reminder: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function seedDeadlineReminders(run) {
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 86400000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/opportunities?status=in.(bidding,qa_qualified,reviewing)&response_deadline=gte.${now.toISOString()}&response_deadline=lte.${sevenDays}&select=id,title,response_deadline`;
  const res = await fetch(url, { headers: headers() });
  const opps = await res.json();
  if (!Array.isArray(opps)) return 0;
  let made = 0;
  for (const opp of opps) {
    if (await existsReminder(opp.id, 'deadline_approaching')) continue;
    // Due 24h before deadline (or now, whichever is later)
    const dueAt = new Date(new Date(opp.response_deadline).getTime() - 86400000);
    const finalDue = dueAt < now ? now : dueAt;
    try {
      await insertReminder({
        opportunity_id: opp.id,
        reminder_type: 'deadline_approaching',
        due_at: finalDue.toISOString(),
        subject: `Deadline tomorrow: ${opp.title.slice(0, 80)}`,
        body: `Bid deadline is ${new Date(opp.response_deadline).toLocaleString()}. Last chance to confirm TCB's bid is in.`,
      });
      made++;
    } catch (e) { await addError(run, 'deadline', `${opp.id}: ${e.message}`); }
  }
  return made;
}

async function seedPreBidReminders(run) {
  // Pull opps whose qa_report has a pre_bid_meeting in the future
  const url = `${SUPABASE_URL}/rest/v1/opportunities?qa_report=not.is.null&status=in.(qa_qualified,bidding,reviewing,awaiting_qa)&select=id,title,qa_report`;
  const res = await fetch(url, { headers: headers() });
  const opps = await res.json();
  if (!Array.isArray(opps)) return 0;
  const now = new Date();
  let made = 0;
  for (const opp of opps) {
    const meetIso = opp.qa_report?.pre_bid_meeting;
    if (!meetIso) continue;
    const meet = new Date(meetIso);
    if (isNaN(meet.getTime()) || meet < now) continue;
    if (await existsReminder(opp.id, 'pre_bid_meeting')) continue;
    const dueAt = new Date(meet.getTime() - 86400000);
    const finalDue = dueAt < now ? now : dueAt;
    try {
      await insertReminder({
        opportunity_id: opp.id,
        reminder_type: 'pre_bid_meeting',
        due_at: finalDue.toISOString(),
        subject: `Pre-bid meeting tomorrow: ${opp.title.slice(0, 80)}`,
        body: `Pre-bid meeting is ${meet.toLocaleString()}. If TCB plans to attend, confirm now.`,
      });
      made++;
    } catch (e) { await addError(run, 'pre_bid', `${opp.id}: ${e.message}`); }
  }
  return made;
}

async function run() {
  const runRow = await startRun('manual', 'seed-reminders');
  let deadlineMade = 0, preBidMade = 0;
  try {
    deadlineMade = await seedDeadlineReminders(runRow);
    preBidMade = await seedPreBidReminders(runRow);
    await addStep(runRow, 'seeded', { deadline: deadlineMade, pre_bid: preBidMade });
    await finishRun(runRow, { status: 'success', opportunities_processed: deadlineMade + preBidMade });
    console.log(`Seeded reminders: ${deadlineMade} deadline, ${preBidMade} pre-bid`);
    return { ok: true, deadline: deadlineMade, pre_bid: preBidMade };
  } catch (e) {
    await addError(runRow, 'fatal', e.message);
    await finishRun(runRow, { status: 'failed' });
    throw e;
  }
}

module.exports = { runSeedReminders: run };
if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
