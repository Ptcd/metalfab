#!/usr/bin/env node
/**
 * takeoff-prepare.js — stage a takeoff job for Claude Code.
 *
 * Pulls plan_intelligence + the relevant PDFs + the rate card +
 * assembly priors + steel shape catalog into ./takeoff-queue/<opp_id>/
 * along with a context.json. Claude Code then reads scripts/takeoff.md
 * and writes ./takeoff-queue/<opp_id>/takeoff.json. takeoff-commit.js
 * pushes the result back into Supabase with deterministic pricing.
 *
 * Usage:
 *   node scripts/takeoff-prepare.js --opp=<opportunity_id>
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

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadOpp(id) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${id}&select=id,title,agency,response_deadline,description,documents,customer_id`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadPlanIntelligence(oppId) {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${oppId}&select=*&order=generated_at.desc&limit=1`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadRateCard() {
  const arr = await getJson(`${SUPABASE_URL}/rest/v1/rate_card_versions?effective_to=is.null&select=*&order=effective_from.desc&limit=1`);
  return Array.isArray(arr) ? arr[0] : null;
}

async function loadAssemblyPriors() {
  return getJson(`${SUPABASE_URL}/rest/v1/assembly_labor_priors?select=*&order=assembly_type.asc`);
}

async function loadSteelShapes() {
  return getJson(`${SUPABASE_URL}/rest/v1/steel_shapes?select=designation,shape_family,unit,unit_weight,description&limit=1000`);
}

async function downloadPdfsForTakeoff(oppId, planIntel, oppDir) {
  // What PDFs to bring in:
  //  - The spec (kind=specification) — full file (Claude reads relevant
  //    pages via the first_page hints in tcb_sections)
  //  - The Q&A log
  //  - Any drawings (kind=drawing)
  //  - Skip geotech, schedules, raster-only files (Claude can't read them
  //    via the Read tool anyway)
  const docs = planIntel?.digest?.documents || [];
  const include = docs.filter((d) => {
    const kind = d?.classification?.kind;
    return kind === 'specification' || kind === 'qa_log' || kind === 'drawing' || kind === 'addendum';
  });

  const stagedFiles = [];
  for (const d of include) {
    const filename = d.filename;
    const storagePath = `${oppId}/${filename}`;
    const localPath = path.join(oppDir, filename);
    process.stdout.write(`  fetch ${filename} … `);
    try {
      await downloadStorageFile(storagePath, localPath);
      const sz = fs.statSync(localPath).size;
      console.log(`${(sz / 1024).toFixed(0)} KB`);
      stagedFiles.push({
        filename,
        kind: d.classification.kind,
        relevance: d.relevance,
      });
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  return stagedFiles;
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/takeoff-prepare.js --opp=<opportunity_id>');
    process.exit(1);
  }

  console.log('Loading opportunity, plan intelligence, rate card, priors, shapes…');
  const [opp, planIntel, rateCard, priors, shapes] = await Promise.all([
    loadOpp(args.opp),
    loadPlanIntelligence(args.opp),
    loadRateCard(),
    loadAssemblyPriors(),
    loadSteelShapes(),
  ]);

  if (!opp) {
    console.error('opportunity not found');
    process.exit(1);
  }
  if (!planIntel) {
    console.error('no plan_intelligence row — run scripts/plan-intelligence.js first');
    process.exit(1);
  }
  if (!rateCard) {
    console.error('no current rate_card_versions row');
    process.exit(1);
  }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  if (fs.existsSync(oppDir)) fs.rmSync(oppDir, { recursive: true, force: true });
  fs.mkdirSync(oppDir, { recursive: true });

  console.log(`Staging files into ${oppDir}…`);
  const stagedFiles = await downloadPdfsForTakeoff(args.opp, planIntel, oppDir);

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
    readiness: summary.readiness,
    tcb_sections: summary.tcb_sections || [],
    sheets_referenced: summary.sheets_referenced || [],
    sheets_covered: summary.sheets_covered || [],
    sheets_expected_at_cd: summary.sheets_expected_at_cd || [],
    package_documents: stagedFiles,
    rate_card: rateCard,
    assembly_labor_priors: priors,
    steel_shapes: shapes,
    instructions_file: '../scripts/takeoff.md',
  };

  fs.writeFileSync(path.join(oppDir, 'context.json'), JSON.stringify(context, null, 2));
  console.log(`Wrote ${path.join(oppDir, 'context.json')}`);

  console.log('\n--- Ready ---');
  console.log(`Stage: ${summary.bid_stage} (${summary.bid_stage_confidence}%)`);
  console.log(`Readiness: ${summary.readiness}`);
  console.log(`TCB sections in spec: ${(summary.tcb_sections || []).map((s) => s.section).join(', ') || 'none'}`);
  console.log(`Files staged: ${stagedFiles.length}`);
  console.log('\nNext: run Claude Code:');
  console.log(`  claude -p "$(cat scripts/takeoff.md)" --max-turns 100 --dangerously-skip-permissions`);
  console.log('Then: node scripts/takeoff-commit.js --opp=' + args.opp);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
