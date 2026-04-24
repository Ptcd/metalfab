/**
 * qa-extract-pages.js — given a kept_pages list from a qa_report, build a
 * filtered "estimator package" PDF containing only the pages that matter
 * to TCB.
 *
 * Exported as a function so qa-commit.js can call it for each opp.
 * Standalone CLI usage is also supported for debugging:
 *   node scripts/qa-extract-pages.js ./qa-queue/<opp_id>
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

/**
 * Build a filtered PDF in `oppDir` named `estimator-package.pdf` from the
 * `kept_pages` entries in qaReport. Returns the filename, or null if
 * there was nothing to extract.
 */
async function buildEstimatorPackage(oppDir, qaReport) {
  const keptPages = Array.isArray(qaReport?.kept_pages) ? qaReport.kept_pages : [];
  if (keptPages.length === 0) return null;

  // Group kept pages by source PDF. Non-PDF sources are skipped.
  const bySource = new Map();
  for (const kp of keptPages) {
    const src = kp.source_filename;
    if (!src || !/\.pdf$/i.test(src)) continue;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(kp);
  }
  if (bySource.size === 0) return null;

  const merged = await PDFDocument.create();
  // Page-number → source filename metadata on the merged doc
  const keptPagesEmbedded = [];

  for (const [filename, pages] of bySource) {
    const sourcePath = path.join(oppDir, filename);
    if (!fs.existsSync(sourcePath)) {
      console.log(`   skip (missing): ${filename}`);
      continue;
    }
    let sourcePdf;
    try {
      const buf = fs.readFileSync(sourcePath);
      sourcePdf = await PDFDocument.load(buf, { ignoreEncryption: true });
    } catch (e) {
      console.log(`   skip (load error): ${filename} — ${e.message.slice(0, 80)}`);
      continue;
    }

    const totalPages = sourcePdf.getPageCount();
    // Convert 1-indexed page numbers to 0-indexed, filter out-of-range
    const indices = pages
      .map((p) => Number(p.source_page))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= totalPages)
      .map((n) => n - 1);
    // Dedup + sort
    const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (unique.length === 0) continue;

    const copied = await merged.copyPages(sourcePdf, unique);
    for (let i = 0; i < copied.length; i++) {
      merged.addPage(copied[i]);
      const srcPage = unique[i] + 1;
      const kp = pages.find((p) => Number(p.source_page) === srcPage);
      keptPagesEmbedded.push({
        source_filename: filename,
        source_page: srcPage,
        sheet_number: kp?.sheet_number || null,
        reason: kp?.reason || null,
      });
    }
  }

  if (merged.getPageCount() === 0) return null;

  // Embed metadata so opening the PDF shows what's in it
  merged.setTitle('TCB estimator package');
  merged.setSubject('Filtered pages — Division 05/10 + structural drawings only');
  merged.setProducer('TCB Bid Pipeline — qa-extract-pages.js');
  merged.setCreator('Claude Code QA analyzer');
  merged.setCreationDate(new Date());

  const outName = 'estimator-package.pdf';
  const outPath = path.join(oppDir, outName);
  const bytes = await merged.save();
  fs.writeFileSync(outPath, bytes);

  return {
    filename: outName,
    path: outPath,
    page_count: merged.getPageCount(),
    kept_pages_embedded: keptPagesEmbedded,
  };
}

module.exports = { buildEstimatorPackage };

// CLI shim for debugging
if (require.main === module) {
  const oppDir = process.argv[2];
  if (!oppDir) {
    console.error('usage: node qa-extract-pages.js <opp-dir>');
    process.exit(1);
  }
  const reportPath = path.join(oppDir, 'qa-report.json');
  if (!fs.existsSync(reportPath)) {
    console.error('no qa-report.json in ' + oppDir);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  buildEstimatorPackage(oppDir, report).then((result) => {
    if (!result) {
      console.log('nothing to extract');
    } else {
      console.log(`built ${result.filename}: ${result.page_count} pages`);
    }
  });
}
