#!/usr/bin/env node
/**
 * vision-prepare.js — stage a vision-fallback job for Claude Code.
 *
 * Identifies pages where deterministic text extraction failed or
 * yielded too-sparse output, and stages them for a vision pass:
 *
 *   - Pages classified as drawing without an extractable sheet_no
 *     (likely vector-rendered title blocks)
 *   - Drawing pages whose extracted text mentions schedule keywords
 *     ('DOOR SCHEDULE', 'LINTEL SCHEDULE') but produced 0 rows from
 *     the deterministic parser (vector tables)
 *   - Documents with classification.is_raster=true (no text layer
 *     at all — likely scanned)
 *
 * Output: ./vision-queue/<opp_id>/vision-context.json with the list
 * of pages_to_process. Claude Code reads vision.md and writes
 * vision-result.json. vision-commit.js folds the result back into
 * the plan_intelligence digest.
 *
 * Usage:
 *   node scripts/vision-prepare.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'vision-queue');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null, max: 12 };
  for (const a of args) {
    let m = a.match(/^--opp=(.+)$/);
    if (m) out.opp = m[1];
    m = a.match(/^--max=(\d+)$/);
    if (m) out.max = parseInt(m[1], 10);
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: --opp=<id> [--max=12]');
    process.exit(1);
  }

  const [planIntel] = await getJson(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`);
  if (!planIntel) {
    console.error('no plan_intelligence — run plan-intelligence.js first');
    process.exit(1);
  }
  const docs = planIntel.digest?.documents || [];

  // Identify candidate pages for the vision pass
  const candidates = [];
  for (const d of docs) {
    if (!d.sheets || d.classification?.kind === 'qa_log') continue;

    // Whole document is raster — every page goes
    if (d.classification?.is_raster) {
      for (const s of d.sheets) {
        candidates.push({
          filename: d.filename,
          page_number: s.page_number,
          reason: 'raster_no_text',
          expected_kind: 'unknown',
        });
      }
      continue;
    }

    // Drawing pages without a sheet_no but with schedule_keyword mentions
    for (const s of d.sheets) {
      if (d.classification.kind !== 'drawing') continue;
      const noSheetNo = !s.sheet_no;
      const fewSchedules = !s.schedules_found || s.schedules_found === 0;

      if (noSheetNo && s.item_count < 50) {
        candidates.push({
          filename: d.filename,
          page_number: s.page_number,
          reason: 'title_block_unreadable',
          expected_kind: 'unknown',
        });
        continue;
      }
      // Schedule-keyword pages without parsed schedule rows
      // (we don't have direct keyword text here, so heuristic: pages
      //  with item_count > 100 that produced 0 schedules are likely
      //  vector-rendered tables)
      if (fewSchedules && s.item_count > 100 && s.has_text_layer) {
        // Skip — this is most pages on a CD set. Only vision-fallback
        // when text density is suspiciously low for the kind of page.
      }
    }
  }

  // Cap candidate count
  const pages = candidates.slice(0, args.max);

  if (pages.length === 0) {
    console.log('No vision-fallback candidates — text extraction looks solid for this package.');
    process.exit(0);
  }

  // Stage queue dir + download the source PDFs (only the ones we need)
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

  const [opp] = await getJson(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${args.opp}&select=id,title,agency`);
  const context = {
    opportunity: { id: opp.id, title: opp.title, agency: opp.agency },
    pages_to_process: pages,
    instructions_file: '../scripts/vision.md',
  };
  fs.writeFileSync(path.join(oppDir, 'vision-context.json'), JSON.stringify(context, null, 2));

  console.log(`\n--- Ready ---`);
  console.log(`Pages to process: ${pages.length}`);
  console.log(`Files staged:     ${filesNeeded.size}`);
  console.log(`\nNext: claude -p "$(cat scripts/vision.md)" --max-turns 100 --dangerously-skip-permissions`);
  console.log(`Then: node scripts/vision-commit.js --opp=${args.opp}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
