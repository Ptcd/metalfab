#!/usr/bin/env node
/**
 * run-pipeline.js - Runs the full daily bid scraping pipeline
 *
 * Steps:
 *   1. Fetch from all sources (parallel where possible)
 *   2. Rescore all opportunities
 *   3. Auto-triage (filter junk, tag metalfab/salvage)
 *
 * Usage: node scripts/run-pipeline.js [--skip-headless] [--only=source1,source2]
 *
 * Sources: samgov, bidnet, demandstar, racine-county, milwaukee, mke-county, kenosha, vendornet, questcdn, wi-munis, bonfire
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname);

// All fetcher scripts in order
const FETCHERS = {
  'samgov':        { script: 'fetch-now.js',           headless: false, timeout: 300000 },
  'bidnet':        { script: 'fetch-bidnet.js',         headless: true,  timeout: 180000 },
  'demandstar':    { script: 'fetch-demandstar.js',     headless: true,  timeout: 180000 },
  'racine-county': { script: 'fetch-racine-county.js',  headless: false, timeout: 30000 },
  'milwaukee':     { script: 'fetch-milwaukee.js',      headless: false, timeout: 30000 },
  'mke-county':    { script: 'fetch-mke-county.js',     headless: false, timeout: 30000 },
  'kenosha':       { script: 'fetch-kenosha.js',        headless: false, timeout: 30000 },
  'vendornet':     { script: 'fetch-vendornet.js',     headless: true,  timeout: 120000 },
  'questcdn':      { script: 'fetch-questcdn.js',     headless: false, timeout: 30000 },
  'wi-munis':      { script: 'fetch-wi-municipalities.js', headless: false, timeout: 60000 },
  'bonfire':       { script: 'fetch-bonfire.js',          headless: true,  timeout: 120000 },
};

const POST_SCRIPTS = [
  { script: 'rescore.js',     timeout: 60000,  label: 'Rescore' },
  { script: 'auto-triage.js', timeout: 60000,  label: 'Auto-Triage' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const skipHeadless = args.includes('--skip-headless');
  let only = null;
  const onlyArg = args.find(a => a.startsWith('--only='));
  if (onlyArg) {
    only = onlyArg.split('=')[1].split(',').map(s => s.trim());
  }
  return { skipHeadless, only };
}

function runScript(scriptPath, timeout, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`▶ ${label} — ${path.basename(scriptPath)}`);
    console.log('='.repeat(60));

    try {
      const output = execSync(`node "${scriptPath}"`, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        cwd: path.join(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      // Show last 10 lines of output
      const lines = output.trim().split('\n');
      const tail = lines.slice(-10).join('\n');
      console.log(tail);
      console.log(`✅ ${label} completed in ${elapsed}s`);
      resolve({ label, success: true, elapsed, output });
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const stderr = err.stderr ? err.stderr.slice(-500) : '';
      const stdout = err.stdout ? err.stdout.slice(-500) : '';
      console.error(`❌ ${label} FAILED after ${elapsed}s`);
      if (stderr) console.error(`  stderr: ${stderr.slice(0, 200)}`);
      if (stdout) console.log(`  stdout: ${stdout.slice(0, 200)}`);
      resolve({ label, success: false, elapsed, error: err.message.slice(0, 200) });
    }
  });
}

async function main() {
  const { skipHeadless, only } = parseArgs();
  const startTime = Date.now();

  console.log('🚀 TCB Metalworks — Daily Bid Pipeline');
  console.log(`   ${new Date().toLocaleString()}`);
  console.log(`   Skip headless: ${skipHeadless}`);
  if (only) console.log(`   Only: ${only.join(', ')}`);

  const results = [];

  // Run fetchers
  for (const [name, config] of Object.entries(FETCHERS)) {
    // Skip if --only specified and this source isn't in the list
    if (only && !only.includes(name)) continue;

    // Skip headless scrapers if --skip-headless
    if (skipHeadless && config.headless) {
      console.log(`\n⏭️  Skipping ${name} (headless, --skip-headless flag)`);
      results.push({ label: name, success: null, elapsed: 0, skipped: true });
      continue;
    }

    const scriptPath = path.join(SCRIPTS_DIR, config.script);
    const result = await runScript(scriptPath, config.timeout, name);
    results.push(result);
  }

  // Run post-processing (rescore + triage)
  if (!only) {
    for (const post of POST_SCRIPTS) {
      const scriptPath = path.join(SCRIPTS_DIR, post.script);
      const result = await runScript(scriptPath, post.timeout, post.label);
      results.push(result);
    }
  }

  // Summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('📊 PIPELINE SUMMARY');
  console.log('='.repeat(60));

  for (const r of results) {
    const icon = r.skipped ? '⏭️' : r.success ? '✅' : '❌';
    const status = r.skipped ? 'skipped' : r.success ? `ok (${r.elapsed}s)` : `FAILED (${r.elapsed}s)`;
    console.log(`  ${icon} ${r.label.padEnd(20)} ${status}`);
  }

  const succeeded = results.filter(r => r.success === true).length;
  const failed = results.filter(r => r.success === false).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log(`\n  Total: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);
  console.log(`  Pipeline completed in ${totalElapsed}s`);

  if (failed > 0) {
    console.log('\n⚠️  Some fetchers failed — check logs above');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
