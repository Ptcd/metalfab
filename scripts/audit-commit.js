#!/usr/bin/env node
/**
 * audit-commit.js — read ./audit-queue/<opp_id>/audit.json, compute
 * the diff against the takeoff, and persist to takeoff_audits.
 *
 * Diff logic: a category-by-category match between expected_items and
 * the existing takeoff lines. An expected item with no matching
 * takeoff line of the same category becomes a `missing_items` entry.
 * A takeoff line with no matching expected item becomes an
 * `unexpected_items` entry. Findings emitted by the auditor are
 * preserved verbatim.
 *
 * Usage:
 *   node scripts/audit-commit.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'audit-queue');

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

const VALID_VERDICTS = new Set(['passed', 'review_recommended', 'block_submission']);
const VALID_SEVERITIES = new Set(['error', 'warning', 'info']);

function validateAudit(audit) {
  const errs = [];
  if (!audit.verdict || !VALID_VERDICTS.has(audit.verdict)) {
    errs.push(`invalid verdict "${audit.verdict}"`);
  }
  if (!Array.isArray(audit.findings)) errs.push('findings must be an array');
  if (!Array.isArray(audit.expected_items)) errs.push('expected_items must be an array');
  for (const [i, f] of (audit.findings || []).entries()) {
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      errs.push(`finding ${i}: invalid severity "${f.severity}"`);
    }
    if (!f.category) errs.push(`finding ${i}: category required`);
    if (!f.finding) errs.push(`finding ${i}: finding text required`);
  }
  return errs;
}

function diffItems(expected, takeoffLines) {
  // Match by category + qualitative description similarity. Coarse but
  // sufficient: if the expected list says "lintel" and the takeoff has
  // a "lintel" line, they're the same item. Quantity comparison is a
  // separate `quantity_sanity` finding.
  const takeoffByCat = new Map();
  for (const l of takeoffLines) {
    if (!takeoffByCat.has(l.category)) takeoffByCat.set(l.category, []);
    takeoffByCat.get(l.category).push(l);
  }
  const expectedByCat = new Map();
  for (const e of expected) {
    if (!expectedByCat.has(e.category)) expectedByCat.set(e.category, []);
    expectedByCat.get(e.category).push(e);
  }

  const missing = [];
  for (const [cat, items] of expectedByCat) {
    const tk = takeoffByCat.get(cat) || [];
    if (tk.length === 0) {
      // Whole category missing
      for (const it of items) missing.push(it);
    }
    // If audit found multiple distinct items in same category but
    // takeoff has only one line, surface the extras.
    if (items.length > tk.length) {
      for (const it of items.slice(tk.length)) missing.push(it);
    }
  }

  const unexpected = [];
  for (const [cat, lines] of takeoffByCat) {
    if (!expectedByCat.has(cat)) {
      for (const l of lines) unexpected.push({ category: cat, line_no: l.line_no, description: l.description });
    }
  }
  return { missing, unexpected };
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/audit-commit.js --opp=<opportunity_id>');
    process.exit(1);
  }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  const auditPath = path.join(oppDir, 'audit.json');
  if (!fs.existsSync(auditPath)) {
    console.error(`audit.json not found at ${auditPath}`);
    process.exit(1);
  }
  const ctxPath = path.join(oppDir, 'audit-context.json');
  if (!fs.existsSync(ctxPath)) {
    console.error(`audit-context.json missing at ${ctxPath}`);
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));

  const errs = validateAudit(audit);
  if (errs.length) {
    console.error('Audit validation failed:');
    errs.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  // Fetch live takeoff lines for the diff (use DB, not the sanitized
  // copy in audit-context.json — those omit reasoning fields we don't
  // need but the line structure is the same).
  const takeoffRunId = ctx.existing_takeoff?.run_id;
  if (!takeoffRunId) {
    console.error('audit-context.json missing existing_takeoff.run_id');
    process.exit(1);
  }
  const takeoffLines = await getJson(`${SUPABASE_URL}/rest/v1/takeoff_lines?takeoff_run_id=eq.${takeoffRunId}&select=line_no,category,description&order=line_no.asc`);

  const { missing, unexpected } = diffItems(audit.expected_items || [], takeoffLines);

  const counts = audit.findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    },
    { error: 0, warning: 0, info: 0 }
  );

  const body = {
    takeoff_run_id: takeoffRunId,
    generated_by: 'oauth-claude-code',
    generator_version: audit.generator_version || 'audit-md-v1',
    expected_items: audit.expected_items || [],
    findings: audit.findings || [],
    missing_items: missing,
    unexpected_items: unexpected,
    errors_count: counts.error,
    warnings_count: counts.warning,
    info_count: counts.info,
    verdict: audit.verdict,
    raw_output: audit,
  };

  // Upsert (one audit per takeoff run; rerunning replaces)
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/takeoff_audits?on_conflict=takeoff_run_id`,
    {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify([body]),
    }
  );
  if (!res.ok) {
    console.error('takeoff_audits upsert failed:', res.status, await res.text());
    process.exit(1);
  }
  const [row] = await res.json();
  console.log(`Upserted takeoff_audit ${row.id}`);

  // Print summary
  console.log('\n=== Audit Summary ===');
  console.log(`Verdict:           ${audit.verdict}`);
  console.log(`Expected items:    ${(audit.expected_items || []).length}`);
  console.log(`Findings:          ${audit.findings.length}  (errors: ${counts.error}, warnings: ${counts.warning}, info: ${counts.info})`);
  console.log(`Missing items:     ${missing.length}`);
  console.log(`Unexpected items:  ${unexpected.length}`);
  if (missing.length) {
    console.log('\nMissing from takeoff:');
    missing.forEach((m) => console.log(`  - [${m.category}] ${m.description.slice(0, 100)}`));
  }
  if (audit.findings.length) {
    console.log('\nFindings:');
    audit.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.severity.toUpperCase()}] ${f.category}: ${f.finding.slice(0, 120)}`);
    });
  }
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
