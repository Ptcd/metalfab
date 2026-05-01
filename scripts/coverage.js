#!/usr/bin/env node
/**
 * coverage.js — build the coverage manifest for one opportunity.
 *
 * Pulls the latest plan_intelligence digest, runs the deterministic
 * manifest builder, persists to coverage_manifests, writes a local
 * copy to ./coverage/<opp_id>/manifest.json for inspection.
 *
 * Run between plan-intelligence and takeoff-prepare:
 *   node scripts/plan-intelligence.js --opp=<id>
 *   node scripts/coverage.js          --opp=<id>     <-- this stage
 *   node scripts/takeoff-prepare.js   --opp=<id>
 *   claude -p "$(cat scripts/takeoff.md)" ...
 *   node scripts/takeoff-commit.js    --opp=<id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { buildManifest } = require('../lib/coverage');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = path.join(__dirname, '..', 'coverage');

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

async function loadDigest(oppId) {
  const url = `${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${oppId}&select=digest&order=generated_at.desc&limit=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`plan_intelligence load: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  return Array.isArray(arr) && arr[0] ? arr[0].digest : null;
}

async function upsertManifest(oppId, manifest) {
  const url = `${SUPABASE_URL}/rest/v1/coverage_manifests?on_conflict=opportunity_id`;
  const body = [{
    opportunity_id: oppId,
    manifest,
    summary: manifest.summary,
    unresolved_count: manifest.unresolved.length,
    needs_vision_count: manifest.summary.needs_vision_count,
    generated_at: manifest.generated_at,
  }];
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`upsert coverage_manifests: ${res.status} ${t}`);
  }
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/coverage.js --opp=<id> [--dry-run]');
    process.exit(1);
  }

  console.log(`Loading plan_intelligence digest for ${args.opp}…`);
  const digest = await loadDigest(args.opp);
  if (!digest) {
    console.error(`No plan_intelligence row for opp ${args.opp}.`);
    console.error('Run scripts/plan-intelligence.js --opp=' + args.opp + ' first.');
    process.exit(1);
  }

  console.log('Building coverage manifest…');
  const manifest = buildManifest(digest);

  // Local copy for inspection
  const oppDir = path.join(OUT_DIR, args.opp);
  fs.mkdirSync(oppDir, { recursive: true });
  fs.writeFileSync(path.join(oppDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${path.join(oppDir, 'manifest.json')}`);

  // Print summary
  const s = manifest.summary;
  console.log('\n=== Coverage Manifest ===');
  console.log(`Spec sections:   ${s.spec_sections.included} included, ${s.spec_sections.excluded} excluded, ${s.spec_sections.n_a} n/a, ${s.spec_sections.needs_human_judgment} needs review`);
  console.log(`Plan sheets:     ${s.plan_sheets.included} included, ${s.plan_sheets.excluded} excluded, ${s.plan_sheets.n_a} n/a, ${s.plan_sheets.needs_human_judgment} needs review`);
  console.log(`Schedules:       ${s.schedules.included} included, ${s.schedules.excluded} excluded, ${s.schedules.n_a} n/a, ${s.schedules.needs_human_judgment} needs review`);
  console.log(`Sheets needing vision: ${s.needs_vision_count}`);
  console.log(`Unresolved (needs human judgment): ${s.unresolved_count}`);
  console.log(`Expected takeoff categories: ${manifest.expected_categories.join(', ') || '(none)'}`);

  if (manifest.unresolved.length > 0) {
    console.log('\nUnresolved items (decide before takeoff):');
    for (const u of manifest.unresolved.slice(0, 20)) {
      console.log(`  [${u.kind}] ${u.ref} — ${u.reason.slice(0, 100)}`);
    }
    if (manifest.unresolved.length > 20) {
      console.log(`  …and ${manifest.unresolved.length - 20} more (see manifest.json).`);
    }
  }

  const visionSheets = manifest.plan_sheets.filter((s) => s.needs_vision);
  if (visionSheets.length > 0) {
    console.log('\nSheets the takeoff agent MUST open with vision:');
    for (const v of visionSheets.slice(0, 30)) {
      console.log(`  ${v.sheet_no || `p${v.page_number}`} (${v.source_filename}) — ${v.vision_reason || v.reason.slice(0, 80)}`);
    }
    if (visionSheets.length > 30) {
      console.log(`  …and ${visionSheets.length - 30} more.`);
    }
  }

  if (args.dryRun) {
    console.log('\n[dry-run] skipping DB upsert');
    return;
  }
  await upsertManifest(args.opp, manifest);
  console.log('\nDB upsert OK');
  console.log('\nNext: node scripts/takeoff-prepare.js --opp=' + args.opp);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
