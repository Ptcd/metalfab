/**
 * find-references.js — pull cross-references from any text-bearing PDF.
 *
 * Construction docs constantly cross-reference: "see detail 3/A400",
 * "reference lintel schedule on S101", "spec section 05 50 00". We
 * collect those refs so Plan Intelligence can flag when a referenced
 * sheet or spec section is *not* in the uploaded package — a real and
 * common cause of bad bids.
 */

// Detail callouts: 3/A400, 12/S501, B/P501
const DETAIL_RE = /\b([A-Z0-9]{1,3})\s*\/\s*([A-Z]{1,3}-?\d{1,3}(?:\.\d{1,2})?)\b/g;
// Bare sheet refs: S101, A201, P501, M-101, E-050, C100
const SHEET_RE = /\b([ASMPECLT]|FP|FA)-?(\d{2,3}(?:\.\d{1,2})?)\b/g;
// CSI spec sections: 05 50 00, 09 29 00
const SPEC_RE = /\b(\d{2})\s+(\d{2})\s+(\d{2})\b/g;
// Question-and-answer pairs (Q1: ... A1: ...)
const QA_PAIR_RE = /(?:^|\n)(?:Q(?:uestion)?\s*\d+|^\d+)[:.\s)]+([\s\S]+?)(?=\n(?:A(?:nswer)?\s*\d+|^\d+)[:.\s)]+|$)/gim;

const SHEET_PREFIX_KIND = {
  A: 'architectural',
  S: 'structural',
  M: 'mechanical',
  P: 'plumbing',
  E: 'electrical',
  C: 'civil',
  L: 'landscape',
  T: 'telecom',
  FP: 'fire_protection',
  FA: 'fire_alarm',
};

function flatText(pages) {
  return pages.map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
}

function findReferences(pages) {
  const text = flatText(pages);
  const refs = {
    detail_callouts: new Set(),
    sheet_refs:      new Set(),
    spec_sections:   new Set(),
  };

  for (const m of text.matchAll(DETAIL_RE)) {
    refs.detail_callouts.add(`${m[1]}/${m[2].replace('-', '')}`);
    refs.sheet_refs.add(m[2].replace('-', ''));
  }
  for (const m of text.matchAll(SHEET_RE)) {
    refs.sheet_refs.add(`${m[1]}${m[2]}`);
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
