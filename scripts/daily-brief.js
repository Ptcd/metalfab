#!/usr/bin/env node
/**
 * daily-brief.js - Daily summary report for TCB Metalworks bid pipeline
 * Generates a scannable terminal report of pipeline status
 *
 * Run: node scripts/daily-brief.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env.local');
  process.exit(1);
}

const BASE = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function query(endpoint) {
  const url = `${BASE}/${endpoint}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

function fmtDate(d) {
  if (!d) return 'no deadline';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function hoursUntil(d) {
  if (!d) return Infinity;
  return (new Date(d) - new Date()) / (1000 * 60 * 60);
}

function daysUntil(d) {
  if (!d) return Infinity;
  return (new Date(d) - new Date()) / (1000 * 60 * 60 * 24);
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

function printOpp(opp, idx) {
  const dl = fmtDate(opp.response_deadline);
  const days = daysUntil(opp.response_deadline);
  const urgency = days <= 3 ? ' ** URGENT **' : days <= 7 ? ' (soon)' : '';
  const score = opp.score != null ? `[${opp.score}]` : '';
  console.log(`  ${idx}. ${score} ${truncate(opp.title, 65)}`);
  console.log(`     ${opp.source || '?'} | ${opp.agency || 'unknown agency'} | Due: ${dl}${urgency}`);
}

function printSection(title, items, emptyMsg) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
  if (!items || items.length === 0) {
    console.log(`  ${emptyMsg || 'None.'}`);
    return;
  }
  items.forEach((o, i) => printOpp(o, i + 1));
}

async function run() {
  const now = new Date();
  const h24ago = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const h72from = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
  const d7from = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Run all queries in parallel
  const [
    newToday,
    urgent,
    upcoming,
    metalfabReviewing,
    salvageReviewing,
    allOpps,
  ] = await Promise.all([
    // New opportunities added in last 24h
    query(`opportunities?select=*&status=eq.new&created_at=gte.${h24ago}&order=score.desc`),

    // Deadlines within 72 hours (not passed/lost/won)
    query(`opportunities?select=*&status=not.in.(passed,lost,won)&response_deadline=gte.${now.toISOString()}&response_deadline=lte.${h72from}&order=response_deadline.asc`),

    // Deadlines within 7 days (not passed/lost/won)
    query(`opportunities?select=*&status=not.in.(passed,lost,won)&response_deadline=gte.${now.toISOString()}&response_deadline=lte.${d7from}&order=response_deadline.asc`),

    // Metalfab opportunities not passed (check notes and business column)
    query(`opportunities?select=*&status=not.in.(passed,lost)&or=(notes.ilike.*metalfab*,business.eq.metalfab)&order=response_deadline.asc&limit=25`),

    // Salvage opportunities not passed
    query(`opportunities?select=*&status=not.in.(passed,lost)&or=(notes.ilike.*salvage*,business.eq.salvage)&order=response_deadline.asc&limit=25`),

    // All opportunities for stats (just id, status, source)
    query(`opportunities?select=id,status,source`),
  ]);

  // Compute stats
  const statusCounts = {};
  const sourceCounts = {};
  for (const opp of allOpps) {
    statusCounts[opp.status] = (statusCounts[opp.status] || 0) + 1;
    const src = opp.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  // ── Print Report ──────────────────────────────────────────────

  console.log('\n' + '#'.repeat(70));
  console.log('  TCB METALWORKS — DAILY BID PIPELINE BRIEF');
  console.log(`  ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  console.log('#'.repeat(70));

  // URGENT: Deadlines within 72 hours
  printSection(
    '\uD83D\uDD25 URGENT: Deadlines within 72 hours',
    urgent,
    'No urgent deadlines. Breathe easy.'
  );

  // NEW TODAY
  printSection(
    '\uD83D\uDCCB NEW TODAY: Added in last 24 hours',
    newToday,
    'No new opportunities in the last 24 hours.'
  );

  // METALFAB OPPORTUNITIES
  printSection(
    '\uD83C\uDFED METALFAB OPPORTUNITIES: Active metal fab bids',
    metalfabReviewing,
    'No active metalfab-tagged opportunities.'
  );

  // SALVAGE OPPORTUNITIES
  printSection(
    '\uD83D\uDE97 SALVAGE OPPORTUNITIES: Active salvage bids',
    salvageReviewing,
    'No active salvage-tagged opportunities.'
  );

  // UPCOMING DEADLINES (next 7 days)
  printSection(
    '\uD83D\uDCC5 UPCOMING DEADLINES: Next 7 days',
    upcoming,
    'No deadlines in the next 7 days.'
  );

  // PIPELINE STATS
  console.log('\n' + '='.repeat(70));
  console.log('  \uD83D\uDCCA PIPELINE STATS');
  console.log('='.repeat(70));

  console.log('\n  By Status:');
  const statusOrder = ['new', 'reviewing', 'bidding', 'won', 'lost', 'passed'];
  for (const s of statusOrder) {
    const count = statusCounts[s] || 0;
    if (count > 0) {
      const bar = '\u2588'.repeat(Math.min(count, 40));
      console.log(`    ${s.padEnd(12)} ${String(count).padStart(5)}  ${bar}`);
    }
  }
  console.log(`    ${'TOTAL'.padEnd(12)} ${String(allOpps.length).padStart(5)}`);

  console.log('\n  By Source:');
  const sortedSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);
  for (const [src, count] of sortedSources) {
    const bar = '\u2588'.repeat(Math.min(count, 40));
    console.log(`    ${src.padEnd(16)} ${String(count).padStart(5)}  ${bar}`);
  }

  console.log('\n' + '#'.repeat(70));
  console.log('  END OF DAILY BRIEF');
  console.log('#'.repeat(70));

  // ── JSON summary for downstream consumption ───────────────────

  const summary = {
    generated_at: now.toISOString(),
    urgent_count: urgent.length,
    new_today_count: newToday.length,
    metalfab_active_count: metalfabReviewing.length,
    salvage_active_count: salvageReviewing.length,
    upcoming_7d_count: upcoming.length,
    total_opportunities: allOpps.length,
    by_status: statusCounts,
    by_source: sourceCounts,
    urgent_ids: urgent.map(o => ({ id: o.id, title: o.title, deadline: o.response_deadline })),
    new_today_ids: newToday.map(o => ({ id: o.id, title: o.title, score: o.score })),
  };

  console.log('\n__BRIEF_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__BRIEF_JSON_END__');

  return summary;
}

run().then(result => {
  console.log(`\nDaily brief complete. ${result.total_opportunities} total opportunities tracked.`);
}).catch(err => {
  console.error('Error generating daily brief:', err.message);
  process.exit(1);
});
