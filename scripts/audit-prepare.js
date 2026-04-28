#!/usr/bin/env node
/**
 * audit-prepare.js — stage an adversarial audit job for Claude Code.
 *
 * Pulls the latest takeoff_run for an opp, the source PDFs (spec,
 * Q&A, drawings), the rate card, and the assembly priors into
 * ./audit-queue/<opp_id>/. Crucially: only the takeoff's *conclusions*
 * (category + description + quantity) are passed to the auditor — its
 * reasoning and source evidence are withheld so the audit reaches its
 * findings independently.
 *
 * Usage:
 *   node scripts/audit-prepare.js --opp=<opportunity_id>
 *   node scripts/audit-prepare.js --run=<takeoff_run_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'audit-queue');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null, run: null };
  for (const a of args) {
    let m = a.match(/^--opp=(.+)$/);
    if (m) out.opp = m[1];
    m = a.match(/^--run=(.+)$/);
    if (m) out.run = m[1];
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadLatestTakeoff(oppId) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_runs?opportunity_id=eq.${oppId}&select=*&order=generated_at.desc&limit=1`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadTakeoffById(runId) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_runs?id=eq.${runId}&select=*`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadTakeoffLines(runId) {
  return getJson(`${SUPABASE_URL}/rest/v1/takeoff_lines?takeoff_run_id=eq.${runId}&select=line_no,category,description,quantity,quantity_unit,steel_shape_designation,total_weight_lbs,fab_hrs,det_hrs,foreman_hrs,ironworker_hrs,finish&order=line_no.asc`);
}

async function loadOpp(id) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${id}&select=id,title,agency,response_deadline,documents`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadPlanIntel(oppId) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${oppId}&select=*&order=generated_at.desc&limit=1`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadAssemblyPriors() {
  return getJson(`${SUPABASE_URL}/rest/v1/assembly_labor_priors?select=*`);
}

async function loadRateCard(versionId) {
  if (versionId) {
    const arr = await getJson(`${SUPABASE_URL}/rest/v1/rate_card_versions?id=eq.${versionId}&select=*`);
    return Array.isArray(arr) ? arr[0] : null;
  }
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/rate_card_versions?effective_to=is.null&select=*&order=effective_from.desc&limit=1`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function downloadPdfsForAudit(oppId, planIntel, oppDir) {
  const docs = planIntel?.digest?.documents || [];
  const include = docs.filter((d) => {
    const kind = d?.classification?.kind;
    return kind === 'specification' || kind === 'qa_log' || kind === 'drawing' || kind === 'addendum';
  });
  const staged = [];
  for (const d of include) {
    const filename = d.filename;
    process.stdout.write(`  fetch ${filename} … `);
    try {
      await downloadStorageFile(`${oppId}/${filename}`, path.join(oppDir, filename));
      const sz = fs.statSync(path.join(oppDir, filename)).size;
      console.log(`${(sz / 1024).toFixed(0)} KB`);
      staged.push({ filename, kind: d.classification.kind });
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  return staged;
}

async function main() {
  const args = parseArgs();
  if (!args.opp && !args.run) {
    console.error('usage: node scripts/audit-prepare.js --opp=<id> | --run=<takeoff_run_id>');
    process.exit(1);
  }

  let takeoff;
  if (args.run) {
    takeoff = await loadTakeoffById(args.run);
    if (!takeoff) { console.error('takeoff_run not found'); process.exit(1); }
    args.opp = takeoff.opportunity_id;
  } else {
    takeoff = await loadLatestTakeoff(args.opp);
    if (!takeoff) { console.error('no takeoff_run for that opp'); process.exit(1); }
  }

  const [opp, planIntel, lines, priors, rate] = await Promise.all([
    loadOpp(args.opp),
    loadPlanIntel(args.opp),
    loadTakeoffLines(takeoff.id),
    loadAssemblyPriors(),
    loadRateCard(takeoff.rate_card_version_id),
  ]);

  if (!opp) { console.error('opp not found'); process.exit(1); }
  if (!planIntel) { console.error('no plan_intelligence'); process.exit(1); }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  if (fs.existsSync(oppDir)) fs.rmSync(oppDir, { recursive: true, force: true });
  fs.mkdirSync(oppDir, { recursive: true });

  console.log(`Staging audit job into ${oppDir}…`);
  const stagedFiles = await downloadPdfsForAudit(args.opp, planIntel, oppDir);

  // Conclusions only — no assumptions, no source_evidence (kept in DB).
  const sanitizedLines = lines.map((l) => ({
    line_no: l.line_no,
    category: l.category,
    description: l.description,
    quantity: l.quantity,
    quantity_unit: l.quantity_unit,
    steel_shape_designation: l.steel_shape_designation,
    total_weight_lbs: l.total_weight_lbs,
    fab_hrs: l.fab_hrs,
    det_hrs: l.det_hrs,
    foreman_hrs: l.foreman_hrs,
    ironworker_hrs: l.ironworker_hrs,
    finish: l.finish,
  }));

  const summary = planIntel.summary;
  const context = {
    opportunity: {
      id: opp.id,
      title: opp.title,
      agency: opp.agency,
      response_deadline: opp.response_deadline,
    },
    bid_stage: summary.bid_stage,
    bid_stage_confidence: summary.bid_stage_confidence,
    tcb_sections: summary.tcb_sections || [],
    package_documents: stagedFiles,
    existing_takeoff: {
      run_id: takeoff.id,
      stage: takeoff.stage,
      total_weight_lbs: takeoff.total_weight_lbs,
      total_ironworker_hrs: takeoff.total_ironworker_hrs,
      bid_total_usd: takeoff.bid_total_usd,
      lines: sanitizedLines,
    },
    rate_card: rate,
    assembly_labor_priors: priors,
    instructions_file: '../scripts/audit.md',
  };

  fs.writeFileSync(path.join(oppDir, 'audit-context.json'), JSON.stringify(context, null, 2));
  console.log(`Wrote ${path.join(oppDir, 'audit-context.json')}`);

  console.log('\n--- Ready ---');
  console.log(`Opp:           ${opp.title}`);
  console.log(`Takeoff:       ${takeoff.id} ($${takeoff.bid_total_usd?.toFixed(0) || '?'})`);
  console.log(`Lines:         ${sanitizedLines.length}`);
  console.log(`Files staged:  ${stagedFiles.length}`);
  console.log('\nNext: run Claude Code:');
  console.log(`  claude -p "$(cat scripts/audit.md)" --max-turns 100 --dangerously-skip-permissions`);
  console.log('Then: node scripts/audit-commit.js --opp=' + args.opp);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
