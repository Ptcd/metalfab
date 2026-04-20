#!/usr/bin/env node
/**
 * cleanup-storage.js — daily scheduled cleanup of bid documents.
 *
 * Deletes documents from Supabase Storage for opportunities matching any of:
 *   - status=won  AND  updated_at > doc_retention_won_days ago
 *   - status=lost AND  updated_at > doc_retention_lost_days ago
 *   - status=bidding AND response_deadline > 30 days in the past
 *
 * Never touches docs for qa_qualified, awaiting_qa, or reviewing status.
 * Safety net: if more than 50 opps would be purged in one run, aborts unless
 * --force is passed.
 *
 * Note: immediate purges (qa_rejected from qa-commit.js, user-marked passed)
 * are handled in lib/documents.js:purgeOpportunityDocuments elsewhere. This
 * script only handles the time-based sweep.
 *
 * Usage:
 *   node scripts/cleanup-storage.js
 *   node scripts/cleanup-storage.js --dry-run
 *   node scripts/cleanup-storage.js --force
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { purgeOpportunityDocuments } = require('../lib/documents');
const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SAFETY_LIMIT = 50;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function loadConfig() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/scoring_config?select=doc_retention_won_days,doc_retention_lost_days&limit=1`,
    { headers: headers() }
  );
  const [cfg] = await res.json();
  return cfg || { doc_retention_won_days: 90, doc_retention_lost_days: 14 };
}

async function findCandidates(cfg) {
  const now = Date.now();
  const wonCutoff = new Date(now - cfg.doc_retention_won_days * 86400_000).toISOString();
  const lostCutoff = new Date(now - cfg.doc_retention_lost_days * 86400_000).toISOString();
  const staleCutoff = new Date(now - 30 * 86400_000).toISOString();

  const sel = 'id,title,status,response_deadline,updated_at,documents';
  const hasDocs = 'documents=neq.[]';

  async function q(filter) {
    const url = `${SUPABASE_URL}/rest/v1/opportunities?select=${sel}&${hasDocs}&${filter}`;
    const res = await fetch(url, { headers: headers() });
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  }

  const [won, lost, stale] = await Promise.all([
    q(`status=eq.won&updated_at=lt.${wonCutoff}`),
    q(`status=eq.lost&updated_at=lt.${lostCutoff}`),
    q(`status=eq.bidding&response_deadline=lt.${staleCutoff}`),
  ]);

  const all = [...won, ...lost, ...stale];
  const seen = new Set();
  return all.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

async function runCleanup({ dryRun = false, force = false } = {}) {
  const run = await startRun('cleanup', dryRun ? 'dry-run' : force ? 'force' : null);

  const cfg = await loadConfig();
  console.log(`Retention: won=${cfg.doc_retention_won_days}d, lost=${cfg.doc_retention_lost_days}d, stale-bidding=30d`);

  const candidates = await findCandidates(cfg);
  console.log(`Found ${candidates.length} opportunity/ies with docs eligible for purge:`);
  for (const c of candidates) {
    console.log(`  [${c.status}] ${c.id.slice(0, 8)} — ${c.title.slice(0, 70)} (${(c.documents || []).length} docs)`);
  }

  if (candidates.length > SAFETY_LIMIT && !force) {
    const msg = `SAFETY: would purge ${candidates.length} opps (>${SAFETY_LIMIT}). Re-run with --force to proceed.`;
    console.log(`\n⚠️  ${msg}`);
    await addError(run, 'safety', msg);
    await finishRun(run, { status: 'failed' });
    return { ok: false, safety_abort: true, candidates: candidates.length };
  }

  if (dryRun) {
    console.log('\n[dry-run] no changes made');
    await addStep(run, 'dry-run', { candidates: candidates.length });
    await finishRun(run, { status: 'success' });
    return { ok: true, dryRun: true, candidates: candidates.length, purged: 0 };
  }

  let totalPurged = 0;
  for (const c of candidates) {
    try {
      const purged = await purgeOpportunityDocuments(c.id);
      totalPurged += purged;
      console.log(`✓ purged ${purged} files for ${c.id.slice(0, 8)}`);
    } catch (e) {
      await addError(run, 'purge', `${c.id}: ${e.message}`);
      console.log(`❌ ${c.id.slice(0, 8)} — ${e.message.slice(0, 100)}`);
    }
  }

  await addStep(run, 'cleanup-complete', {
    opps_processed: candidates.length,
    files_purged: totalPurged,
  });
  await finishRun(run, {
    status: 'success',
    opportunities_processed: candidates.length,
    docs_purged: totalPurged,
  });
  console.log(`\n✅ Cleanup complete: ${candidates.length} opps, ${totalPurged} files purged`);
  return { ok: true, candidates: candidates.length, purged: totalPurged };
}

module.exports = { runCleanup };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  runCleanup({ dryRun, force }).catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
