/**
 * parse-sow.js — extract structured exclusions and inclusions from
 * the project's Statement of Work narrative.
 *
 * Today my system over-applied a SOW exclusion: "Handwash Stations
 * 1 & 2 priced separately" got interpreted as "exclude every door
 * with 'handwash' in the room name" — which wrongly caught room 132
 * (Boot Scrubbing Room 2). Fix: parse the SOW for explicit room
 * numbers and only exclude those exact numbers.
 *
 * Output: { excluded_room_numbers: [], excluded_categories: [],
 *           explicit_inclusions: [...], scope_notes: [] }
 */

// Patterns that signal an exclusion phrase in the SOW
const EXCLUSION_VERB_RE = /(?:priced separately|to be priced separately|by others|not included|out of scope|excluded|under separate contract|by owner)/i;

// Match a room number with optional letter suffix: "Room 126", "126A", "rooms 126 and 133"
const ROOM_NUMBER_RE = /\b(?:room|rm\.?)\s+(\d{2,3}[A-Za-z]?)\b/gi;
const BARE_ROOM_RE = /\b(\d{3}[A-Za-z]?)\b/g;
const STATION_RE = /\b(?:station|sta\.?)\s+(?:no\.?\s*)?#?(\d+)\b/gi;

/**
 * Pull excluded room numbers + general scope notes from SOW pages.
 * @param {Array} pages — extract-text page objects
 * @return {Object}
 */
function parseSOW(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return {
      excluded_room_numbers: [],
      excluded_categories: [],
      explicit_inclusions: [],
      scope_notes: [],
    };
  }

  const flat = pages.map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
  const sentences = flat
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?:])\s+(?=[A-Z*•])/);  // split on sentence-ish boundaries

  const excludedRooms = new Set();
  const excludedCategories = [];
  const inclusions = [];
  const notes = [];

  for (const s of sentences) {
    const sNorm = s.trim();
    if (sNorm.length < 12) continue;

    if (EXCLUSION_VERB_RE.test(sNorm)) {
      // Pull room numbers from the exclusion sentence (and a few words
      // after — "Handwash Stations 1 & 2" expands later via the A101
      // door schedule mapping).
      for (const m of sNorm.matchAll(ROOM_NUMBER_RE)) excludedRooms.add(m[1]);
      // Bare 3-digit numbers in an exclusion sentence are often
      // room numbers too
      for (const m of sNorm.matchAll(BARE_ROOM_RE)) {
        const candidate = m[1];
        // Skip year-like numbers (2026) and obvious non-room sequences
        if (/^(?:20\d{2}|19\d{2})$/.test(candidate)) continue;
        excludedRooms.add(candidate);
      }
      // Station numbers ("Stations 1 & 2") get tagged as a category
      for (const m of sNorm.matchAll(STATION_RE)) {
        excludedCategories.push(`station_${m[1]}`);
      }
      excludedCategories.push(sNorm.slice(0, 200));
      notes.push({ type: 'exclusion', text: sNorm.slice(0, 200) });
    } else if (/^\s*(?:include[ds]?|provide[ds]?|the project includes|scope of work)/i.test(sNorm)) {
      inclusions.push(sNorm.slice(0, 200));
      notes.push({ type: 'inclusion', text: sNorm.slice(0, 200) });
    }
  }

  return {
    excluded_room_numbers: [...excludedRooms].sort(),
    excluded_categories: excludedCategories,
    explicit_inclusions: inclusions,
    scope_notes: notes,
  };
}

module.exports = { parseSOW };
