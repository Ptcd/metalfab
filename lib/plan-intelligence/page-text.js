/**
 * lib/plan-intelligence/page-text.js — single source of truth for
 * "give me the searchable text of a page."
 *
 * Why this exists: PDF text extractors emit variable inter-glyph spacing.
 * "SCHEDULE 80" can render as "SCHEDULE  80" or "SCHEDULE 80" or
 * "SCHEDULE  80 " depending on the font kerning. Consumers were each
 * doing `items.map(i => i.str).join(' ')` and then regex-matching with
 * literal single spaces — silently missing real content.
 *
 * Standard contract:
 *   - Whitespace runs collapsed to single space
 *   - Non-breaking spaces ( ) normalized to plain space
 *   - Smart quotes / em-dashes preserved (use normalizeForMatch in
 *     lib/takeoff/validate.js if you also need quote-mark folding)
 *   - Leading/trailing whitespace trimmed
 *
 * Use this everywhere downstream of pdfjs.getTextContent() for
 * regex matching. If you need positions, use the page.items array
 * directly — this helper is for haystack-style searches.
 */

function flatText(pageOrItems) {
  const items = Array.isArray(pageOrItems) ? pageOrItems : (pageOrItems?.items || []);
  return items
    .map((i) => (i?.str ?? ''))
    .join(' ')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function flatTextAcrossPages(pages) {
  return (pages || []).map(flatText).join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { flatText, flatTextAcrossPages };
