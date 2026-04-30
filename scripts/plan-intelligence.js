#!/usr/bin/env node
/**
 * plan-intelligence.js — run the deterministic Plan Intelligence pipeline
 * for one opportunity. Downloads PDFs from Supabase Storage, classifies,
 * extracts sheet identities + cross-references, and writes the digest
 * to the plan_intelligence table (and a local copy under
 * ./plan-intelligence/<opp_id>/digest.json for inspection).
 *
 * Usage:
 *   node scripts/plan-intelligence.js --opp=<opportunity_id>
 *   node scripts/plan-intelligence.js --opp=<id> --dry-run     # no DB write
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { processPackage } = require('../lib/plan-intelligence');
const { parseXlsxBidForm, parsePdfBidForm, allowedCategoriesFromCsi } = require('../lib/plan-intelligence/parse-bid-form');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = path.join(__dirname, '..', 'plan-intelligence');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null, dryRun: false };
  for (const a of args) {
    if (a === '--dry-run') out.dryRun = true;
    const m = a.match(/^--opp=(.+)$/);
    if (m) out.opp = m[1];
  }
  return out;
}

async function loadOpp(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${id}&select=id,title,documents`,
    { headers: headers() }
  );
  const arr = await res.json();
  return Array.isArray(arr) ? arr[0] : null;
}

async function downloadDoc(oppId, filename) {
  const url = `${SUPABASE_URL}/storage/v1/object/bid-docs/${oppId}/${filename}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`storage ${filename} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upsertDigest(oppId, digest) {
  // PostgREST upsert: needs on_conflict param to know which uniq key
  // to dedupe on. Without it, a second run for the same opp 409s.
  const url = `${SUPABASE_URL}/rest/v1/plan_intelligence?on_conflict=opportunity_id`;
  const body = [{
    opportunity_id: oppId,
    digest,
    summary: digest.summary,
    ready_for_takeoff: digest.summary.readiness === 'ready_for_takeoff',
    generated_at: digest.generated_at,
  }];
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`upsert plan_intelligence: ${res.status} ${t}`);
  }
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/plan-intelligence.js --opp=<id> [--dry-run]');
    process.exit(1);
  }

  const opp = await loadOpp(args.opp);
  if (!opp) {
    console.error(`opportunity not found: ${args.opp}`);
    process.exit(1);
  }
  const docs = opp.documents || [];
  if (docs.length === 0) {
    console.error('opportunity has no documents');
    process.exit(1);
  }

  console.log(`Opp: ${opp.title} (${opp.id})`);
  console.log(`Documents: ${docs.length}`);

  const buffers = [];
  const bidFormCandidates = [];
  for (const d of docs) {
    const fn = d.filename || '';
    if (/\.pdf$/i.test(fn)) {
      process.stdout.write(`  fetch ${fn} … `);
      const buf = await downloadDoc(args.opp, fn);
      console.log(`${(buf.length / 1024).toFixed(0)} KB`);
      buffers.push({ filename: fn, category: d.category, buffer: buf });
      // Bid-form PDFs (the GC's CSI line-item form)
      if (d.category === 'form' || /bid[\s_-]?form|gc[\s_-]?bid/i.test(fn)) {
        bidFormCandidates.push({ filename: fn, kind: 'pdf', buffer: buf });
      }
    } else if (/\.xlsx?$/i.test(fn) && (d.category === 'form' || /bid[\s_-]?form|gc[\s_-]?bid/i.test(fn))) {
      // Pull the xlsx bid form to disk so the parser can read it
      process.stdout.write(`  fetch ${fn} (bid form) … `);
      const buf = await downloadDoc(args.opp, fn);
      const tmpPath = require('path').join(require('os').tmpdir(), `bidform-${args.opp}-${Date.now()}.xlsx`);
      require('fs').writeFileSync(tmpPath, buf);
      console.log(`${(buf.length / 1024).toFixed(0)} KB`);
      bidFormCandidates.push({ filename: fn, kind: 'xlsx', tmpPath });
    } else {
      console.log(`  skip (not pdf/xlsx form): ${fn}`);
    }
  }

  console.log('Running Plan Intelligence …');
  const digest = await processPackage(buffers);

  // Bid-form CSI envelope (cross-checks takeoff line categories later)
  let bidFormCsi = [];
  for (const cand of bidFormCandidates) {
    if (cand.kind === 'xlsx') {
      const codes = parseXlsxBidForm(cand.tmpPath);
      bidFormCsi.push(...codes.map((c) => ({ ...c, source_filename: cand.filename })));
      try { require('fs').unlinkSync(cand.tmpPath); } catch {}
    } else {
      const codes = await parsePdfBidForm(cand.buffer);
      bidFormCsi.push(...codes.map((c) => ({ ...c, source_filename: cand.filename })));
    }
  }
  // Dedup by code
  const seen = new Set();
  bidFormCsi = bidFormCsi.filter((c) => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
  digest.summary.bid_form_csi_codes = bidFormCsi;
  digest.summary.bid_form_allowed_categories = allowedCategoriesFromCsi(bidFormCsi);
  if (bidFormCsi.length) {
    console.log(`  Bid form CSI codes: ${bidFormCsi.length} found (${bidFormCsi.slice(0, 8).map((c) => c.code).join(', ')}${bidFormCsi.length > 8 ? '…' : ''})`);
    console.log(`  Allowed takeoff categories: ${digest.summary.bid_form_allowed_categories.join(', ') || '(none)'}`);
  }

  // Write local copy for inspection
  const oppDir = path.join(OUT_DIR, args.opp);
  fs.mkdirSync(oppDir, { recursive: true });
  // Strip per-page items[] from the local copy — too large to be useful
  const trimmed = JSON.parse(JSON.stringify(digest));
  for (const d of trimmed.documents) {
    for (const s of d.sheets || []) delete s.items;
  }
  fs.writeFileSync(path.join(oppDir, 'digest.json'), JSON.stringify(trimmed, null, 2));
  console.log(`Wrote ${path.join(oppDir, 'digest.json')}`);

  // Print summary
  console.log('\n=== Summary ===');
  console.log(JSON.stringify(digest.summary, null, 2));

  if (args.dryRun) {
    console.log('\n[dry-run] skipping DB upsert');
    return;
  }
  await upsertDigest(args.opp, digest);
  console.log('\nDB upsert OK');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
