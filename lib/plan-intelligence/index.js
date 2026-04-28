/**
 * lib/plan-intelligence — deterministic preprocessing of bid PDFs that
 * runs *before* any Claude vision call. Output is a structured digest
 * the takeoff engine can consume.
 *
 * For each PDF:
 *   - Extract text-layer items with positions (or flag as raster)
 *   - Classify the document (drawing | spec | qa_log | geotech | …)
 *   - Pull sheet_no / sheet_title from any drawing's title block
 *   - Find every cross-reference (detail callouts, sheet refs, spec §)
 *
 * For the package as a whole:
 *   - Identify referenced-but-not-uploaded sheets ("you cited S101 but
 *     S101 isn't in the package")
 *   - Compute relevance: TCB-scope-bearing disciplines (S, A, M, P)
 *   - Flag raster-only files that need OCR
 */

const { extractText } = require('./extract-text');
const { classifyDocument, extractSheetIdentity } = require('./classify-document');
const { findReferences, findMissingSheets } = require('./find-references');

const TCB_SCOPE_DISCIPLINES = new Set(['structural', 'architectural', 'mechanical', 'plumbing']);

const SKIP_KINDS = new Set(['geotech', 'schedule', 'qa_log']);

async function processDocument({ filename, category, buffer }) {
  const pages = await extractText(buffer);
  const classification = classifyDocument({ filename, category, pages });

  // Sheet identity is meaningful only for drawings
  const sheets = [];
  if (classification.kind === 'drawing') {
    for (const p of pages) {
      const id = extractSheetIdentity(p);
      sheets.push({
        page_number:  p.page_number,
        width:        p.width,
        height:       p.height,
        sheet_no:     id.sheet_no,
        sheet_title:  id.sheet_title,
        item_count:   p.item_count,
        has_text_layer: p.has_text_layer,
      });
    }
  } else {
    for (const p of pages) {
      sheets.push({
        page_number:    p.page_number,
        width:          p.width,
        height:         p.height,
        item_count:     p.item_count,
        has_text_layer: p.has_text_layer,
      });
    }
  }

  const refs = findReferences(pages, { docKind: classification.kind });

  return {
    filename,
    upload_category: category || null,
    classification,
    page_count: pages.length,
    sheets,
    references: refs,
    relevance: relevanceFor(classification, refs),
  };
}

function relevanceFor(classification, refs) {
  if (SKIP_KINDS.has(classification.kind)) return 'skip';
  if (classification.kind === 'drawing') {
    const tcbDiscs = refs.sheet_disciplines.filter((d) => TCB_SCOPE_DISCIPLINES.has(d));
    if (tcbDiscs.length > 0) return 'high';
    return 'medium';
  }
  if (classification.kind === 'specification' || classification.kind === 'addendum') return 'high';
  if (classification.kind === 'site_markup' || classification.kind === 'raster_scan') return 'low';
  return 'medium';
}

/**
 * Process a whole package: array of {filename, category, buffer}.
 */
async function processPackage(documents) {
  const docs = [];
  for (const d of documents) {
    try {
      docs.push(await processDocument(d));
    } catch (err) {
      docs.push({
        filename: d.filename,
        upload_category: d.category || null,
        error: err.message,
        classification: { kind: 'error', confidence: 0, reasons: [`extraction failed: ${err.message}`] },
        relevance: 'unknown',
        page_count: 0,
        sheets: [],
        references: { detail_callouts: [], sheet_refs: [], spec_sections: [], sheet_disciplines: [] },
      });
    }
  }

  // Aggregate references across all docs, then find missing sheets
  const referencedSheets = new Set();
  const coveredSheetNos = new Set();
  for (const d of docs) {
    for (const s of d.references?.sheet_refs || []) referencedSheets.add(s);
    for (const s of d.sheets || []) {
      if (s.sheet_no) coveredSheetNos.add(s.sheet_no);
    }
  }

  const missingSheets = findMissingSheets([...referencedSheets], [...coveredSheetNos]);
  const tcbMissingSheets = missingSheets.filter((s) => {
    const m = s.match(/^([A-Z]{1,2})/);
    if (!m) return false;
    const disc = ({A:'architectural',S:'structural',M:'mechanical',P:'plumbing'})[m[1]];
    return TCB_SCOPE_DISCIPLINES.has(disc);
  });

  // Cross-package summary
  const summary = {
    total_documents:  docs.length,
    drawings:         docs.filter((d) => d.classification.kind === 'drawing').length,
    specs:            docs.filter((d) => d.classification.kind === 'specification').length,
    qa_logs:          docs.filter((d) => d.classification.kind === 'qa_log').length,
    raster_only:      docs.filter((d) => d.classification.kind === 'raster_scan').length,
    skipped:          docs.filter((d) => d.relevance === 'skip').map((d) => d.filename),
    high_relevance:   docs.filter((d) => d.relevance === 'high').map((d) => d.filename),
    sheets_covered:   [...coveredSheetNos].sort(),
    sheets_referenced: [...referencedSheets].sort(),
    sheets_missing:   missingSheets,
    tcb_critical_missing: tcbMissingSheets,
    requires_ocr:     docs.filter((d) => d.classification.is_raster).map((d) => d.filename),
    ready_for_takeoff: tcbMissingSheets.length === 0
      && docs.some((d) => d.classification.kind === 'drawing' && d.relevance === 'high'),
  };

  return { documents: docs, summary, generated_at: new Date().toISOString() };
}

module.exports = { processDocument, processPackage };
