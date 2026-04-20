#!/usr/bin/env node
/**
 * fetch-docs.js — post-scrape document download step.
 *
 * For every opportunity with status in (new, reviewing), score >= threshold,
 * empty documents array, and not already flagged auth_required, dispatch to
 * a source-specific doc fetcher. Download matched candidates into Supabase
 * Storage. Promote to awaiting_qa when documents arrive.
 *
 * Usage:
 *   node scripts/fetch-docs.js            # all eligible opps
 *   node scripts/fetch-docs.js --limit=20 # cap processing
 *   node scripts/fetch-docs.js --only=cullen,milwaukee
 *   node scripts/fetch-docs.js --opp=<uuid> # single opportunity
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { downloadAndStore, flagAuthRequired } = require('../lib/documents');
const { promoteToAwaitingQa, getQaConfig } = require('../lib/qa-queue');
const { getFetcher } = require('../lib/doc-fetchers');
const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: null, only: null, opp: null };
  for (const a of args) {
    const m = a.match(/^--(limit|only|opp)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    if (m[1] === 'only') out.only = m[2].split(',').map((s) => s.trim());
    if (m[1] === 'opp') out.opp = m[2];
  }
  return out;
}

async function loadEligible({ threshold, limit, only, opp }) {
  if (opp) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opp}&select=*`,
      { headers: headers() }
    );
    return res.json();
  }

  const sel = 'id,title,source,source_url,sam_notice_id,status,score,documents,raw_data';
  const statusFilter = 'status=in.(new,reviewing)';
  const scoreFilter = `score=gte.${threshold}`;
  const docsFilter = 'documents=eq.[]';
  let url =
    `${SUPABASE_URL}/rest/v1/opportunities?select=${sel}&${statusFilter}&${scoreFilter}&${docsFilter}&order=score.desc`;
  if (only && only.length > 0) {
    url += `&source=in.(${only.join(',')})`;
  }
  if (limit) url += `&limit=${limit}`;
  const res = await fetch(url, { headers: headers() });
  return res.json();
}

async function runFetchDocs(options = {}) {
  const args = { ...parseArgs(), ...options };
  const cfg = await getQaConfig();
  if (!cfg.qa_analysis_enabled) {
    console.log('QA analysis disabled in config — skipping doc fetch.');
    return { ok: true, skipped: true, reason: 'qa_disabled' };
  }
  const threshold = cfg.qa_min_score_threshold;

  const run = await startRun('scrape', 'fetch-docs');
  console.log(`\n📎 fetch-docs — threshold=${threshold} limit=${args.limit || '∞'} only=${args.only || 'all'}`);

  const opps = await loadEligible({ ...args, threshold });
  if (!Array.isArray(opps)) {
    await addError(run, 'load', 'unexpected response from supabase');
    await finishRun(run, { status: 'failed' });
    return { ok: false, error: 'failed to load opportunities' };
  }
  console.log(`  ${opps.length} eligible opportunities\n`);

  let totalDownloaded = 0;
  let totalPromoted = 0;
  let totalAuth = 0;
  let totalSkipped = 0;

  for (const opp of opps) {
    const tag = `[${opp.source}] ${opp.title.slice(0, 60)}`;
    console.log(`▶ ${tag}`);
    const fetcher = getFetcher(opp.source);
    if (!fetcher) {
      console.log(`   ⚠️  no doc-fetcher for source "${opp.source}" — skipping`);
      totalSkipped++;
      continue;
    }

    let result;
    try {
      result = await fetcher(opp);
    } catch (e) {
      await addError(run, `fetch:${opp.source}`, `${opp.id}: ${e.message}`);
      console.log(`   ❌ fetcher error: ${e.message.slice(0, 100)}`);
      continue;
    }

    if (result.authRequired) {
      await flagAuthRequired(opp.id, opp.raw_data);
      totalAuth++;
      console.log(`   🔒 auth_required (${result.reason || '-'})`);
      continue;
    }

    if (!result.candidates || result.candidates.length === 0) {
      console.log(`   (no documents found: ${result.reason || 'none'})`);
      continue;
    }

    try {
      const dl = await downloadAndStore({
        opportunityId: opp.id,
        candidates: result.candidates,
        cookiesFile: result.cookiesFile,
      });
      totalDownloaded += dl.downloaded;
      if (dl.errors.length) {
        console.log(`   ⚠️  ${dl.errors.length} download errors`);
        for (const err of dl.errors.slice(0, 3)) console.log(`      - ${err}`);
      }
      console.log(`   📥 downloaded ${dl.downloaded} files (${Math.round(dl.bytes / 1024)} KB)`);
      if (dl.downloaded > 0) {
        const prom = await promoteToAwaitingQa(opp.id);
        if (prom.promoted) {
          totalPromoted++;
          console.log('   ✅ promoted → awaiting_qa');
        } else {
          console.log(`   (not promoted: ${prom.reason})`);
        }
      }
    } catch (e) {
      await addError(run, `download:${opp.id}`, e.message);
      console.log(`   ❌ download error: ${e.message.slice(0, 100)}`);
    }
  }

  await addStep(run, 'fetch-docs-complete', {
    opps: opps.length,
    downloaded: totalDownloaded,
    promoted: totalPromoted,
    auth_required: totalAuth,
    skipped: totalSkipped,
  });
  await finishRun(run, {
    status: 'success',
    opportunities_processed: opps.length,
    docs_downloaded: totalDownloaded,
  });

  console.log(`\n✅ fetch-docs done: ${totalDownloaded} files, ${totalPromoted} promoted, ${totalAuth} auth_required`);
  return {
    ok: true,
    opportunities: opps.length,
    downloaded: totalDownloaded,
    promoted: totalPromoted,
    auth_required: totalAuth,
    skipped: totalSkipped,
  };
}

module.exports = { runFetchDocs };

if (require.main === module) {
  runFetchDocs().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
