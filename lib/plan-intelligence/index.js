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
 *   - Detect bid stage (pre_gmp_rfp | final_cd | unknown). Drives whether
 *     a referenced-but-not-uploaded sheet is a blocker or expected gap.
 *   - Pull TCB-relevant CSI sections (Div 05 / 08 / 10) from the spec
 *     — these are the actual scope items the pricer can work from.
 *   - Compute readiness for takeoff or for an assumption-based estimate
 */

const { extractText } = require('./extract-text');
const { classifyDocument, extractSheetIdentity } = require('./classify-document');
const { findReferences, findMissingSheets } = require('./find-references');
const { detectBidStage } = require('./detect-stage');
const { parseSchedules, summarizeDoorSchedule } = require('./parse-schedule');
const { findTonnageAssertions } = require('../takeoff/tonnage-sanity');

const TCB_SCOPE_DISCIPLINES = new Set(['structural', 'architectural', 'mechanical', 'plumbing']);
const SKIP_KINDS = new Set(['geotech', 'schedule', 'qa_log']);

// CSI Division 05 (Metals), 08 (Openings), 10 (Specialties) sections that
// commonly appear as TCB scope. Used to pull the actual scope of work
// out of the spec narrative when drawings are draft / not yet issued.
const TCB_SECTION_LABELS = {
  '05 12 00': 'Structural Steel Framing',
  '05 21 00': 'Steel Joist Framing',
  '05 30 00': 'Metal Decking',
  '05 31 00': 'Steel Decking',
  '05 40 00': 'Cold-Formed Metal Framing',
  '05 50 00': 'Metal Fabrications',
  '05 51 13': 'Metal Pan Stairs',
  '05 51 33': 'Metal Ladders',
  '05 52 00': 'Metal Railings',
  '05 53 00': 'Metal Gratings',
  '05 54 00': 'Metal Floor Plates',
  '05 56 00': 'Metal Castings',
  '05 73 00': 'Decorative Metal Railings',
  '05 75 00': 'Decorative Formed Metal',
  '08 11 13': 'Hollow Metal Doors',
  '08 12 11': 'Hollow Metal Frames',
  '08 12 13': 'Hollow Metal Frames',
  '08 36 13': 'Sectional (Overhead) Doors',
  '10 14 23': 'Panel Signage',
  '10 44 00': 'Fire Protection Specialties',
};

function flatTextForDoc(pages, limit = 60000) {
  let total = 0;
  const out = [];
  for (const p of pages) {
    for (const it of p.items) {
      out.push(it.str);
      total += it.str.length + 1;
      if (total > limit) return out.join(' ');
    }
  }
  return out.join(' ');
}

async function processDocument({ filename, category, buffer }) {
  const pages = await extractText(buffer);
  const classification = classifyDocument({ filename, category, pages });
  // Keep raw pages around for full-document scans (TCB section extraction
  // on long specs hits page 48+ and needs the whole document, not the
  // 60k-char preview). Stripped before persistence.
  const _pages = pages;

  const sheets = [];
  const schedules = [];
  if (classification.kind === 'drawing') {
    for (const p of pages) {
      const id = extractSheetIdentity(p);
      const pageSchedules = parseSchedules(p);
      sheets.push({
        page_number:    p.page_number,
        width:          p.width,
        height:         p.height,
        sheet_no:       id.sheet_no,
        sheet_title:    id.sheet_title,
        item_count:     p.item_count,
        has_text_layer: p.has_text_layer,
        schedules_found: pageSchedules.length,
      });
      for (const sch of pageSchedules) {
        schedules.push(sch);
      }
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
    schedules,
    references: refs,
    relevance: relevanceFor(classification, refs),
    // Internal — used by detectBidStage and TCB-section extraction; stripped
    // before persistence to keep the digest small.
    _fullText: flatTextForDoc(pages),
    _pages,
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
 * Pull TCB-relevant CSI sections from spec docs. A section is "present"
 * when its number appears in a section-header context (e.g. "SECTION
 * 05 50 00 METAL FABRICATIONS"), not just as a cross-reference.
 */
function extractTcbSections(specDocs) {
  const found = new Map();
  for (const d of specDocs) {
    const pages = d._pages || [];
    // Pre-build regex pairs once per spec to avoid recompiling per page.
    const targets = Object.entries(TCB_SECTION_LABELS).map(([secNum, label]) => ({
      secNum,
      label,
      re: new RegExp(
        `(?:section|document)\\s+${secNum}\\b|\\b${secNum}\\s*-\\s*1\\b`,
        'i'
      ),
    }));
    for (const p of pages) {
      const text = p.items.map((i) => i.str).join(' ');
      for (const t of targets) {
        if (found.has(t.secNum)) continue;
        if (t.re.test(text)) {
          found.set(t.secNum, {
            section: t.secNum,
            label: t.label,
            source_filename: d.filename,
            first_page: p.page_number,
          });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.section.localeCompare(b.section));
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
        _fullText: '',
        _pages: [],
      });
    }
  }

  // Stage detection drives how we treat referenced-but-not-uploaded sheets.
  const stage = detectBidStage(docs);

  // Aggregate references and find missing sheets
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
    const disc = ({ A: 'architectural', S: 'structural', M: 'mechanical', P: 'plumbing' })[m[1]];
    return TCB_SCOPE_DISCIPLINES.has(disc);
  });

  // TCB scope from the spec narrative (Div 05 / 08 / 10 sections)
  const specDocs = docs.filter((d) => d.classification.kind === 'specification');
  const tcbSections = extractTcbSections(specDocs);

  // Schedules pulled from drawings: door / lintel / embed / etc.
  // For door schedules specifically, summarize the TCB-scope HM frame
  // count vs ETR / aluminum / FRP / handwash exclusions.
  const allSchedules = [];
  for (const d of docs) {
    for (const s of d.schedules || []) {
      allSchedules.push({ ...s, source_filename: d.filename });
    }
  }
  // Pass ALL door schedule pages (CD sets often spread the schedule
  // across multiple sheets) — the summarizer dedupes rows.
  const doorSchedules = allSchedules.filter((s) => s.kind === 'door_schedule');
  const doorScheduleSummary = summarizeDoorSchedule(doorSchedules, {
    excludeRoomNumbers: [],   // Caller can pass handwash-station room numbers etc.
  });

  // Tonnage assertions across spec narrative + drawing general notes.
  // The takeoff-commit script will compare its bid total against these
  // and flag a finding if outside ±20%.
  const tonnageAssertions = findTonnageAssertions(
    docs
      .filter((d) => d.classification.kind === 'specification' || d.classification.kind === 'drawing')
      .map((d) => ({ filename: d.filename, pages: d._pages || [] }))
  );

  // Readiness: at RFP stage, we don't need every cited sheet — we need
  // either real drawings OR a spec rich enough to estimate from.
  const hasUsableDrawing = docs.some((d) => d.classification.kind === 'drawing' && d.relevance === 'high');
  const hasTcbSpec = tcbSections.some((s) => s.section.startsWith('05')); // Div 05 metals presence

  const readiness =
    stage.stage === 'pre_gmp_rfp'
      ? (hasTcbSpec ? 'estimate_from_spec' : 'spec_missing_div05')
      : tcbMissingSheets.length === 0 && hasUsableDrawing
        ? 'ready_for_takeoff'
        : 'awaiting_drawings';

  // Strip per-doc internal scratch fields before persistence — _pages
  // and _fullText carry the full PDF text and are too large.
  const persistedDocs = docs.map(({ _fullText, _pages, ...rest }) => rest);

  const summary = {
    total_documents:  docs.length,
    drawings:         docs.filter((d) => d.classification.kind === 'drawing').length,
    specs:            docs.filter((d) => d.classification.kind === 'specification').length,
    qa_logs:          docs.filter((d) => d.classification.kind === 'qa_log').length,
    raster_only:      docs.filter((d) => d.classification.kind === 'raster_scan').length,
    skipped:          docs.filter((d) => d.relevance === 'skip').map((d) => d.filename),
    high_relevance:   docs.filter((d) => d.relevance === 'high').map((d) => d.filename),
    bid_stage:        stage.stage,
    bid_stage_confidence: stage.confidence,
    bid_stage_reasons:    stage.reasons,
    readiness,
    sheets_covered:   [...coveredSheetNos].sort(),
    sheets_referenced: [...referencedSheets].sort(),
    sheets_missing:   missingSheets,
    sheets_expected_at_cd: stage.stage === 'pre_gmp_rfp' ? missingSheets : [],
    tcb_critical_missing: stage.stage === 'pre_gmp_rfp' ? [] : tcbMissingSheets,
    tcb_sections:     tcbSections,
    schedules:        allSchedules.map((s) => ({
      kind:            s.kind,
      page_number:     s.page_number,
      source_filename: s.source_filename,
      row_count:       s.row_count,
      headers:         s.headers,
    })),
    door_schedule_summary: doorScheduleSummary,
    tonnage_assertions: tonnageAssertions,
    requires_ocr:     docs.filter((d) => d.classification.is_raster).map((d) => d.filename),
  };

  return { documents: persistedDocs, summary, generated_at: new Date().toISOString() };
}

module.exports = { processDocument, processPackage };
