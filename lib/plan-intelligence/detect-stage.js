/**
 * detect-stage.js — figure out where in its lifecycle a bid package is.
 *
 * The same set of filenames means different things at different stages:
 *  - At Pre-GMP / RFP: drawings are still draft, the GC explicitly tells
 *    you to make assumptions, and "see S101" really means "S101 will
 *    exist in the final CD set." Demanding the sheet here is wrong.
 *  - At Final CD: drawings should be complete, and a referenced sheet
 *    that isn't in the package is a real gap — request from GC.
 *
 * Stages: pre_gmp_rfp | final_cd | unknown
 */

const FILENAME_MARKERS = [
  { stage: 'pre_gmp_rfp', re: /\b(?:draft|pre[\s_-]?gmp|rfp|preliminary|progress[\s_-]?print|design[\s_-]?development|dd\b|95[\s_-]?%)/i },
  { stage: 'final_cd',    re: /\b(?:final|issued[\s_-]?for[\s_-]?(?:construction|bid)|ifc\b|ifb\b|construction[\s_-]?documents?|cd[\s_-]?set|100[\s_-]?%)/i },
];

const TEXT_MARKERS_RFP = [
  /construction\s+(?:docs?|documents?)\s+(?:to\s+(?:be\s+)?(?:provide|update|reflect|have)|will\s+(?:be\s+)?(?:provide|include))/i,
  /please\s+(?:make|carry|use)\s+(?:a\s+)?reasonable\s+assumption/i,
  /(?:specs|specifications)\s+(?:will\s+be\s+|to\s+be\s+)?(?:updated|provided|added)/i,
  /to\s+be\s+(?:provided\s+)?(?:in|with)\s+(?:the\s+)?(?:final|construction)\s+(?:cd|documents?)/i,
  /pre[\s-]?gmp\s+cost\s+commitment/i,
  /final\s+gmp\s+based\s+on\s+100\s*%/i,
];

const TEXT_MARKERS_CD = [
  /\bissued\s+for\s+construction\b/i,
  /\bIFC\b/,
  /\bbidding\s+set\b/i,
];

function flatText(pages, limit = 60000) {
  let total = 0;
  const out = [];
  for (const p of pages) {
    for (const it of p.items) {
      out.push(it.str);
      total += it.str.length + 1;
      if (total > limit) return out.join(' ');
    }
  }
  return out.join(' ');
}

/**
 * Decide stage from a list of processed documents.
 *
 * @param {Object[]} processedDocs — outputs of processDocument
 * @param {Object[]} rawDocs       — original {filename, pages}; used for text scan
 *                                   in qa_log / spec docs which carry the strongest
 *                                   stage signals.
 */
function detectBidStage(processedDocs) {
  const reasons = [];
  let rfpScore = 0;
  let cdScore = 0;

  for (const d of processedDocs) {
    for (const { stage, re } of FILENAME_MARKERS) {
      if (re.test(d.filename)) {
        reasons.push(`filename "${d.filename}" matches ${re.source} → ${stage}`);
        if (stage === 'pre_gmp_rfp') rfpScore += 2;
        else cdScore += 2;
      }
    }
  }

  // Text markers, only on docs that carry stage info: qa_log, specification.
  for (const d of processedDocs) {
    if (d.classification.kind !== 'qa_log' && d.classification.kind !== 'specification') continue;
    const text = d._fullText || '';
    if (!text) continue;
    let rfpHits = 0;
    for (const re of TEXT_MARKERS_RFP) if (re.test(text)) rfpHits++;
    if (rfpHits > 0) {
      reasons.push(`${d.classification.kind} "${d.filename}" has ${rfpHits} RFP-language marker(s)`);
      rfpScore += rfpHits;
    }
    let cdHits = 0;
    for (const re of TEXT_MARKERS_CD) if (re.test(text)) cdHits++;
    if (cdHits > 0) {
      reasons.push(`${d.classification.kind} "${d.filename}" has ${cdHits} CD-language marker(s)`);
      cdScore += cdHits;
    }
  }

  let stage = 'unknown';
  let confidence = 0;
  if (rfpScore > cdScore && rfpScore >= 2) {
    stage = 'pre_gmp_rfp';
    confidence = Math.min(95, 50 + rfpScore * 8);
  } else if (cdScore > rfpScore && cdScore >= 2) {
    stage = 'final_cd';
    confidence = Math.min(95, 50 + cdScore * 8);
  } else if (rfpScore + cdScore >= 1) {
    stage = rfpScore >= cdScore ? 'pre_gmp_rfp' : 'final_cd';
    confidence = 40;
  }

  return { stage, confidence, reasons };
}

module.exports = { detectBidStage, flatText };
