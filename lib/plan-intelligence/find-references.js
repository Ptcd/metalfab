/**
 * find-references.js — pull cross-references from any text-bearing PDF.
 *
 * Construction docs constantly cross-reference: "see detail 3/A400",
 * "reference lintel schedule on S101", "spec section 05 50 00". We
 * collect those refs so Plan Intelligence can flag when a referenced
 * sheet or spec section is *not* in the uploaded package — a real and
 * common cause of bad bids.
 */

// Detail callouts: 3/A400, 12/S501, B/P501. The slash plus a sheet-style
// suffix is unambiguous; ASTM citations don't have this shape.
const DETAIL_RE = /\b([A-Z0-9]{1,3})\s*\/\s*([A-Z]{1,3}-?\d{1,3}(?:\.\d{1,2})?)\b/g;

// Bare sheet refs need at least 3 digits to avoid ASTM standards
// (A36, A325, A992, A153, A500, A572, etc. are steel grades, bolt
// specs, and galvanizing standards — they look identical to short
// sheet numbers and wreck the missing-sheet detector). 3+ digits also
// matches the typical drawing-set numbering scheme (S101, A201, P501).
// Multi-letter prefixes (FP, FA) must precede single letters in the
// alternation so they win the longest-match.
const SHEET_RE = /\b(FP|FA|[ASMPECLTGID])-?(\d{3}(?:\.\d{1,2})?)\b/g;

// CSI spec sections: 05 50 00, 09 29 00
const SPEC_RE = /\b(\d{2})\s+(\d{2})\s+(\d{2})\b/g;

// Common ASTM standards that look like sheet refs even with 3 digits:
// A123/A123M (hot-dip galv), A153 (small-part galv), A500 (HSS),
// A572 (high-strength steel), A992 (wide-flange), etc. We drop these
// from the "bare sheet refs" output since none of them denote a
// drawing sheet.
const ASTM_DENYLIST = new Set([
  'A123', 'A153', 'A307', 'A325', 'A490', 'A500', 'A529', 'A563',
  'A572', 'A588', 'A615', 'A653', 'A706', 'A780', 'A847', 'A992',
  'A1011', 'A1085', 'C150', 'C270', 'C476', 'E84', 'E119', 'E330',
]);

// Known "ASTM A36/A36M" or "ASTM A992" prefixes — when we see ASTM
// or AISI right before a match, drop it.
const ASTM_PREFIX_RE = /\b(?:ASTM|AISI|AWS|AISC|ANSI)\s+$/;
// Question-and-answer pairs (Q1: ... A1: ...)
const QA_PAIR_RE = /(?:^|\n)(?:Q(?:uestion)?\s*\d+|^\d+)[:.\s)]+([\s\S]+?)(?=\n(?:A(?:nswer)?\s*\d+|^\d+)[:.\s)]+|$)/gim;

const SHEET_PREFIX_KIND = {
  G: 'general',
  A: 'architectural',
  S: 'structural',
  M: 'mechanical',
  P: 'plumbing',
  E: 'electrical',
  C: 'civil',
  L: 'landscape',
  T: 'telecom',
  I: 'interior',
  D: 'demolition',
  FP: 'fire_protection',
  FA: 'fire_alarm',
};

function flatText(pages) {
  return pages.map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
}

/**
 * Find references in a single document.
 *
 * @param {Object[]} pages — output of extractText
 * @param {Object}   [opts]
 * @param {string}   [opts.docKind] — classification kind. Spec documents
 *   suppress bare sheet-ref extraction (too full of ASTM citations to
 *   distinguish reliably). Detail callouts and CSI sections are kept.
 */
function findReferences(pages, opts = {}) {
  const isSpec = opts.docKind === 'specification';
  const text = flatText(pages);
  const refs = {
    detail_callouts: new Set(),
    sheet_refs:      new Set(),
    spec_sections:   new Set(),
  };

  // Detail callouts: highest signal in drawings — but in specs they
  // false-match welding codes (AWS D1.1), division labels (D9, D10),
  // and joint type symbols (WJ4). Skip callout extraction in specs.
  if (!isSpec) {
    for (const m of text.matchAll(DETAIL_RE)) {
      refs.detail_callouts.add(`${m[1]}/${m[2].replace('-', '')}`);
      refs.sheet_refs.add(m[2].replace('-', ''));
    }
  }

  // Bare sheet refs: filter ASTM / AWS / AISI noise. In spec documents
  // the false-positive rate is too high to recover with a denylist —
  // skip bare-ref extraction entirely and let Q&A logs and drawings
  // be the source of truth for sheet refs.
  if (isSpec) {
    return {
      detail_callouts: [...refs.detail_callouts].sort(),
      sheet_refs:      [...refs.sheet_refs].sort(),
      spec_sections:   [...new Set(
        [...text.matchAll(SPEC_RE)].map((m) => `${m[1]} ${m[2]} ${m[3]}`)
      )].sort(),
      sheet_disciplines: [...new Set([...refs.sheet_refs].map((r) => {
        const mp = r.match(/^([A-Z]{1,2})/);
        return mp ? SHEET_PREFIX_KIND[mp[1]] || 'other' : 'other';
      }))].sort(),
    };
  }

  for (const m of text.matchAll(SHEET_RE)) {
    const ref = `${m[1]}${m[2]}`;
    if (ASTM_DENYLIST.has(ref)) continue;
    // Drop if preceded by an ASTM-style prefix within ~12 chars
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (ASTM_PREFIX_RE.test(before)) continue;
    // Drop if followed by "/A###M" (the dual-units ASTM convention)
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    if (/^\s*\/\s*A\d{2,4}M\b/.test(after)) continue;
    // Drop A36 specifically — common steel grade, only 2 digits but
    // sometimes appears as "A036" in OCR output.
    if (/^A0?36$/.test(ref)) continue;
    refs.sheet_refs.add(ref);
  }

  for (const m of text.matchAll(SPEC_RE)) {
    refs.spec_sections.add(`${m[1]} ${m[2]} ${m[3]}`);
  }

  return {
    detail_callouts: [...refs.detail_callouts].sort(),
    sheet_refs:      [...refs.sheet_refs].sort(),
    spec_sections:   [...refs.spec_sections].sort(),
    sheet_disciplines: [...new Set([...refs.sheet_refs].map((r) => {
      const m = r.match(/^([A-Z]{1,2})/);
      return m ? SHEET_PREFIX_KIND[m[1]] || 'other' : 'other';
    }))].sort(),
  };
}

/**
 * Find sheets that are *referenced* by any document but aren't covered
 * by any uploaded drawing's sheet_no. The orchestrator builds the
 * `coveredSheetNos` set after all documents are classified.
 */
function findMissingSheets(referencedSheetNos, coveredSheetNos) {
  const covered = new Set(coveredSheetNos.map((s) => s.replace(/[\s-]/g, '').toUpperCase()));
  const missing = [];
  for (const ref of referencedSheetNos) {
    const norm = ref.replace(/[\s-]/g, '').toUpperCase();
    if (!covered.has(norm)) missing.push(ref);
  }
  return missing.sort();
}

module.exports = { findReferences, findMissingSheets };
