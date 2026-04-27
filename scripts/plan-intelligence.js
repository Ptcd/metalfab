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
  const url = `${SUPABASE_URL}/rest/v1/plan_intelligence`;
  const body = [{
    opportunity_id: oppId,
    digest,
    summary: digest.summary,
    ready_for_takeoff: digest.summary.ready_for_takeoff,
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
  for (const d of docs) {
    if (!d.filename || !/\.pdf$/i.test(d.filename)) {
      console.log(`  skip (non-pdf): ${d.filename}`);
      continue;
    }
    process.stdout.write(`  fetch ${d.filename} … `);
    const buf = await downloadDoc(args.opp, d.filename);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    buffers.push({ filename: d.filename, category: d.category, buffer: buf });
  }

  console.log('Running Plan Intelligence …');
  const digest = await processPackage(buffers);

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
