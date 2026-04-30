/**
 * lib/takeoff/tonnage-sanity.js — cross-check the takeoff's total
 * weight against any explicit tonnage / poundage statements in the
 * spec narrative or general notes.
 */

const TONNAGE_PATTERNS = [
  /(?:approximately|approx\.?|about|min(?:imum)?|max(?:imum)?|±)\s*([\d.]+)\s*(?:tons?|t)\b\s*(?:of\s+)?(?:structural\s+)?(?:steel|metal|fabrication)/i,
  /(?:approximately|approx\.?|about|min(?:imum)?|max(?:imum)?|±)?\s*([\d,]+)\s*(?:lbs?|pounds?)\s*(?:of\s+)?(?:structural\s+)?(?:steel|metal|fabrication)/i,
  /(?:estimated|est\.?)\s+(?:weight|tonnage)[:\s]+([\d.]+)\s*(?:tons?|t)\b/i,
];

const TOLERANCE_PCT = 0.20;

const { flatText } = require('../plan-intelligence/page-text');

function findTonnageAssertions(documents) {
  const results = [];
  for (const doc of documents) {
    for (const p of doc.pages) {
      const text = flatText(p);
      for (const re of TONNAGE_PATTERNS) {
        const m = re.exec(text);
        if (!m) continue;
        const num = Number(m[1].replace(/,/g, ''));
        if (!Number.isFinite(num) || num <= 0) continue;
        const isLbs = /lbs?|pounds?/i.test(m[0]);
        const asserted_weight_lbs = isLbs ? num : num * 2000;
        results.push({
          source_filename: doc.filename,
          page_number: p.page_number,
          matched_text: m[0].trim(),
          asserted_weight_lbs,
          unit: isLbs ? 'lbs' : 'tons',
        });
      }
    }
  }
  return results;
}

function checkTonnage(takeoffTotalLbs, assertions) {
  if (assertions.length === 0) {
    return {
      takeoff_total_lbs: takeoffTotalLbs,
      asserted: [],
      min_asserted_lbs: null,
      max_asserted_lbs: null,
      delta_pct: null,
      status: 'no_assertion',
      message: 'No tonnage statement found in the spec narrative; tonnage sanity check not performed.',
    };
  }
  const weights = assertions.map((a) => a.asserted_weight_lbs);
  const minA = Math.min(...weights);
  const maxA = Math.max(...weights);
  const mid = (minA + maxA) / 2;
  const delta = (takeoffTotalLbs - mid) / mid;

  if (Math.abs(delta) <= TOLERANCE_PCT) {
    return {
      takeoff_total_lbs: takeoffTotalLbs,
      asserted: assertions,
      min_asserted_lbs: minA,
      max_asserted_lbs: maxA,
      delta_pct: delta,
      status: 'ok',
      message: `Takeoff total ${Math.round(takeoffTotalLbs)} lbs is within +-${Math.round(TOLERANCE_PCT * 100)}% of the spec assertion (~${Math.round(mid)} lbs).`,
    };
  }
  if (delta < 0) {
    return {
      takeoff_total_lbs: takeoffTotalLbs,
      asserted: assertions,
      min_asserted_lbs: minA,
      max_asserted_lbs: maxA,
      delta_pct: delta,
      status: 'low',
      message: `Takeoff total ${Math.round(takeoffTotalLbs)} lbs is ${Math.round(Math.abs(delta) * 100)}% LOWER than the spec assertion (${Math.round(mid)} lbs). Likely missing scope items.`,
    };
  }
  return {
    takeoff_total_lbs: takeoffTotalLbs,
    asserted: assertions,
    min_asserted_lbs: minA,
    max_asserted_lbs: maxA,
    delta_pct: delta,
    status: 'high',
    message: `Takeoff total ${Math.round(takeoffTotalLbs)} lbs is ${Math.round(delta * 100)}% HIGHER than the spec assertion (${Math.round(mid)} lbs). Possibly over-counted; verify scope items.`,
  };
}

module.exports = { findTonnageAssertions, checkTonnage };
