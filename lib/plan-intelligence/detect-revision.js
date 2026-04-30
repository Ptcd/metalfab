/**
 * detect-revision.js — drawing revision precedence + addendum tracking.
 *
 * GCs reissue drawings during bidding. If both `S101 REV 0` and
 * `S101 REV 2` end up in the package, R2 wins. Today the system
 * has no concept of revision precedence, so the takeoff might cite
 * dimensions from an obsolete sheet.
 *
 * Approach:
 *   - Scan every drawing page for a revision marker (REV 0 / REV 1 /
 *     R0 / R2 / Addendum 1 / 04/15/2026 in the revision block).
 *   - When two pages share a sheet_no, keep the later revision.
 *   - Surface any revision conflict as a finding so the takeoff
 *     prompt can prefer the latest.
 */

// Common revision-marker patterns near the title block. Order of
// preference: explicit "Rev N", then numeric "(N)", then dates.
const REV_PATTERNS = [
  /\bREV(?:ISION)?\s*(\d+)\b/i,
  /\bR\s*(\d+)\b/,
  /\bAddendum\s+(\d+)\b/i,
  /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/,   // dates
];

function extractRevision(textInTitleBlock) {
  const t = String(textInTitleBlock || '');
  for (const re of REV_PATTERNS) {
    const m = re.exec(t);
    if (m) {
      // Numeric revisions sort naturally; dates parse to a Date
      const v = m[1];
      if (/^\d+$/.test(v)) return { kind: 'numeric', value: Number(v), raw: m[0] };
      const d = new Date(v);
      if (!isNaN(d.getTime())) return { kind: 'date', value: d.getTime(), raw: m[0] };
    }
  }
  return null;
}

/**
 * Given an array of plan_intelligence-style sheet entries, group
 * by sheet_no and pick the latest revision per group. Return a
 * findings list for any conflicts where two revisions exist.
 */
function pickLatestRevisions(sheets) {
  const bySheetNo = new Map();
  for (const s of sheets) {
    if (!s.sheet_no) continue;
    if (!bySheetNo.has(s.sheet_no)) bySheetNo.set(s.sheet_no, []);
    bySheetNo.get(s.sheet_no).push(s);
  }

  const findings = [];
  const winners = [];
  for (const [sheetNo, group] of bySheetNo) {
    if (group.length === 1) {
      winners.push(group[0]);
      continue;
    }
    // Sort by revision: numeric > date > none
    group.sort((a, b) => {
      const ra = a.revision || null;
      const rb = b.revision || null;
      if (!ra && !rb) return 0;
      if (!ra) return 1;
      if (!rb) return -1;
      if (ra.kind === rb.kind) return rb.value - ra.value;
      // numeric beats date when both present (architects usually use numeric)
      return ra.kind === 'numeric' ? -1 : 1;
    });
    winners.push(group[0]);
    findings.push({
      severity: 'warning',
      category: 'revision_conflict',
      finding: `Sheet ${sheetNo} appears ${group.length} times in the package with different revisions: ${group.map((g) => g.revision?.raw || '(unrevised)').join(', ')}. Using ${group[0].revision?.raw || '(first)'} as authoritative.`,
      recommendation: 'Confirm with GC which revision is the bid set.',
      related_sheet: sheetNo,
    });
  }
  return { winners, findings };
}

module.exports = { extractRevision, pickLatestRevisions };
