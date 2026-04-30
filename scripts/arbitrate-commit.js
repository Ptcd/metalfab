#!/usr/bin/env node
/**
 * arbitrate-commit.js — read ./arbitrate-queue/<opp_id>/arbitration.json
 * and persist the arbitrator's verdicts to the takeoff_audit row.
 *
 * Verdicts get appended to the audit's `findings` array (with category
 * `arbitration` and the arbitrator's quoted evidence). For verdicts
 * marked `unresolvable`, an `info`-severity finding is added that the
 * RFI generator will pick up automatically.
 *
 * Usage:
 *   node scripts/arbitrate-commit.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'arbitrate-queue');

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

const VALID_VERDICTS = new Set(['takeoff_correct', 'audit_correct', 'compromise', 'unresolvable']);

async function main() {
  const args = parseArgs();
  if (!args.opp) { console.error('usage: --opp=<id>'); process.exit(1); }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  const arbPath = path.join(oppDir, 'arbitration.json');
  if (!fs.existsSync(arbPath)) {
    console.error(`arbitration.json not found at ${arbPath}`);
    process.exit(1);
  }
  const arb = JSON.parse(fs.readFileSync(arbPath, 'utf8'));
  const verdicts = Array.isArray(arb.verdicts) ? arb.verdicts : [];
  for (const [i, v] of verdicts.entries()) {
    if (!VALID_VERDICTS.has(v.verdict)) throw new Error(`verdict ${i} has invalid value "${v.verdict}"`);
  }

  const runRes = await fetch(
    `${SUPABASE_URL}/rest/v1/takeoff_runs?opportunity_id=eq.${args.opp}&select=id&order=generated_at.desc&limit=1`,
    { headers: headers() }
  );
  const [run] = await runRes.json();
  if (!run) { console.error('no takeoff_run'); process.exit(1); }
  const auditRes = await fetch(
    `${SUPABASE_URL}/rest/v1/takeoff_audits?takeoff_run_id=eq.${run.id}&select=*&limit=1`,
    { headers: headers() }
  );
  const [audit] = await auditRes.json();
  if (!audit) { console.error('no audit'); process.exit(1); }

  // Convert verdicts to findings and append to the audit
  const newFindings = verdicts.map((v) => ({
    severity: v.verdict === 'unresolvable' ? 'info' : 'info',
    category: 'arbitration',
    finding: `[${v.verdict}] ${v.rationale || v.evidence || 'arbitrator verdict'}`,
    recommendation: v.verdict === 'unresolvable' ? (v.rfi_recommended || 'RFI to GC required') : null,
    related_takeoff_line: null,
    source_kind: v.source_section ? 'drawing' : 'spec',
    source_section: v.source_section || null,
    source_page: v.source_page ?? null,
    source_evidence: v.evidence || null,
    arbitrator_verdict: v.verdict,
    arbitrator_resolved_value: v.resolved_value || null,
  }));

  const merged = [...(audit.findings || []), ...newFindings];

  const upd = await fetch(
    `${SUPABASE_URL}/rest/v1/takeoff_audits?id=eq.${audit.id}`,
    {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ findings: merged, info_count: (audit.info_count || 0) + newFindings.length }),
    }
  );
  if (!upd.ok) {
    console.error('audit update failed:', upd.status, await upd.text());
    process.exit(1);
  }

  console.log(`Appended ${newFindings.length} arbitration verdicts to audit ${audit.id}`);
  console.log();
  for (const v of verdicts) {
    console.log(`  [${v.verdict}] ${v.category}: ${(v.rationale || '').slice(0, 100)}`);
  }
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
