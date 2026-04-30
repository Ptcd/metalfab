/**
 * parse-notes.js — find note-code glossary pages and resolve
 * coded notes to their full text.
 *
 * Drawings use coded notes like A1.08, A4.13, D1.25 that point to
 * a glossary on a notes-key page. Today my system reads each page
 * in isolation and misses the indirection — so a callout like
 * "PROVIDE NEW 42\" RAILING per A1.08" might land in source_evidence
 * as just the code reference, not the actual scope description.
 *
 * Approach: scan every page for items whose text matches a code
 * pattern (one or two letters + digit + optional dot + digits) AT
 * THE START of the line, and is followed by long descriptive text.
 * Those are glossary entries. Build a code → description map.
 */

// Note codes have the dotted form (A1.08, D1.25, A4.13). Sheet
// numbers like A101 / G204 don't have the embedded dot, so the dot
// is what discriminates a real note code from a sheet identifier
// in the drawing index.
const NOTE_CODE_RE = /^([A-Z]\d+\.\d+)$/;
const NOTE_CODE_INLINE_RE = /\b([A-Z]\d+\.\d+)\b/g;

/**
 * Walk extracted pages and build a code → text glossary.
 * Heuristic: a "code-like" item at low x (left margin) followed
 * by descriptive text on the same y row signals a glossary entry.
 */
function buildNoteGlossary(pages) {
  const glossary = new Map();
  for (const p of pages || []) {
    // Cluster items by y (row)
    const sorted = [...p.items].sort((a, b) => a.y - b.y || a.x - b.x);
    let currentRow = [];
    let lastY = -Infinity;
    for (const it of sorted) {
      if (Math.abs(it.y - lastY) > 8 && currentRow.length) {
        processRow(currentRow, glossary, p.page_number);
        currentRow = [];
      }
      currentRow.push(it);
      lastY = it.y;
    }
    if (currentRow.length) processRow(currentRow, glossary, p.page_number);
  }
  return glossary;
}

function processRow(row, glossary, pageNumber) {
  if (row.length < 2) return;
  // Sort row by x
  row.sort((a, b) => a.x - b.x);
  const first = row[0];
  if (!first || !NOTE_CODE_RE.test(first.str.trim())) return;
  const code = first.str.trim();
  // Concatenate the rest of the row as the description
  const desc = row.slice(1).map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
  if (desc.length < 10) return;
  // First-seen wins; later pages with the same code get ignored
  // (architects sometimes repeat key-notes per discipline group)
  if (!glossary.has(code)) {
    glossary.set(code, { code, description: desc, source_page: pageNumber });
  }
}

/**
 * Given a piece of source text and the glossary, return any
 * note codes referenced + their resolved descriptions.
 */
function resolveNoteCodesInText(text, glossary) {
  const found = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(NOTE_CODE_INLINE_RE)) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    const entry = glossary.get(code);
    if (entry) found.push(entry);
  }
  return found;
}

module.exports = { buildNoteGlossary, resolveNoteCodesInText };
