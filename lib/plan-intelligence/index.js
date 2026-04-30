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
const { parseSchedules, summarizeDoorSchedule, summarizeEquipmentSchedule, countDoorScheduleGates } = require('./parse-schedule');
const { buildNoteGlossary, resolveNoteCodesInText } = require('./parse-notes');
const { parseSOW } = require('./parse-sow');
const { extractRevision, pickLatestRevisions } = require('./detect-revision');
const { findTonnageAssertions } = require('../takeoff/tonnage-sanity');
const { reconcileDoorSchedule } = require('./reconcile-sources');
const { parseXlsxBidForm, parsePdfBidForm, allowedCategoriesFromCsi } = require('./parse-bid-form');

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
      const text = require('./page-text').flatText(p);
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
  // SOW exclusions: parse the SOW for explicit room-number exclusions
  // BEFORE the door schedule summary, so we can pass them through.
  const sowDoc = docs.find((d) => /statement[\s_-]?of[\s_-]?work|\bSOW\b/i.test(d.filename));
  const sowParsed = sowDoc ? parseSOW(sowDoc._pages || []) : null;
  const excludeRoomsFromSow = [...(sowParsed?.excluded_room_numbers || [])];

  // SOW says things like "Handwash Stations 1 & 2 priced separately"
  // — map those category-level exclusions to specific door rooms by
  // searching the door-schedule text for matching station names.
  const exclusionTexts = (sowParsed?.scope_notes || [])
    .filter((n) => n.type === 'exclusion')
    .map((n) => n.text.toLowerCase());
  const stationKeywords = exclusionTexts.flatMap((t) => {
    const out = [];
    if (/handwash\s+station/i.test(t)) out.push(/handwash\s+station/i);
    if (/station\s+1\b/i.test(t) || /station\s+#?1\b/i.test(t)) out.push(/handwash\s+station\s+(?:no\.?\s*)?#?1\b/i);
    if (/station\s+2\b/i.test(t)) out.push(/handwash\s+station\s+(?:no\.?\s*)?#?2\b/i);
    return out;
  });
  if (stationKeywords.length > 0) {
    // Walk parsed door-schedule rows; any row whose text matches a
    // station keyword has its room number extracted into the exclusion set.
    for (const sch of allSchedules) {
      if (sch.kind !== 'door_schedule') continue;
      for (const r of sch.rows || []) {
        const rowText = Object.values(r).join(' ');
        if (stationKeywords.some((re) => re.test(rowText))) {
          for (const m of rowText.matchAll(/\b(\d{3}[A-Za-z]?)\b/g)) {
            if (!excludeRoomsFromSow.includes(m[1])) excludeRoomsFromSow.push(m[1]);
          }
        }
      }
    }
  }

  // Pass ALL door schedule pages — summarizer dedupes rows + applies
  // SOW-driven exclusions by exact room number.
  const doorSchedules = allSchedules.filter((s) => s.kind === 'door_schedule');
  const doorScheduleSummary = summarizeDoorSchedule(doorSchedules, {
    excludeRoomNumbers: excludeRoomsFromSow,
  });
  const doorGateCount = countDoorScheduleGates(doorSchedules);

  // Equipment schedule (E60 BOLLARD, RTU-1, etc.) — TCB-relevant items
  const equipmentScheduleSummary = summarizeEquipmentSchedule(allSchedules);

  // Note-code glossary — resolves coded callouts like A1.08, A4.13
  const noteGlossary = (() => {
    const g = new Map();
    for (const d of docs) {
      if (d.classification?.kind !== 'drawing') continue;
      const sub = buildNoteGlossary(d._pages || []);
      for (const [k, v] of sub) if (!g.has(k)) g.set(k, v);
    }
    return [...g.entries()].map(([k, v]) => ({ code: k, ...v }));
  })();

  // Drawing revision precedence — keep latest, surface conflicts
  const allDrawingSheets = [];
  for (const d of docs) {
    if (d.classification?.kind !== 'drawing') continue;
    for (const s of d.sheets || []) {
      if (!s.sheet_no) continue;
      const titleBlockText = (d._pages?.[s.page_number - 1]?.items || [])
        .filter((it) => it.y >= (s.height || 1728) * 0.65 && it.x >= (s.width || 2592) * 0.55)
        .map((it) => it.str).join(' ');
      allDrawingSheets.push({ ...s, source_filename: d.filename, revision: extractRevision(titleBlockText) });
    }
  }
  const revisionResult = pickLatestRevisions(allDrawingSheets);

  // Cross-source reconciliation: door schedule rows vs door-number
  // occurrences on floor-plan pages. Disagreements surface as RFIs.
  const drawingDocs = docs.filter((d) => d.classification.kind === 'drawing');
  const reconciliation = (() => {
    if (doorSchedules.length === 0) return null;
    // Pick the densest schedule (most rows = the actual master schedule)
    const primary = doorSchedules.reduce((best, s) => (s.row_count > best.row_count ? s : best), doorSchedules[0]);
    return reconcileDoorSchedule(primary, drawingDocs);
  })();

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

  // Drawing-index extraction — find the cover-sheet schedule of every
  // sheet in the project. Used downstream by the validator to flag any
  // takeoff line that cites a sheet not in the index (ghost references
  // like "Detail 3/A060" when A060 isn't in the set).
  const { parseDrawingIndex } = require('./parse-drawing-index');
  let drawingIndex = { sheets: [], pageWithIndex: null };
  for (const d of docs) {
    if (d.classification.kind !== 'drawing') continue;
    const found = parseDrawingIndex(d._pages || []);
    if (found.sheets.length > drawingIndex.sheets.length) {
      drawingIndex = { ...found, source_filename: d.filename };
    }
  }

  // Category→pages map — for every TCB-relevant takeoff category,
  // which pages mention it strongly enough to be considered relevant.
  // The validator uses this to require each takeoff line cite at least
  // one of its category's pages (defeating the "scanned but didn't
  // read" failure mode where a fab detail page was identified but
  // never opened by the agent).
  const { buildCategoryPagesForDoc, mergeCategoryPages } = require('./category-pages');
  const categoryPagesPerDoc = docs
    .filter((d) => d.classification.kind === 'drawing')
    .map((d) => buildCategoryPagesForDoc(d._pages || []));
  const categoryPages = mergeCategoryPages(categoryPagesPerDoc);

  // CSI-section reference inventory — for every section reference like
  // "PER SPEC SECTION 05 52 13" or "REFER TO 05 50 00" found in any page,
  // record (sectionNumber, page, source_filename). Downstream validator
  // cross-checks each referenced section against tcb_sections (sections
  // actually present in the package). References to absent sections =
  // either the spec was deleted or the architect's pointer is wrong =
  // auto-RFI.
  const csiReferenceSet = new Set();
  const csiReferenceList = [];
  const CSI_REF_RE = /\b(?:SECTION|SPEC(?:IFICATION)?|PER|REFER\s+TO)\s+(\d{2})\s*(\d{2})\s*(\d{2})\b/gi;
  const flatTextHelper = require('./page-text').flatText;
  for (const d of docs) {
    if (d.classification.kind !== 'drawing') continue;
    for (const p of (d._pages || [])) {
      const text = flatTextHelper(p);
      let m;
      CSI_REF_RE.lastIndex = 0;
      while ((m = CSI_REF_RE.exec(text)) !== null) {
        const code = `${m[1]} ${m[2]} ${m[3]}`;
        const key = `${code}|${p.page_number}`;
        if (csiReferenceSet.has(key)) continue;
        csiReferenceSet.add(key);
        csiReferenceList.push({ section: code, page: p.page_number, source_filename: d.filename });
      }
    }
  }
  const presentSections = new Set((tcbSections || []).map((s) => s.section));
  const csiReferencesAbsent = [...new Set(csiReferenceList.map((r) => r.section))]
    .filter((sec) => !presentSections.has(sec));

  // Per-sheet detail-block count — used by the multi_detail_sheet_undercited
  // validator. A "detail block" is a numbered detail bubble on a sheet,
  // identified by a "Detail N" or "Section X" or "Typical Y" callout near
  // a SCALE: notation. Counted PER SHEET (not per page) — sheet identity
  // comes from the title block parsed earlier.
  const sheetDetailCounts = {};
  const DETAIL_BLOCK_RE = /\bDETAIL\s+(\d{1,2})\b|\bTYPICAL\s+[A-Z][A-Z]+\b|\bSECTION\s+[A-Z]\s*-\s*[A-Z]\b/gi;
  for (const d of docs) {
    if (d.classification.kind !== 'drawing') continue;
    // Build page_number → sheet_no map from the persisted sheets list
    // (sheet_no is parsed during classification, not on raw _pages).
    const sheetNoByPage = new Map();
    for (const s of (d.sheets || [])) {
      if (s.sheet_no) sheetNoByPage.set(s.page_number, s.sheet_no);
    }
    for (const p of (d._pages || [])) {
      const sheetNo = sheetNoByPage.get(p.page_number);
      if (!sheetNo) continue;
      const text = flatTextHelper(p);
      const matches = new Set();
      let m;
      DETAIL_BLOCK_RE.lastIndex = 0;
      while ((m = DETAIL_BLOCK_RE.exec(text)) !== null) {
        matches.add(m[0].toUpperCase());
      }
      if (matches.size > 0) {
        const key = sheetNo.toUpperCase();
        sheetDetailCounts[key] = (sheetDetailCounts[key] || 0) + matches.size;
      }
    }
  }

  const summary = {
    total_documents:  docs.length,
    drawing_index:    drawingIndex,
    category_pages:   categoryPages,
    sheet_detail_counts: sheetDetailCounts,
    csi_references:   csiReferenceList,
    csi_references_absent_from_package: csiReferencesAbsent,
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
    door_gate_count: doorGateCount,
    equipment_schedule_summary: equipmentScheduleSummary,
    note_glossary: noteGlossary,
    sow_parsed: sowParsed,
    revision_findings: revisionResult.findings,
    cross_source_reconciliation: reconciliation,
    tonnage_assertions: tonnageAssertions,
    requires_ocr:     docs.filter((d) => d.classification.is_raster).map((d) => d.filename),
  };

  return { documents: persistedDocs, summary, generated_at: new Date().toISOString() };
}

module.exports = { processDocument, processPackage };
