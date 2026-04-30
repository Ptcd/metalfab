#!/usr/bin/env node
/**
 * vision-titleblocks-commit.js — read the result.json from the
 * vision title-block pass and merge sheet_no / sheet_title back
 * into plan_intelligence.digest. Anything below confidence 0.7
 * is discarded.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'vision-titleblocks-queue');

function headers(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null };
  for (const a of args) { const m = a.match(/^--opp=(.+)$/); if (m) out.opp = m[1]; }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.opp) { console.error('usage: --opp=<id>'); process.exit(1); }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  const resPath = path.join(oppDir, 'result.json');
  if (!fs.existsSync(resPath)) { console.error('result.json not found'); process.exit(1); }
  const result = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  const tbs = (result.title_blocks || []).filter((t) => (t.confidence ?? 0.85) >= 0.7);
  if (tbs.length === 0) { console.log('No high-confidence title blocks to merge'); return; }

  const piRes = await fetch(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`, { headers: headers() });
  const [pi] = await piRes.json();
  if (!pi) { console.error('no plan_intelligence'); process.exit(1); }

  let filled = 0;
  const digest = pi.digest;
  for (const tb of tbs) {
    const doc = (digest.documents || []).find((d) => d.filename === tb.filename);
    if (!doc) continue;
    const sheet = (doc.sheets || []).find((s) => s.page_number === tb.page_number);
    if (!sheet) continue;
    if (!sheet.sheet_no && tb.sheet_no) { sheet.sheet_no = tb.sheet_no; filled++; }
    if (!sheet.sheet_title && tb.sheet_title) sheet.sheet_title = tb.sheet_title;
  }

  // Recompute sheets_covered
  const covered = new Set();
  for (const d of digest.documents || []) {
    for (const s of d.sheets || []) if (s.sheet_no) covered.add(s.sheet_no);
  }
  const summary = pi.summary;
  summary.sheets_covered = [...covered].sort();

  const upd = await fetch(`${SUPABASE_URL}/rest/v1/plan_intelligence?id=eq.${pi.id}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ digest, summary }),
  });
  if (!upd.ok) { console.error('update failed:', await upd.text()); process.exit(1); }

  console.log(`Merged ${filled} title blocks into plan_intelligence ${pi.id}`);
  console.log(`Sheets covered now: ${summary.sheets_covered.length}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
