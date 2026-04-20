#!/usr/bin/env node
/**
 * qa-prepare.js — pulls the current awaiting_qa queue to the local machine
 * so Claude Code can analyze the PDFs.
 *
 * Output:
 *   ./qa-queue/batch-manifest.json  — list of opp ids + metadata
 *   ./qa-queue/<opp_id>/context.json
 *   ./qa-queue/<opp_id>/<filename>  — downloaded PDFs from Supabase Storage
 *
 * Claude Code then reads these, writes qa-report.json into each folder,
 * and scripts/qa-commit.js pushes results back.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');
const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'qa-queue');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: null, opp: null };
  for (const a of args) {
    const m = a.match(/^--(limit|opp)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    if (m[1] === 'opp') out.opp = m[2];
  }
  return out;
}

async function loadAwaitingQa({ limit, opp }) {
  let url;
  if (opp) {
    url = `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opp}&select=*`;
  } else {
    url = `${SUPABASE_URL}/rest/v1/opportunities?status=eq.awaiting_qa&select=*&order=score.desc`;
    if (limit) url += `&limit=${limit}`;
  }
  const res = await fetch(url, { headers: headers() });
  return res.json();
}

async function loadScoringConfig() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/scoring_config?select=*&limit=1`,
    { headers: headers() }
  );
  const arr = await res.json();
  return Array.isArray(arr) ? arr[0] : null;
}

async function main() {
  const args = parseArgs();

  const run = await startRun('qa_prepare', args.opp ? `single:${args.opp}` : `limit:${args.limit || 'all'}`);

  // Fresh queue directory
  if (fs.existsSync(QUEUE_DIR)) {
    fs.rmSync(QUEUE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(QUEUE_DIR, { recursive: true });

  const opps = await loadAwaitingQa(args);
  if (!Array.isArray(opps) || opps.length === 0) {
    console.log('No opportunities in awaiting_qa.');
    fs.writeFileSync(
      path.join(QUEUE_DIR, 'batch-manifest.json'),
      JSON.stringify({ prepared_at: new Date().toISOString(), opportunities: [] }, null, 2)
    );
    await finishRun(run, { status: 'success', opportunities_processed: 0 });
    return;
  }

  const config = await loadScoringConfig();
  const manifest = {
    prepared_at: new Date().toISOString(),
    scope_criteria: {
      primary_keywords: config?.keyword_primary || [],
      secondary_keywords: config?.keyword_secondary || [],
      disqualifying_keywords: config?.keyword_disqualify || [],
      naics_codes: config?.naics_codes || [],
      dollar_min: config?.dollar_min,
      dollar_max: config?.dollar_max,
    },
    opportunities: [],
  };

  console.log(`\n📦 Preparing ${opps.length} opportunities for QA...\n`);

  for (const opp of opps) {
    const oppDir = path.join(QUEUE_DIR, opp.id);
    fs.mkdirSync(oppDir, { recursive: true });

    const context = {
      id: opp.id,
      title: opp.title,
      agency: opp.agency,
      sub_agency: opp.sub_agency,
      naics_code: opp.naics_code,
      naics_description: opp.naics_description,
      dollar_min: opp.dollar_min,
      dollar_max: opp.dollar_max,
      posted_date: opp.posted_date,
      response_deadline: opp.response_deadline,
      place_of_performance: opp.place_of_performance,
      source: opp.source,
      source_url: opp.source_url,
      description: opp.description,
      score: opp.score,
      documents: opp.documents || [],
    };
    fs.writeFileSync(path.join(oppDir, 'context.json'), JSON.stringify(context, null, 2));

    const documents = opp.documents || [];
    const downloaded = [];
    for (const doc of documents) {
      const localPath = path.join(oppDir, doc.filename);
      try {
        const bytes = await downloadStorageFile(doc.storage_path, localPath);
        downloaded.push({ ...doc, local_path: path.relative(QUEUE_DIR, localPath), bytes });
      } catch (e) {
        await addError(run, 'download', `${opp.id}/${doc.filename}: ${e.message}`);
        console.log(`   ⚠️  failed to pull ${doc.filename}: ${e.message.slice(0, 100)}`);
      }
    }

    manifest.opportunities.push({
      id: opp.id,
      title: opp.title,
      source: opp.source,
      score: opp.score,
      response_deadline: opp.response_deadline,
      folder: path.relative(path.join(__dirname, '..'), oppDir),
      documents: downloaded,
    });

    console.log(`  ✔ ${opp.id.slice(0, 8)} — ${opp.title.slice(0, 60)} (${downloaded.length} files)`);
  }

  fs.writeFileSync(
    path.join(QUEUE_DIR, 'batch-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  await addStep(run, 'prepared', { opportunities: manifest.opportunities.length });
  await finishRun(run, {
    status: 'success',
    opportunities_processed: manifest.opportunities.length,
  });

  console.log(`\n✅ Queue ready at ./qa-queue — ${manifest.opportunities.length} opps`);
  console.log('   Next: open Claude Code and run  scripts/qa-analyze.md');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
