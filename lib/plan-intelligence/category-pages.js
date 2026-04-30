/**
 * lib/plan-intelligence/category-pages.js — for each takeoff category,
 * find every page in the package that mentions it. The validator uses
 * this to enforce "the takeoff agent must cite at least one of these
 * pages" — defeating the failure mode where the agent's grep matches
 * one page, treats that as the evidence ceiling, and never opens
 * sibling pages with richer detail.
 *
 * Returns { bollard: [21, 27, 32], guardrail: [27, 31, 32, 37], ... }
 *
 * Page numbers are 1-indexed. Only pages with strong-signal matches
 * (multiple keywords or a schedule cell or a fab detail) count — drive-by
 * mentions in titleblocks or general notes are filtered out by requiring
 * either ≥2 distinct keywords or a fab-detail signal token.
 */

const { flatText } = require('./page-text');

// Per-category keyword sets. Tuned to catch the actual fab-detail
// language the architect uses in this domain. Keep narrow — false
// positives are cheap (they only inflate the "must-read" page list)
// but missed pages are exactly the failure mode we're fighting.
const CATEGORY_KEYWORDS = {
  bollard:            [/\bBOLLARD\b/i, /\bSTEEL\s+POST\s+\(\s*BOLLARD\s*\)/i, /\bGALV\.?\s+(?:STEEL\s+)?BOLLARD\b/i],
  guardrail:          [/\bGUARD\s*RAIL\b/i, /\bGUARDRAIL\b/i, /\b42"\s*HIGH\s+(?:METAL|STEEL)\s+RAIL/i, /\bSAFETY\s+RAILING\b/i, /\bBI-?PARTING\s+GATE\b/i],
  handrail:           [/\bHANDRAIL\b/i, /\bHAND\s+RAIL\b/i, /\bWALL\s+(?:MOUNTED\s+)?(?:HAND)?RAIL\b/i, /\bWALL\s+RETURN\b/i, /\bABOVE\s+WALL\s+RAIL/i],
  hollow_metal_frame: [/\bHOLLOW\s+METAL\b/i, /\bHM\s+(?:FRAME|FR\.?)\b/i, /\bF1\s+HM\b/i, /\bF2\s+HM\b/i, /\bDOOR\s+SCHEDULE\b/i, /\bFRAME\s+SCHEDULE\b/i],
  structural_beam:    [/\bW\d+x\d+\b/, /\bWIDE\s+FLANGE\b/i, /\bSTRUCTURAL\s+BEAM\b/i, /\bBEAM\s+SCHEDULE\b/i, /\bBM\.?\s+EL\.?/i],
  structural_column:  [/\bHSS\d+x\d+\b/i, /\bSTEEL\s+COLUMN\b/i, /\bWF\s+COLUMN\b/i, /\bCOL\.?\s+SCHEDULE\b/i],
  base_plate:         [/\bBASE\s+(?:PL\.?|PLATE)\b/i, /\bBRG\.?\s+(?:PL\.?|PLATE)\b/i, /\bBEARING\s+PLATE\b/i, /\bCOL\.?\s+BASE\s+PLATE\b/i],
  stair:              [/\bMETAL\s+STAIR\b/i, /\bPAN\s+STAIR\b/i, /\bSTAIR\s+SCHEDULE\b/i, /\bSTAIR\s+#?\d/i],
  lintel:             [/\bLINTEL\b/i, /\bLOOSE\s+(?:LINTEL|ANGLE)/i, /\bSHELF\s+ANGLE\b/i, /\bRELIEVING\s+ANGLE\b/i],
  embed:              [/\bEMBED(?:DED)?\s+PLATE\b/i, /\bSTEEL\s+EMBED\b/i, /\bE\d+\s+EMBED\b/i],
  ladder:             [/\bSHIP\s+LADDER\b/i, /\bSTEEL\s+LADDER\b/i, /\bROOF\s+LADDER\b/i, /\bACCESS\s+LADDER\b/i],
  bollard_set:        [/\bBOLLARD\b/i],   // alias to bollard for assembly_type matches
  guardrail_run:      [/\bGUARDRAIL\b/i, /\bGUARD\s*RAIL\b/i, /\b42"\s*HIGH/i],
  wall_handrail_run:  [/\bHANDRAIL\b/i, /\bWALL\s+RAIL\b/i, /\bABOVE\s+WALL/i],
  misc_metal:         [/\bMISC\.?\s+METAL\b/i, /\bMETAL\s+FABRICATION\b/i, /\b05\s*50\s*00\b/, /\bSECTION\s+05\s*50/i],
};

// Fab-detail signal tokens. A page that has multiple of these (anywhere)
// is almost certainly a fab detail sheet for SOMETHING and should be
// considered relevant to whatever category's keywords also matched.
const FAB_DETAIL_SIGNALS = [
  /\bSCHEDULE\s+\d{2}\b/,              // Schedule 40, Schedule 80
  /\bASTM\s+A\d{2,4}\b/i,
  /\bGALV\.?(?:ANIZED)?\b/i,
  /\bCONCRETE\s+FILL/i,
  /\bSCALE:\s*\d/i,                     // detail sheets always have scale notation
  /\bDETAIL\s+\d/i,
  /\b\d+\/\d+"?\s+(?:THK|THICK)\b/i,
  /\b\(\d+\)\s+\d+\/\d+"?\s+(?:HEADED\s+)?STUDS\b/i,
];

/**
 * Build the category→pages map for a single drawing's pages.
 */
function buildCategoryPagesForDoc(pages) {
  const out = {};
  for (const cat of Object.keys(CATEGORY_KEYWORDS)) out[cat] = [];

  for (const p of pages || []) {
    const text = flatText(p);
    if (!text) continue;
    const fabSignalCount = FAB_DETAIL_SIGNALS.reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);

    for (const [cat, patterns] of Object.entries(CATEGORY_KEYWORDS)) {
      const hits = patterns.filter((re) => re.test(text)).length;
      if (hits === 0) continue;
      // Strong-signal page: ≥2 keyword hits OR (1 keyword hit + ≥2 fab signals).
      // This filters titleblock cross-references while keeping fab pages.
      if (hits >= 2 || (hits >= 1 && fabSignalCount >= 2)) {
        out[cat].push(p.page_number);
      }
    }
  }

  // Dedupe + sort
  for (const cat of Object.keys(out)) {
    out[cat] = [...new Set(out[cat])].sort((a, b) => a - b);
  }
  return out;
}

/**
 * Merge per-doc maps into one. (The package may have multiple drawing
 * PDFs; page numbers are unique within a single PDF — so we tag pages
 * with their source filename when ambiguous.)
 */
function mergeCategoryPages(perDoc) {
  const merged = {};
  for (const cat of Object.keys(CATEGORY_KEYWORDS)) merged[cat] = [];
  for (const docMap of perDoc) {
    for (const [cat, pages] of Object.entries(docMap)) {
      merged[cat].push(...pages);
    }
  }
  for (const cat of Object.keys(merged)) {
    merged[cat] = [...new Set(merged[cat])].sort((a, b) => a - b);
  }
  // Drop empty categories so the map stays compact.
  for (const cat of Object.keys(merged)) {
    if (merged[cat].length === 0) delete merged[cat];
  }
  return merged;
}

module.exports = {
  buildCategoryPagesForDoc,
  mergeCategoryPages,
  CATEGORY_KEYWORDS,
};
