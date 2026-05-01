#!/usr/bin/env node
/**
 * scripts/takeoff-run.js — autonomous takeoff agent loop.
 *
 * Replaces the manual workflow:
 *   takeoff-prepare → [user runs claude by hand] → takeoff-commit
 *
 * with:
 *   takeoff-prepare → takeoff-run (loops with feedback) → commits
 *
 * Each iteration:
 *   1. Spawn `claude -p ...` with takeoff.md prompt (or revision prompt
 *      on iterations 2+) targeting the queue dir.
 *   2. Read the resulting takeoff.json.
 *   3. Run takeoff-commit.js --dry-run --findings-out=…/validator-findings.json.
 *   4. If 0 errors and ≤2 warnings: commit for real, done.
 *   5. Otherwise: write a feedback file the agent will consume next pass,
 *      and re-prompt.
 *   6. Bounded by --max-iterations (default 3).
 *
 * Usage:
 *   node scripts/takeoff-run.js --opp=<id>
 *   node scripts/takeoff-run.js --opp=<id> --max-iterations=5
 *   node scripts/takeoff-run.js --opp=<id> --no-commit   # always dry-run final
 *
 * Requires: `claude` CLI on PATH, OAuth-authenticated (one-time
 * `claude login`). Same pattern as scripts/qa-loop.sh.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const QUEUE_DIR = path.join(__dirname, '..', 'takeoff-queue');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null, maxIter: 3, noCommit: false };
  for (const a of args) {
    if (a === '--no-commit') { out.noCommit = true; continue; }
    let m = a.match(/^--opp=(.+)$/);              if (m) { out.opp = m[1]; continue; }
    m     = a.match(/^--max-iterations=(\d+)$/);  if (m) { out.maxIter = Number(m[1]); continue; }
  }
  return out;
}

function buildPromptForIteration(oppDir, iter, prevFindingsPath) {
  const queueDirRel = path.relative(process.cwd(), oppDir).replace(/\\/g, '/');

  if (iter === 1) {
    // First iteration — pure agent walkthrough per scripts/takeoff.md.
    return [
      `You are a steel takeoff estimator for TCB Metalworks. Read the file`,
      `scripts/takeoff.md and follow the workflow it describes. That file`,
      `is your primary instruction set; treat its rules as authoritative.`,
      ``,
      `The bid you are pricing is in: ./${queueDirRel}/`,
      `Files in that directory:`,
      `  - context.json — bid stage, TCB CSI sections, rate card, assembly`,
      `    priors, steel shape catalog. READ THIS FIRST.`,
      `  - One or more PDFs — drawings (largest file = bid set), SOW, scope plan`,
      `  - The xlsx bid form (if present) — your scope envelope`,
      `  - renders/ subdirectory — pre-rendered high-resolution PNGs of`,
      `    strategic pages. USE Read on these PNGs for visual review of`,
      `    bollard counts, schedule rows, fab details, dimension chains`,
      `    that text extraction misses. The renders/manifest.json explains`,
      `    which pages were rendered and why.`,
      `  - The plan-intelligence digest can be read from the database via`,
      `    the existing patterns in scripts/takeoff-prepare.js, or you can`,
      `    extract it from context.json if available there.`,
      ``,
      `Your output: write a complete takeoff.json into ./${queueDirRel}/`,
      `matching the schema described in scripts/takeoff.md. Then print`,
      `the literal string "TAKEOFF READY" so the runner knows you're done.`,
      ``,
      `Hard rules that the validator WILL enforce after you finish:`,
      `  - No quoted text inside source_evidence that isn't a verbatim substring of the package`,
      `  - No sheet references (Detail N/AXXX) for sheets not in the drawing index`,
      `  - Every TCB-relevant coded note in note_glossary must be either cited or excluded`,
      `  - Every bid-form row mapping to TCB scope must be priced or excluded`,
      `  - Structural lines must contain a member designation (W##x##, HSS##x##x##)`,
      `  - "Match existing" without documented existing-condition triggers an RFI requirement`,
      `  - Countable categories (bollard, embed, lintel, hollow_metal_frame) require visual`,
      `    verification language in source_evidence ("verified visually", "rendered p<N> shows N")`,
      ``,
      `If you write a takeoff that violates these, the validator will surface the issues`,
      `and you'll be asked to revise on the next iteration. Do it right the first time.`,
    ].join('\n');
  }

  // Iteration 2+ — revision prompt with validator feedback.
  return [
    `Your previous takeoff at ./${queueDirRel}/takeoff.json was validated and`,
    `produced findings that need to be addressed. The findings file is at`,
    `./${path.relative(process.cwd(), prevFindingsPath).replace(/\\/g, '/')}`,
    ``,
    `Read that file. Each finding has:`,
    `  - severity: error | warning | info`,
    `  - category: the validator that fired (e.g. ghost_sheet_reference,`,
    `    coded_note_undecided, structural_member_designation_missing, etc.)`,
    `  - finding: what's wrong`,
    `  - recommendation: how to fix it`,
    `  - related_takeoff_line: which line (or null for run-level)`,
    ``,
    `Revise ./${queueDirRel}/takeoff.json to address every error and as many`,
    `warnings as possible. For each finding:`,
    `  - error severity → MUST fix (the bid won't commit otherwise)`,
    `  - warning → fix if you can; if you can't, document why in the line's`,
    `    assumptions field or in exclusions/rfis_recommended`,
    `  - info → no action required unless related to your scope`,
    ``,
    `Common fixes:`,
    `  - coded_note_undecided → either add a takeoff line citing the code,`,
    `    OR add the code + reason to exclusions[]`,
    `  - bid_form_line_undecided → add an exclusion mentioning the CSI code`,
    `    or relevant keywords from the form description`,
    `  - structural_member_designation_missing → re-read the structural sheet,`,
    `    find the new-member callout (W10X68, HSS6x6x1/4, etc.); the existing`,
    `    member is often labeled "UNKNOWN SIZE" right next to the new one`,
    `  - ghost_sheet_reference → either fix the sheet number to one in the`,
    `    drawing index, or add an RFI for the missing sheet`,
    `  - fabricated_quote → make the quoted text verbatim from the package,`,
    `    or rephrase without quote marks`,
    `  - relevant_page_uncited → the validator listed pages with strong-signal`,
    `    content for the line's category — open and read those pages`,
    ``,
    `When done, print "TAKEOFF REVISED".`,
  ].join('\n');
}

function runClaude(prompt, log) {
  // Match the existing pattern from scripts/qa-loop.sh
  const args = ['--print', '--max-turns', '120', '--dangerously-skip-permissions', prompt];
  log(`▶ claude --print --max-turns 120 --dangerously-skip-permissions <prompt>`);
  const res = spawnSync('claude', args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  return res.status === 0;
}

function runValidate(opp, findingsOut, log) {
  log(`▶ takeoff-commit --opp=${opp} --dry-run --findings-out=${path.relative(process.cwd(), findingsOut)}`);
  const res = spawnSync('node', [
    path.join(__dirname, 'takeoff-commit.js'),
    `--opp=${opp}`, '--dry-run', `--findings-out=${findingsOut}`,
  ], { stdio: 'inherit' });
  return res.status === 0;
}

function commit(opp, log) {
  log(`▶ takeoff-commit --opp=${opp} (real commit)`);
  const res = spawnSync('node', [path.join(__dirname, 'takeoff-commit.js'), `--opp=${opp}`],
    { stdio: 'inherit' });
  return res.status === 0;
}

function summarizeFindings(findingsPath) {
  if (!fs.existsSync(findingsPath)) return { errors: 0, warnings: 0, infos: 0, total: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    return {
      errors: j.errors || 0,
      warnings: j.warnings || 0,
      infos: j.infos || 0,
      total: j.total_findings || (j.findings || []).length,
    };
  } catch (_) {
    return { errors: 0, warnings: 0, infos: 0, total: 0 };
  }
}

function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/takeoff-run.js --opp=<opportunity_id> [--max-iterations=N] [--no-commit]');
    process.exit(2);
  }
  const oppDir = path.join(QUEUE_DIR, args.opp);
  if (!fs.existsSync(path.join(oppDir, 'context.json'))) {
    console.error(`No context.json at ${oppDir}. Run takeoff-prepare first.`);
    process.exit(2);
  }
  const log = (msg) => console.log(msg);
  const findingsPath = path.join(oppDir, 'validator-findings.json');

  let cleanIteration = -1;
  for (let iter = 1; iter <= args.maxIter; iter++) {
    log(`\n========== Iteration ${iter}/${args.maxIter} ==========`);
    const prevFindings = iter > 1 ? findingsPath : null;
    const prompt = buildPromptForIteration(oppDir, iter, prevFindings);

    const ok = runClaude(prompt, log);
    if (!ok) {
      log(`Claude subprocess failed on iteration ${iter}. Aborting.`);
      process.exit(1);
    }

    if (!fs.existsSync(path.join(oppDir, 'takeoff.json'))) {
      log(`No takeoff.json produced by iteration ${iter}. Aborting.`);
      process.exit(1);
    }

    runValidate(args.opp, findingsPath, log);
    const summary = summarizeFindings(findingsPath);
    log(`Iteration ${iter} validation: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos} infos`);

    // Stop condition: 0 errors and ≤2 warnings (warnings often surface
    // legit RFI items that can't be auto-resolved).
    if (summary.errors === 0 && summary.warnings <= 2) {
      cleanIteration = iter;
      log(`Iteration ${iter} converged (0 errors, ≤2 warnings).`);
      break;
    }
  }

  if (cleanIteration === -1) {
    log(`\nDid NOT converge within ${args.maxIter} iterations.`);
    log(`Final findings at ${findingsPath}`);
    log(`Inspect manually before committing, or run --no-commit to keep iterating.`);
    process.exit(args.noCommit ? 0 : 1);
  }

  if (args.noCommit) {
    log(`\nConverged on iteration ${cleanIteration}. --no-commit specified, skipping DB write.`);
    return;
  }
  log(`\nConverged on iteration ${cleanIteration}. Committing.`);
  const ok = commit(args.opp, log);
  if (!ok) process.exit(1);
}

main();
