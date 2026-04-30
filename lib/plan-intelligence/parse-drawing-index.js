/**
 * lib/plan-intelligence/parse-drawing-index.js — extract the drawing
 * index ("sheet schedule") from a CD set's cover sheet.
 *
 * Why: keynotes routinely point at sheets (e.g. "REFER TO DETAIL 3/A060").
 * If A060 isn't in the project, that's a real gap — the architect either
 * deleted the sheet or never produced it. The takeoff agent should not
 * pretend it can resolve those references; it should auto-RFI.
 *
 * The index parser scans pages for sheet-number→sheet-name pairs in the
 * common cover-sheet layout:
 *
 *   A000   PARTITION TYPES & DETAILS
 *   A001   PARTITION TYPES & DETAILS
 *   A010   DOOR SCHEDULE, ELEVATIONS & DETAILS
 *
 * Returns { sheets: [{number, name, page}], pageWithIndex }.
 *
 * Sheet numbers follow the standard discipline-letter prefix:
 *   G/A/S/M/E/P/C/L/T/I/D/FP/FA followed by 1-4 digits (with optional
 *   alpha-suffix like A101A or G201.1).
 */

const { flatText } = require('./page-text');

// Match sheet numbers like A000, A101A, G201, FP-101, S101.1.
const SHEET_NUMBER_RE = /\b(?:FP|FA|[GASMEPCLTID])\d{1,4}(?:[A-Z]\d?)?(?:\.\d+)?\b/;

/**
 * Looks at every page for a region that contains many sheet-number
 * patterns. The cover sheet's drawing schedule has 10-200 of them
 * clustered together; other pages have at most a handful in titleblocks.
 */
function parseDrawingIndex(pages) {
  let bestPage = null;
  let bestSheets = [];

  for (const p of pages) {
    const sheets = extractSheetsFromPage(p);
    if (sheets.length > bestSheets.length) {
      bestSheets = sheets;
      bestPage = p.page_number;
    }
  }

  // Only treat as "real" index if we found 8+ sheets (smaller hits are
  // probably titleblock cross-references, not the index itself)
  if (bestSheets.length < 8) {
    return { sheets: [], pageWithIndex: null };
  }
  return { sheets: bestSheets, pageWithIndex: bestPage };
}

function extractSheetsFromPage(page) {
  // Sort items by y descending (top to bottom in screen coords) then x
  // ascending. Then walk and pair up sheet-number tokens with the next
  // text token at roughly the same y as the sheet name.
  const items = (page.items || []).slice().sort((a, b) => {
    if (Math.abs(a.y - b.y) > 4) return a.y - b.y;
    return a.x - b.x;
  });

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const m = (it.str || '').trim().match(SHEET_NUMBER_RE);
    if (!m) continue;

    // Pull the following items on the same row (similar y, advancing x)
    // and concatenate as the sheet name. Stop at the next sheet number
    // or a large x gap.
    const nameParts = [];
    for (let j = i + 1; j < items.length; j++) {
      const nx = items[j];
      if (Math.abs(nx.y - it.y) > 6) break;        // jumped to next row
      if (nx.x < it.x) break;                       // wrapped column
      if (SHEET_NUMBER_RE.test((nx.str || '').trim())) break;  // next sheet
      const word = (nx.str || '').trim();
      if (word) nameParts.push(word);
      if (nameParts.length >= 8) break;             // sheet names cap at ~8 words
    }

    const name = nameParts.join(' ').replace(/\s+/g, ' ').trim();
    // Filter junk: name must be 3+ chars and not just numbers/punctuation
    if (name.length >= 3 && /[A-Z]{2,}/.test(name)) {
      out.push({ number: m[0], name, page: page.page_number });
    }
  }

  // Dedupe by sheet number, keep first occurrence
  const seen = new Set();
  return out.filter((s) => {
    if (seen.has(s.number)) return false;
    seen.add(s.number);
    return true;
  });
}

/**
 * Pull every sheet reference from arbitrary text. Used to scan
 * source_evidence + scope_summary for things like "Detail 3/A060".
 *
 * Patterns matched:
 *   "DETAIL 3/A060", "Det. 5/A001", "3/A000", "A4.13/A001"
 *   "SHEET A301", "A301.1"
 *   "DET. 5 ON A001"
 */
const REF_PATTERNS = [
  /\b(?:DETAIL|DET\.?)\s+\d+\s*\/\s*((?:FP|FA|[GASMEPCLTID])\d{1,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b/gi,
  /\b\d+\s*\/\s*((?:FP|FA|[GASMEPCLTID])\d{2,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b/g,
  /\bSHEET\s+((?:FP|FA|[GASMEPCLTID])\d{1,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b/gi,
  /\bON\s+((?:FP|FA|[GASMEPCLTID])\d{2,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b/gi,
];

function extractSheetReferences(text) {
  if (!text) return [];
  const refs = new Set();
  for (const re of REF_PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) refs.add(m[1].toUpperCase());
    }
  }
  return [...refs];
}

module.exports = {
  parseDrawingIndex,
  extractSheetReferences,
  SHEET_NUMBER_RE,
};
