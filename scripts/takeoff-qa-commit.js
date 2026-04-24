#!/usr/bin/env node
/**
 * takeoff-qa-commit.js — push Claude Code's takeoff-qa-report.json back
 * to Supabase. Writes to opp.raw_data.takeoff_qa and logs a pipeline event.
 * Cleans up ./takeoff-queue/<opp>/ folders after a successful commit.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'takeoff-queue');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function main() {
  if (!fs.existsSync(QUEUE_DIR)) {
    console.log('No ./takeoff-queue to commit.');
    return;
  }
  const folders = fs.readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  let committed = 0;
  let errors = 0;
  for (const folder of folders) {
    const oppId = folder.name;
    const reportPath = path.join(QUEUE_DIR, oppId, 'takeoff-qa-report.json');
    if (!fs.existsSync(reportPath)) {
      console.log(`⚠️  ${oppId.slice(0, 8)} — no takeoff-qa-report.json, skipping`);
      continue;
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (e) {
      console.log(`❌ ${oppId.slice(0, 8)} — malformed JSON: ${e.message}`);
      errors++;
      continue;
    }

    // Pull current raw_data so we can merge
    const curRes = await fetch(
      `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}&select=raw_data`,
      { headers: headers() }
    );
    const [cur] = await curRes.json();
    if (!cur) {
      console.log(`❌ ${oppId.slice(0, 8)} — opp not found`);
      errors++;
      continue;
    }
    const raw = cur.raw_data && typeof cur.raw_data === 'object' ? { ...cur.raw_data } : {};
    raw.takeoff_qa = report;

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}`,
      {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({ raw_data: raw }),
      }
    );
    if (!patchRes.ok) {
      const text = await patchRes.text();
      console.log(`❌ ${oppId.slice(0, 8)} — ${patchRes.status} ${text.slice(0, 100)}`);
      errors++;
      continue;
    }

    // Pipeline event
    const highIssues =
      (report.spec_missing_from_takeoff || []).filter((i) => i.severity === 'high').length +
      (report.quantity_mismatches || []).filter((i) => i.severity === 'high').length +
      (report.finish_issues || []).filter((i) => i.severity === 'high').length;
    await fetch(`${SUPABASE_URL}/rest/v1/pipeline_events`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        opportunity_id: oppId,
        event_type: 'qa_analyzed',
        new_value: `takeoff QA: ${report.recommendation || 'reviewed'}${highIssues ? ` (${highIssues} high)` : ''}`,
      }),
    });

    committed++;
    console.log(`✅ ${oppId.slice(0, 8)} → takeoff QA ${report.recommendation || 'committed'}${highIssues ? ` (${highIssues} high-severity)` : ''}`);
    fs.rmSync(path.join(QUEUE_DIR, oppId), { recursive: true, force: true });
  }

  console.log(`\n📊 ${committed} committed, ${errors} errors`);
  try { fs.rmdirSync(QUEUE_DIR); } catch {}
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
