#!/usr/bin/env node
/**
 * vision-commit.js — read ./vision-queue/<opp_id>/vision-result.json
 * and merge the vision-extracted data back into plan_intelligence.
 *
 * For each vision-extracted page:
 *   - If it produced schedule rows, append them to the digest's
 *     `schedules` list with source_kind='vision'.
 *   - If it produced a sheet_no / sheet_title, fill in the
 *     corresponding sheet entry that text extraction left blank.
 *   - If it produced tonnage assertions, append them to
 *     summary.tonnage_assertions.
 *
 * The result is a richer digest that the takeoff engine can read on
 * its next pass.
 *
 * Usage:
 *   node scripts/vision-commit.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'vision-queue');

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
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

async function main() {
  const args = parseArgs();
  if (!args.opp) { console.error('usage: --opp=<id>'); process.exit(1); }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  const resPath = path.join(oppDir, 'vision-result.json');
  if (!fs.existsSync(resPath)) { console.error(`vision-result.json not found at ${resPath}`); process.exit(1); }

  const result = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  const visionPages = Array.isArray(result.pages) ? result.pages : [];
  if (visionPages.length === 0) { console.log('No pages to merge'); return; }

  // Load the latest plan_intelligence row
  const piRes = await fetch(
    `${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`,
    { headers: headers() }
  );
  const [pi] = await piRes.json();
  if (!pi) { console.error('no plan_intelligence row to update'); process.exit(1); }

  const digest = pi.digest || {};
  const summary = pi.summary || {};

  // Ensure containers
  digest.documents = digest.documents || [];
  summary.schedules = summary.schedules || [];
  summary.tonnage_assertions = summary.tonnage_assertions || [];

  let mergedCount = 0;
  let scheduleAdded = 0;
  let sheetIdsFilled = 0;

  for (const v of visionPages) {
    const doc = digest.documents.find((d) => d.filename === v.filename);
    if (!doc) continue;

    // Fill sheet_no / sheet_title if blank
    if (v.title_block && (v.title_block.sheet_no || v.title_block.sheet_title)) {
      const sheet = (doc.sheets || []).find((s) => s.page_number === v.page_number);
      if (sheet) {
        if (!sheet.sheet_no && v.title_block.sheet_no) {
          sheet.sheet_no = v.title_block.sheet_no;
          sheetIdsFilled++;
        }
        if (!sheet.sheet_title && v.title_block.sheet_title) {
          sheet.sheet_title = v.title_block.sheet_title;
        }
      }
    }

    // Append schedule rows if any
    if (v.extracted_kind && v.rows && v.rows.length > 0) {
      summary.schedules.push({
        kind:            v.extracted_kind,
        page_number:     v.page_number,
        source_filename: v.filename,
        row_count:       v.rows.length,
        rows:            v.rows,
        from_vision:     true,
        confidence:      v.confidence ?? 0.85,
      });
      scheduleAdded++;
    }

    // Append tonnage assertions if any
    if (Array.isArray(v.tonnage_assertions)) {
      for (const ta of v.tonnage_assertions) {
        summary.tonnage_assertions.push({
          ...ta,
          source_filename: v.filename,
          page_number:     v.page_number,
          from_vision:     true,
        });
      }
    }

    mergedCount++;
  }

  const upd = await fetch(
    `${SUPABASE_URL}/rest/v1/plan_intelligence?id=eq.${pi.id}`,
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        digest,
        summary,
      }),
    }
  );
  if (!upd.ok) {
    console.error('plan_intelligence update failed:', upd.status, await upd.text());
    process.exit(1);
  }

  console.log(`Merged ${mergedCount} vision pages into plan_intelligence ${pi.id}`);
  console.log(`  schedules added:      ${scheduleAdded}`);
  console.log(`  sheet_no fills:       ${sheetIdsFilled}`);
  console.log(`Next: re-run takeoff-prepare so the takeoff agent picks up the richer digest.`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
