#!/usr/bin/env node
/**
 * qa-commit.js — reads qa-report.json files produced by Claude Code and
 * writes the results back to Supabase:
 *
 *   recommendation: "bid"                  → status = qa_qualified
 *   recommendation: "pass"                 → status = qa_rejected + immediate doc purge
 *   recommendation: "human_review_needed"  → stays awaiting_qa, flag qa_needs_human_review
 *
 * Also writes pipeline_events and cleans up ./qa-queue/<opp_id>/ folders
 * after each successful commit.
 *
 * Usage:
 *   node scripts/qa-commit.js            # commit everything in ./qa-queue
 *   node scripts/qa-commit.js --dry-run  # print what would happen
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { purgeOpportunityDocuments, uploadToStorage } = require('../lib/documents');
const { buildEstimatorPackage } = require('./qa-extract-pages');
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

const VALID_RISK_FLAGS = new Set([
  'bonding_required', 'prevailing_wage', 'dbe_requirement',
  'pre_qualification_required', 'davis_bacon', 'union_only',
  'aws_certification_required', 'aisc_certification_required',
  'pe_stamp_required', 'insurance_above_standard', 'performance_bond_above_100k',
]);
const VALID_RECS = new Set(['bid', 'pass', 'human_review_needed']);

function validateReport(report) {
  if (!report || typeof report !== 'object') return 'not an object';
  if (typeof report.scope_summary !== 'string') return 'scope_summary missing';
  if (typeof report.steel_metals_present !== 'boolean') return 'steel_metals_present must be boolean';
  if (!VALID_RECS.has(report.recommendation)) return `invalid recommendation: ${report.recommendation}`;
  if (!Array.isArray(report.risk_flags)) return 'risk_flags must be array';
  for (const flag of report.risk_flags) {
    if (!VALID_RISK_FLAGS.has(flag)) return `invalid risk_flag: ${flag}`;
  }
  if (!Array.isArray(report.scope_exclusions)) return 'scope_exclusions must be array';
  return null;
}

async function writeEvent(oppId, event_type, old_value, new_value) {
  return fetch(`${SUPABASE_URL}/rest/v1/pipeline_events`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      opportunity_id: oppId,
      event_type,
      old_value,
      new_value,
    }),
  });
}

async function patchOpportunity(oppId, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${oppId}: ${res.status} ${text.slice(0, 200)}`);
  }
  const arr = await res.json();
  return arr[0];
}

async function commitOne(oppId, report, { dryRun }) {
  const err = validateReport(report);
  if (err) throw new Error(`invalid report: ${err}`);

  // Load current status for event logging
  const curRes = await fetch(
    `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}&select=status,raw_data,documents`,
    { headers: headers() }
  );
  const [current] = await curRes.json();
  if (!current) throw new Error('opportunity not found');
  const oldStatus = current.status;

  const fullReport = { ...report, analyzed_at: report.analyzed_at || new Date().toISOString() };

  let newStatus = oldStatus;
  let needsHuman = false;
  if (report.recommendation === 'bid') newStatus = 'qa_qualified';
  else if (report.recommendation === 'pass') newStatus = 'qa_rejected';
  else { newStatus = 'awaiting_qa'; needsHuman = true; }

  // Build the estimator package PDF from kept_pages (skip on pass — no point)
  let estimatorPackagePath = null;
  let estimatorPackagePageCount = 0;
  if (!dryRun && report.recommendation !== 'pass' && Array.isArray(report.kept_pages) && report.kept_pages.length > 0) {
    const oppDir = path.join(QUEUE_DIR, oppId);
    try {
      const built = await buildEstimatorPackage(oppDir, report);
      if (built) {
        const storagePath = `${oppId}/${built.filename}`;
        await uploadToStorage(built.path, storagePath, 'application/pdf');
        estimatorPackagePath = storagePath;
        estimatorPackagePageCount = built.page_count;
        fullReport.estimator_package_path = storagePath;

        // Also append it to the opp.documents array as a `specification`
        // category so it shows up in the Inbound section of the opp detail.
        const existingDocs = Array.isArray(current.documents) ? current.documents : [];
        const filtered = existingDocs.filter((d) => d.storage_path !== storagePath);
        const stat = fs.statSync(built.path);
        filtered.push({
          filename: built.filename,
          storage_path: storagePath,
          downloaded_at: new Date().toISOString(),
          file_size: stat.size,
          mime_type: 'application/pdf',
          category: 'specification',
          uploaded_by: 'ai',
          description: `Filtered estimator package — ${built.page_count} page${built.page_count === 1 ? '' : 's'} from ${new Set(built.kept_pages_embedded.map((p) => p.source_filename)).size} source doc(s)`,
        });
        current.documents = filtered;
      }
    } catch (e) {
      console.log(`   ⚠️  estimator package build failed: ${e.message.slice(0, 100)}`);
    }
  }

  const patch = {
    qa_report: fullReport,
    qa_needs_human_review: needsHuman,
  };
  if (newStatus !== oldStatus) patch.status = newStatus;
  if (estimatorPackagePath) patch.documents = current.documents;

  // also stash into raw_data.qa_report for backwards compatibility
  const rawData = current.raw_data && typeof current.raw_data === 'object'
    ? { ...current.raw_data, qa_report: fullReport }
    : { qa_report: fullReport };
  patch.raw_data = rawData;

  if (dryRun) {
    console.log(`   [dry-run] would set status=${newStatus}`);
    return { newStatus, purged: 0, estimator_pages: estimatorPackagePageCount };
  }

  await patchOpportunity(oppId, patch);
  if (newStatus !== oldStatus) {
    await writeEvent(oppId, 'status_change', oldStatus, newStatus);
  }
  await writeEvent(oppId, 'qa_analyzed', null, report.recommendation);

  let purged = 0;
  if (report.recommendation === 'pass') {
    purged = await purgeOpportunityDocuments(oppId);
  }

  return { newStatus, purged, estimator_pages: estimatorPackagePageCount };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(QUEUE_DIR)) {
    console.log('No ./qa-queue directory. Run scripts/qa-prepare.js first.');
    return;
  }

  const run = await startRun('qa_commit', dryRun ? 'dry-run' : null);

  const entries = fs.readdirSync(QUEUE_DIR, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory());

  let committed = 0;
  let passed = 0;
  let qualified = 0;
  let human = 0;
  let totalPurged = 0;
  let errors = 0;

  for (const folder of folders) {
    const oppId = folder.name;
    const reportPath = path.join(QUEUE_DIR, oppId, 'qa-report.json');
    if (!fs.existsSync(reportPath)) {
      console.log(`⚠️  ${oppId.slice(0, 8)} — no qa-report.json, skipping`);
      continue;
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (e) {
      console.log(`❌ ${oppId.slice(0, 8)} — malformed JSON: ${e.message}`);
      await addError(run, 'parse', `${oppId}: ${e.message}`);
      errors++;
      continue;
    }
    try {
      const result = await commitOne(oppId, report, { dryRun });
      committed++;
      if (result.newStatus === 'qa_qualified') qualified++;
      else if (result.newStatus === 'qa_rejected') passed++;
      else human++;
      totalPurged += result.purged;
      const pkg = result.estimator_pages ? ` · estimator pkg ${result.estimator_pages}p` : '';
      console.log(`✅ ${oppId.slice(0, 8)} → ${result.newStatus}${result.purged ? ` (purged ${result.purged} docs)` : ''}${pkg}`);
      if (!dryRun) {
        fs.rmSync(path.join(QUEUE_DIR, oppId), { recursive: true, force: true });
      }
    } catch (e) {
      console.log(`❌ ${oppId.slice(0, 8)} — ${e.message.slice(0, 120)}`);
      await addError(run, 'commit', `${oppId}: ${e.message}`);
      errors++;
    }
  }

  await addStep(run, 'committed', {
    committed, qualified, passed, human,
    purged: totalPurged, errors,
  });
  await finishRun(run, {
    status: errors === 0 ? 'success' : 'partial',
    opportunities_processed: committed,
    docs_purged: totalPurged,
  });

  console.log(`\n📊 Commit summary: ${committed} opps — ${qualified} qualified, ${passed} passed (${totalPurged} docs purged), ${human} human_review`);
  if (errors > 0) console.log(`   ${errors} error(s) — check logs`);
  if (!dryRun && fs.existsSync(QUEUE_DIR)) {
    // remove batch manifest too if all folders handled
    const manifestPath = path.join(QUEUE_DIR, 'batch-manifest.json');
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    try { fs.rmdirSync(QUEUE_DIR); } catch {}
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
