#!/usr/bin/env node
/**
 * arbitrate-prepare.js — stage an arbitration job for Claude Code.
 *
 * Reads the latest takeoff_run + its takeoff_audit and identifies
 * disputed items: audit findings whose `severity = 'error'` or
 * `category = 'missing_scope'` AND that reference a takeoff line.
 * Each becomes a `disputed_item` for the arbitrator agent to read
 * the source documents fresh and pick a verdict.
 *
 * Crucially: the prior agents' assumptions / reasoning are withheld
 * — only their conclusions reach the arbitrator. This keeps the
 * third pass independent.
 *
 * Usage:
 *   node scripts/arbitrate-prepare.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'arbitrate-queue');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
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

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/arbitrate-prepare.js --opp=<id>');
    process.exit(1);
  }

  const [opp] = await getJson(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${args.opp}&select=id,title,agency,response_deadline,documents`);
  if (!opp) { console.error('opp not found'); process.exit(1); }
  const [run] = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_runs?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`);
  if (!run) { console.error('no takeoff_run'); process.exit(1); }
  const [audit] = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_audits?takeoff_run_id=eq.${run.id}&select=*&limit=1`);
  if (!audit) { console.error('no audit yet — run audit first'); process.exit(1); }
  const lines = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_lines?takeoff_run_id=eq.${run.id}&select=line_no,category,description,quantity,quantity_unit,source_section,source_page&order=line_no.asc`);
  const [planIntel] = await getJson(`${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=*&order=generated_at.desc&limit=1`);

  // Build disputed_items from the audit's findings — only the ones
  // worth a third pass (errors + missing_scope warnings).
  const disputedItems = [];
  let dispute_id = 1;
  const findings = Array.isArray(audit.findings) ? audit.findings : [];
  for (const f of findings) {
    const isHighStakes = f.severity === 'error' || f.category === 'missing_scope' || f.category === 'quantity_sanity';
    if (!isHighStakes) continue;
    const linkedLine = lines.find((l) => l.line_no === f.related_takeoff_line);
    disputedItems.push({
      dispute_id: `D${dispute_id++}`,
      category: linkedLine?.category || f.category,
      takeoff_position: linkedLine ? {
        quantity:        linkedLine.quantity,
        quantity_unit:   linkedLine.quantity_unit,
        source_section:  linkedLine.source_section,
        source_page:     linkedLine.source_page,
      } : null,
      audit_position: {
        category:        f.category,
        severity:        f.severity,
        finding:         f.finding,
        source_kind:     f.source_kind,
        source_section:  f.source_section,
        source_page:     f.source_page,
      },
      dispute_reason: f.severity === 'error'
        ? 'Audit identified an error severity issue with this line item; arbitrator must verify against source.'
        : 'Audit suggests scope or quantity differs from takeoff; arbitrator must reconcile.',
    });
  }

  if (disputedItems.length === 0) {
    console.log('No disputed items — takeoff and audit agree. Skipping arbitration.');
    process.exit(0);
  }

  // Stage queue dir
  const oppDir = path.join(QUEUE_DIR, args.opp);
  if (fs.existsSync(oppDir)) fs.rmSync(oppDir, { recursive: true, force: true });
  fs.mkdirSync(oppDir, { recursive: true });

  // Download relevant PDFs (specs + drawings + Q&A)
  const docs = (planIntel?.digest?.documents || []).filter((d) => {
    const k = d?.classification?.kind;
    return k === 'specification' || k === 'drawing' || k === 'qa_log' || k === 'addendum';
  });
  const stagedFiles = [];
  for (const d of docs) {
    process.stdout.write(`  fetch ${d.filename} … `);
    try {
      await downloadStorageFile(`${args.opp}/${d.filename}`, path.join(oppDir, d.filename));
      const sz = fs.statSync(path.join(oppDir, d.filename)).size;
      console.log(`${(sz/1024).toFixed(0)} KB`);
      stagedFiles.push({ filename: d.filename, kind: d.classification.kind });
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  const context = {
    opportunity: {
      id: opp.id,
      title: opp.title,
      agency: opp.agency,
      response_deadline: opp.response_deadline,
    },
    disputed_items: disputedItems,
    package_documents: stagedFiles,
    tcb_sections: planIntel?.summary?.tcb_sections || [],
    instructions_file: '../scripts/arbitrate.md',
  };

  fs.writeFileSync(path.join(oppDir, 'arbitrate-context.json'), JSON.stringify(context, null, 2));
  console.log(`\n--- Ready ---`);
  console.log(`Disputed items: ${disputedItems.length}`);
  console.log(`Files staged:   ${stagedFiles.length}`);
  console.log(`\nNext: claude -p "$(cat scripts/arbitrate.md)" --max-turns 100 --dangerously-skip-permissions`);
  console.log(`Then: node scripts/arbitrate-commit.js --opp=${args.opp}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
