#!/usr/bin/env node
/**
 * scripts/inspect-pdf.mjs — single PDF inspection CLI.
 *
 * Replaces four one-off scripts (nestle-railing-scan, nestle-page-dump,
 * nestle-measure, nestle-spec-search) with one tool driven by flags.
 *
 * Usage:
 *   node scripts/inspect-pdf.mjs --opp=<id> --action=<action> [...flags]
 *
 * Actions:
 *   scan       Find pages matching one or more --pattern regex
 *   dump       Dump positioned text on specific --pages
 *   measure    Run measureCallout near --x,--y on --page (--symbol optional)
 *   search     Free-text regex search across all pages with context
 *
 * Flags:
 *   --pdf=<path>          Path to specific PDF; defaults to first .pdf
 *                         in the opp's takeoff-queue dir
 *   --opp=<id>            Opportunity id (resolves to takeoff-queue/<id>/)
 *   --pages=1,3,5         Pages for dump action
 *   --pattern=<regex>     Pattern for scan / search (repeatable)
 *   --page=<n>            Single page for measure
 *   --x=<n> --y=<n>       Callout coords for measure
 *   --symbol=<s>          Symbol for callout count (e.g. "E60")
 *   --radius=<px>         Measurement radius (default 250)
 *   --json                Emit JSON instead of human text
 *
 * Examples:
 *   # find all pages with railing or bollard content
 *   node scripts/inspect-pdf.mjs --opp=98d... --action=scan \
 *        --pattern="BOLLARD" --pattern="PIPE\\s*RAIL"
 *
 *   # dump positioned text from pages 27 and 28
 *   node scripts/inspect-pdf.mjs --opp=98d... --action=dump --pages=27,28
 *
 *   # measure dimensions near A4.13 callout on page 37
 *   node scripts/inspect-pdf.mjs --opp=98d... --action=measure \
 *        --page=37 --x=917 --y=632 --symbol=A4.13 --radius=300
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as pdfjs from 'pdfjs-dist';
const require = createRequire(import.meta.url);
const { measureCallout } = require('../lib/takeoff/measure-callout.js');

const _itemCache = new Map();
const args = parseArgs(process.argv.slice(2));

if (!args.action) {
  console.error('Usage: node scripts/inspect-pdf.mjs --action=<scan|dump|measure|search> [flags]\nSee file header for full usage.');
  process.exit(2);
}

const pdfPath = resolvePdfPath(args);
const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

if (!args.json) console.error(`pdf: ${pdfPath}\npages: ${doc.numPages}`);

switch (args.action) {
  case 'scan':    await runScan(doc, args); break;
  case 'dump':    await runDump(doc, args); break;
  case 'measure': await runMeasure(doc, args); break;
  case 'search':  await runSearch(doc, args); break;
  default:
    console.error(`Unknown action: ${args.action}`);
    process.exit(2);
}

/* ------------- actions ------------- */

async function runScan(doc, args) {
  const patterns = (args.pattern || []).map((p) => new RegExp(p, 'i'));
  if (!patterns.length) { console.error('--pattern required for scan'); process.exit(2); }
  const hits = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const txt = await pageText(doc, p);
    const matched = patterns.filter((re) => re.test(txt)).map((re) => re.source);
    if (matched.length) hits.push({ page: p, patterns: matched });
  }
  if (args.json) console.log(JSON.stringify(hits, null, 2));
  else for (const h of hits) console.log(`p${h.page}: ${h.patterns.join(', ')}`);
}

async function runDump(doc, args) {
  const pages = (args.pages || '').split(',').filter(Boolean).map(Number);
  if (!pages.length) { console.error('--pages required for dump'); process.exit(2); }
  for (const p of pages) {
    const items = await pageItems(doc, p);
    if (args.json) {
      console.log(JSON.stringify({ page: p, items }, null, 2));
    } else {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      console.log(`\n=== p${p} (${vp.width.toFixed(0)} x ${vp.height.toFixed(0)}) ===`);
      for (const it of items) console.log(`(${it.x.toFixed(0)},${it.y.toFixed(0)}) ${it.str}`);
    }
  }
}

async function runMeasure(doc, args) {
  const p = Number(args.page);
  const x = Number(args.x);
  const y = Number(args.y);
  const radius = Number(args.radius || 250);
  if (!Number.isFinite(p) || !Number.isFinite(x) || !Number.isFinite(y)) {
    console.error('--page, --x, --y required for measure');
    process.exit(2);
  }
  const items = await pageItems(doc, p);
  const result = measureCallout({ pageItems: items, x, y, symbol: args.symbol, radius });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nMeasurement near (${x},${y})${args.symbol ? ' for ' + args.symbol : ''} on p${p}, radius ${radius}px:`);
    console.log(`  rationale: ${result.rationale || 'no measurement found'}`);
    if (result.measured_lf !== null) console.log(`  measured_lf: ${result.measured_lf.toFixed(2)}`);
    if (result.callout_symbol_count !== null) console.log(`  symbol_count: ${result.callout_symbol_count}`);
    if (result.dimension_chain) console.log(`  chain: ${result.dimension_chain.values.join(' | ')} = ${result.dimension_chain.total_lf.toFixed(2)} LF along ${result.dimension_chain.axis}=${result.dimension_chain.key}`);
    console.log(`  ${result.dimensions_within_radius.length} dimensions within radius:`);
    for (const d of result.dimensions_within_radius) console.log(`    ${d.dist_px}px "${d.str}"${d.inches !== null ? ' = ' + d.inches.toFixed(1) + '"' : ''}`);
  }
}

async function runSearch(doc, args) {
  const patterns = (args.pattern || []).map((p) => new RegExp(p, 'i'));
  if (!patterns.length) { console.error('--pattern required for search'); process.exit(2); }
  const hits = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const txt = await pageText(doc, p);
    for (const re of patterns) {
      const m = txt.match(re);
      if (!m) continue;
      const idx = txt.search(re);
      const ctx = txt.slice(Math.max(0, idx - 100), idx + 200).replace(/\s+/g, ' ').trim();
      hits.push({ page: p, pattern: re.source, match: m[0], context: ctx });
    }
  }
  if (args.json) console.log(JSON.stringify(hits, null, 2));
  else for (const h of hits) console.log(`p${h.page} [${h.pattern}] "${h.match}"\n  ${h.context}\n`);
}

/* ------------- helpers ------------- */

async function pageItems(doc, p) {
  if (_itemCache.has(p)) return _itemCache.get(p);
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const items = tc.items.map((it) => ({
    str: it.str || '',
    x: it.transform[4],
    y: it.transform[5],
  }));
  _itemCache.set(p, items);
  return items;
}

async function pageText(doc, p) {
  const items = await pageItems(doc, p);
  return items.map((i) => i.str).join(' ');
}

function resolvePdfPath(args) {
  if (args.pdf) return args.pdf;
  if (args.opp) {
    const dir = `takeoff-queue/${args.opp}`;
    const pdfs = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
    if (!pdfs.length) throw new Error(`No PDFs in ${dir}`);
    // Prefer the largest PDF (drawing sets are big; SOWs/scope-areas are 1-2 pages)
    const sized = pdfs.map((f) => ({ f, sz: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.sz - a.sz);
    return path.join(dir, sized[0].f);
  }
  throw new Error('Either --pdf or --opp required');
}

function parseArgs(argv) {
  const out = { pattern: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] === undefined ? true : m[2];
    if (key === 'pattern') out.pattern.push(val);
    else out[key] = val;
  }
  return out;
}
