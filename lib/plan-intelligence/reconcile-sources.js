/**
 * lib/plan-intelligence/reconcile-sources.js — cross-source verification.
 *
 * For every door in the parsed door schedule, also count appearances
 * of that door-number on the floor plan sheets. Disagreement between
 * schedule count and plan-occurrence count surfaces as a finding the
 * audit / RFI flow can consume.
 *
 * Why: the door schedule is the authoritative count, but a missing
 * door-number on the plan means the architect either forgot to draw it
 * or the schedule has a phantom row. Either way the GC needs to clarify.
 *
 * Same approach extends to lintels (mark→plan-occurrence), embeds, etc.
 */

/**
 * Count distinct mark-pattern occurrences in non-schedule pages of a
 * drawing document. Returns a Map of mark → page numbers it appeared on.
 */
function countMarkOccurrencesOnPlans(drawingDoc, markPattern, scheduleSourceFilename) {
  const counts = new Map();
  if (!drawingDoc || !drawingDoc._pages) return counts;
  const scheduleSheets = new Set(
    (drawingDoc.schedules || [])
      .filter((s) => s.source_filename === scheduleSourceFilename)
      .map((s) => s.page_number)
  );
  for (const p of drawingDoc._pages) {
    if (scheduleSheets.has(p.page_number)) continue;  // skip the schedule itself
    const seenOnThisPage = new Set();
    for (const it of p.items) {
      const tok = it.str.trim();
      if (markPattern.test(tok)) {
        if (!seenOnThisPage.has(tok)) {
          seenOnThisPage.add(tok);
          if (!counts.has(tok)) counts.set(tok, []);
          counts.get(tok).push(p.page_number);
        }
      }
    }
  }
  return counts;
}

/**
 * Reconcile a parsed door schedule against plan-page door-number
 * occurrences. Returns findings + per-row reconciliation.
 */
function reconcileDoorSchedule(schedule, drawingDocs) {
  if (!schedule || schedule.kind !== 'door_schedule') return null;

  // Build the plan-occurrence map across all drawing docs. Tight pattern:
  // 3-digit door numbers (100-999) optionally followed by a letter — this
  // excludes 1-2 digit grid markers (1-16, A-J) and 4+ digit sheet stamps
  // (250379, 158507) which would otherwise flood the plan-only list.
  const allCounts = new Map();
  for (const d of drawingDocs) {
    const counts = countMarkOccurrencesOnPlans(d, /^\d{3}[A-Za-z]?$/, schedule.source_filename);
    for (const [mark, pages] of counts) {
      if (!allCounts.has(mark)) allCounts.set(mark, []);
      allCounts.get(mark).push(...pages);
    }
  }

  const reconciled = [];
  const scheduleMarks = new Set();
  for (const r of schedule.rows) {
    // Pull each candidate mark from the row's known fields. Some rows
    // contain multiple comma- or space-separated marks. Match only
    // 3-digit door numbers to avoid catching size dimensions like
    // "3'-0\"" or grid column labels.
    const cellValues = Object.values(r).filter((v) => v != null && v !== '');
    const markCandidates = new Set();
    for (const cell of cellValues) {
      for (const tok of String(cell).split(/[\s,;]+/)) {
        if (/^\d{3}[A-Za-z]?$/.test(tok)) markCandidates.add(tok);
      }
      if (markCandidates.size > 0) break;
    }
    if (markCandidates.size === 0) continue;
    for (const mark of markCandidates) {
      scheduleMarks.add(mark);
      const planPages = allCounts.get(mark) || [];
      reconciled.push({
        mark,
        in_schedule: true,
        plan_pages: planPages,
        plan_appearances: planPages.length,
        agreed: planPages.length > 0,
      });
    }
  }

  // Door numbers on plans that aren't in the schedule
  const planOnlyMarks = [];
  for (const [mark, pages] of allCounts) {
    if (!scheduleMarks.has(mark)) {
      planOnlyMarks.push({
        mark,
        in_schedule: false,
        plan_pages: pages,
        plan_appearances: pages.length,
        agreed: false,
      });
    }
  }

  // Build findings — only surface real disagreements
  const findings = [];
  for (const r of reconciled) {
    if (!r.agreed) {
      findings.push({
        severity: 'warning',
        category: 'cross_source_disagreement',
        finding: `Door ${r.mark} appears in the schedule but no occurrence found on the floor plan pages.`,
        recommendation: `Verify door ${r.mark} location with the GC; the schedule entry may be a phantom or the plan may be missing the door tag.`,
      });
    }
  }
  // Plan-only marks are noisier (sheet stamps, project numbers, room
  // numbers w/o doors). Surface only when the count is small — otherwise
  // it's signal-to-noise too low to act on.
  if (planOnlyMarks.length > 0 && planOnlyMarks.length <= 5) {
    for (const m of planOnlyMarks) {
      findings.push({
        severity: 'info',
        category: 'cross_source_disagreement',
        finding: `Number ${m.mark} appears on plan page(s) ${m.plan_pages.slice(0, 3).join(', ')}${m.plan_pages.length > 3 ? '…' : ''} but is not in the door schedule.`,
        recommendation: `Verify whether ${m.mark} is a door requiring a schedule entry, or non-door annotation (room number, drawing reference).`,
      });
    }
  }

  return {
    schedule_marks_total: scheduleMarks.size,
    plan_marks_total: allCounts.size,
    in_both: reconciled.filter((r) => r.agreed).length,
    schedule_only: reconciled.filter((r) => !r.agreed).map((r) => r.mark),
    plan_only: planOnlyMarks.map((m) => m.mark),
    findings,
    rows: [...reconciled, ...planOnlyMarks],
  };
}

module.exports = { reconcileDoorSchedule, countMarkOccurrencesOnPlans };
