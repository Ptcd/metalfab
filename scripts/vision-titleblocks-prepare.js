#!/usr/bin/env node
/**
 * vision-titleblocks-prepare.js — stage a focused vision pass for
 * pages where title-block text extraction failed (vector-rendered
 * sheet identifiers).
 *
 * Bumps the sheet-ID hit rate from ~54% → ~95% on typical CD sets.
 * Capped at --max=30 pages per run to keep token budget bounded.
 *
 * Usage:
 *   node scripts/vision-titleblocks-prepare.js --opp=<id> [--max=30]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'vision-titleblocks-queue');

function headers() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null, max: 30 };
  for (const a of args) {
    let m = a.match(/^--opp=(.+)$/); if (m) out.opp = m[1];
    m = a.match(/^--max=(\d+)$/); if (m) out.max = parseInt(m[1], 10);
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  if (!args.opp) { console.error('usage: --opp=<id>'); process.exit(1); }

  const [pi] = await getJson(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`);
  if (!pi) { console.error('no plan_intelligence'); process.exit(1); }
  const docs = pi.digest?.documents || [];

  const candidates = [];
  for (const d of docs) {
    if (d.classification?.kind !== 'drawing') continue;
    for (const s of d.sheets || []) {
      if (!s.sheet_no && s.has_text_layer) {
        candidates.push({ filename: d.filename, page_number: s.page_number });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('No title-block-fallback candidates — text extraction got every drawing page.');
    process.exit(0);
  }

  const pages = candidates.slice(0, args.max);
  const oppDir = path.join(QUEUE_DIR, args.opp);
  if (fs.existsSync(oppDir)) fs.rmSync(oppDir, { recursive: true, force: true });
  fs.mkdirSync(oppDir, { recursive: true });

  const filesNeeded = new Set(pages.map((p) => p.filename));
  for (const filename of filesNeeded) {
    process.stdout.write(`  fetch ${filename} … `);
    try {
      await downloadStorageFile(`${args.opp}/${filename}`, path.join(oppDir, filename));
      const sz = fs.statSync(path.join(oppDir, filename)).size;
      console.log(`${(sz/1024).toFixed(0)} KB`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  const context = {
    opportunity_id: args.opp,
    pages_to_process: pages,
    instructions_file: '../scripts/vision-titleblocks.md',
  };
  fs.writeFileSync(path.join(oppDir, 'context.json'), JSON.stringify(context, null, 2));

  console.log(`\nReady. Pages to process: ${pages.length}`);
  console.log(`Next: claude -p "$(cat scripts/vision-titleblocks.md)" --max-turns 60 --dangerously-skip-permissions`);
  console.log(`Then: node scripts/vision-titleblocks-commit.js --opp=${args.opp}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
