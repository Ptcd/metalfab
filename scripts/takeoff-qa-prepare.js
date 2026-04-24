#!/usr/bin/env node
/**
 * takeoff-qa-prepare.js — stage a takeoff-QA job for Claude Code.
 *
 * Usage:
 *   node scripts/takeoff-qa-prepare.js --opp=<opportunity_id>
 *
 * Pulls the opp's qa_report + takeoff file (whatever document is
 * categorized 'takeoff' on the opp) + the filtered estimator package
 * into ./takeoff-queue/<opp_id>/ along with a context.json. Claude Code
 * reads that folder and writes takeoff-qa-report.json.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');

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

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null };
  for (const a of args) {
    const m = a.match(/^--opp=(.+)$/);
    if (m) out.opp = m[1];
  }
  return out;
}

async function loadOpp(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${id}&select=*`,
    { headers: headers() }
  );
  const [opp] = await res.json();
  return opp;
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node takeoff-qa-prepare.js --opp=<opportunity_id>');
    process.exit(1);
  }
  const opp = await loadOpp(args.opp);
  if (!opp) {
    console.error('opportunity not found');
    process.exit(1);
  }
  if (!opp.qa_report) {
    console.error('no qa_report on this opp — run qa-analyze first');
    process.exit(1);
  }

  const docs = Array.isArray(opp.documents) ? opp.documents : [];
  const takeoffDoc = docs.find((d) => d.category === 'takeoff');
  if (!takeoffDoc) {
    console.error('no takeoff document on this opp — upload one first (category: Takeoff)');
    process.exit(1);
  }
  const estPackageDoc = docs.find((d) =>
    d.storage_path === opp.qa_report?.estimator_package_path ||
    d.filename === 'estimator-package.pdf'
  );

  const oppDir = path.join(QUEUE_DIR, opp.id);
  if (fs.existsSync(oppDir)) fs.rmSync(oppDir, { recursive: true, force: true });
  fs.mkdirSync(oppDir, { recursive: true });

  // Download takeoff
  const takeoffLocal = path.join(oppDir, takeoffDoc.filename);
  await downloadStorageFile(takeoffDoc.storage_path, takeoffLocal);
  console.log(`✓ takeoff: ${takeoffDoc.filename} (${Math.round(takeoffDoc.file_size / 1024)} KB)`);

  // Download estimator package if present
  if (estPackageDoc) {
    const estLocal = path.join(oppDir, estPackageDoc.filename);
    await downloadStorageFile(estPackageDoc.storage_path, estLocal);
    console.log(`✓ estimator package: ${estPackageDoc.filename}`);
  }

  // Write context
  const context = {
    opportunity: {
      id: opp.id,
      title: opp.title,
      agency: opp.agency,
      source: opp.source,
      response_deadline: opp.response_deadline,
    },
    takeoff_filename: takeoffDoc.filename,
    estimator_package_filename: estPackageDoc?.filename ?? null,
    identified_members: opp.qa_report?.identified_members || [],
    qa_report_summary: {
      scope_summary: opp.qa_report?.scope_summary,
      finish_spec: opp.qa_report?.finish_spec,
      connection_notes: opp.qa_report?.connection_notes,
      risk_flags: opp.qa_report?.risk_flags || [],
      scope_exclusions: opp.qa_report?.scope_exclusions || [],
    },
  };
  fs.writeFileSync(path.join(oppDir, 'context.json'), JSON.stringify(context, null, 2));

  console.log(`\n✅ Staged ./takeoff-queue/${opp.id}/`);
  console.log(`   Next: open Claude Code, run  scripts/takeoff-qa.md`);
  console.log(`   Then: node scripts/takeoff-qa-commit.js`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
