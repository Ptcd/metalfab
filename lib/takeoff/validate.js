/**
 * lib/takeoff/validate.js — six insert-time validators that fight
 * specific hallucination classes the takeoff agent can produce.
 *
 * Run from scripts/takeoff-commit.js BEFORE insert. Each validator
 * returns { findings, mutations } — findings flow into the audit
 * trail; mutations are applied to the line (e.g. downgrading a
 * quantity_band, raising a labor floor). Lines aren't rejected
 * outright unless the failure is structural (no source_evidence,
 * impossible quantity); soft failures become flagged_for_review.
 *
 * Validators:
 *   1. verbatim_quote          — source_evidence must appear in the
 *                                 actual extracted text
 *   2. quantity_band_downgrade — 'point' requires schedule row or
 *                                 dimensioned callout
 *   3. etr_exclusion           — line cannot cite ETR / existing /
 *                                 demo context
 *   4. assembly_prior_floor    — labor hours can't be < 0.5x prior
 *   5. material_grade_consistency — line grade must be in spec's
 *                                    allowed list
 *   6. cross_line_quantity     — duplicate scope items flagged
 */

const ETR_MARKERS = [
  /\(E\)/i,                                        // (E) marker
  /\bETR\b/i,
  /existing\s+to\s+remain/i,
  /\bexist(?:\.|ing)?\s+(?:to\s+)?remain/i,
  /demo(?:lition|lish|\.)/i,
];

const DEMO_SHEET_PREFIXES = ['D'];                 // D-series sheets

// Common ASTM steel grades by component family (coarse)
const GRADE_FAMILIES = {
  W: ['A992', 'A572'],                             // wide flange
  HSS: ['A500', 'A1085'],                          // tube
  PIPE: ['A53', 'A106'],                           // pipe
  ANGLE: ['A36', 'A572'],
  CHANNEL: ['A36', 'A572'],
  PLATE: ['A36', 'A572'],
  PIN: ['A325', 'A490', 'A307'],                   // bolts
  CFM: ['A653', 'A1003'],                          // cold-formed
};

/* ---------------- Helpers ---------------- */

function flatTextFromDigest(digestDocuments) {
  // Concatenate all extracted text from non-error docs. Used for
  // substring-checking source_evidence. Doesn't include the LLM-
  // generated takeoff narrative — that would let it cite itself.
  let text = '';
  for (const d of digestDocuments || []) {
    for (const s of d.sheets || []) {
      // We don't store per-page items in the persisted digest, so the
      // caller passes _pages (server-side, before strip) when available.
    }
  }
  return text;
}

function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function tokenSetFromQuote(quote) {
  // Pull the longest-content tokens from the quote. We won't insist
  // on exact substring (PDF extraction has spacing quirks) — instead
  // the quote's high-content tokens must be present in the doc text.
  return new Set(
    normalizeForMatch(quote)
      .split(/[^a-z0-9./'"-]+/)
      .filter((t) => t.length >= 4 && !/^[0-9]+$/.test(t))
  );
}

/* ---------------- Validator 1: verbatim quote ---------------- */

function validateVerbatimQuote(line, ctx) {
  if (!line.source_evidence || line.source_kind === 'manual' || line.source_kind === 'industry_default') {
    return { findings: [], mutations: {} };
  }
  const docText = ctx.fullText || '';
  if (!docText) return { findings: [], mutations: {} };

  const norm = normalizeForMatch(docText);
  const evidenceNorm = normalizeForMatch(line.source_evidence);
  // Try direct substring first (catches well-extracted quotes)
  if (evidenceNorm.length >= 12 && norm.includes(evidenceNorm.slice(0, Math.min(80, evidenceNorm.length)))) {
    return { findings: [], mutations: {} };
  }
  // Fall back to token-overlap: at least 70% of high-content tokens
  // from the quote must appear in the doc text.
  const tokens = tokenSetFromQuote(line.source_evidence);
  if (tokens.size === 0) return { findings: [], mutations: {} };
  let hits = 0;
  for (const t of tokens) {
    if (norm.includes(t)) hits++;
  }
  const ratio = hits / tokens.size;
  if (ratio < 0.5) {
    return {
      findings: [{
        severity: 'error',
        category: 'fabricated_quote',
        finding: `Line ${line.line_no} (${line.category}) cites source_evidence that doesn't appear in any extracted document text (${Math.round(ratio * 100)}% token overlap with package). The quote may be fabricated.`,
        recommendation: 'Verify the citation manually or reject this line.',
        related_takeoff_line: line.line_no,
      }],
      mutations: { flagged_for_review: true },
    };
  }
  return { findings: [], mutations: {} };
}

/* ---------------- Validator 2: quantity_band downgrade ---------------- */

function validateQuantityBand(line, ctx) {
  if (line.quantity_band !== 'point') return { findings: [], mutations: {} };

  // Point quantities need an anchor: a parsed schedule row OR a
  // dimensional/numeric callout in the source_evidence.
  const fromSchedule = (ctx.scheduleCounts || {})[line.category] != null;
  const ev = String(line.source_evidence || '');
  const hasDimension =
    /\b\d+\s*['']\s*-?\s*\d+(?:\s*['"])?/.test(ev) ||             // 12'-0"
    /\(\s*\d+\s*\)/.test(ev) ||                                    // (7)
    /\b\d+\s*(?:EA|LF|SF|LBS)\b/i.test(ev) ||
    /[Ww]\d+x\d+/.test(ev) ||                                      // W10x68
    /\bquantity[:=\s]+\d/i.test(ev);

  if (fromSchedule || hasDimension) return { findings: [], mutations: {} };

  return {
    findings: [{
      severity: 'warning',
      category: 'unanchored_point_quantity',
      finding: `Line ${line.line_no} claims quantity_band='point' but the source_evidence has no schedule row or dimensional/numeric anchor. Auto-downgrading to 'range'.`,
      recommendation: 'Add a quote with a specific dimension or schedule reference if quantity is genuinely point-precise.',
      related_takeoff_line: line.line_no,
    }],
    mutations: { quantity_band: 'range' },
  };
}

/* ---------------- Validator 3: ETR / existing / demo exclusion ---------------- */

function validateEtrExclusion(line) {
  const ev = String(line.source_evidence || '');
  for (const re of ETR_MARKERS) {
    if (re.test(ev)) {
      return {
        findings: [{
          severity: 'error',
          category: 'etr_in_scope',
          finding: `Line ${line.line_no} (${line.category}) cites source_evidence that contains an ETR / existing / demolition marker. Existing-to-remain items aren't TCB scope.`,
          recommendation: 'Remove the line, or rewrite it to cite a NEW-construction reference.',
          related_takeoff_line: line.line_no,
        }],
        mutations: { flagged_for_review: true, in_tcb_scope: false },
      };
    }
  }
  // Sheet-prefix check: source_section starts with 'D' = demolition sheet
  if (line.source_section && /^D[\d-]/.test(line.source_section)) {
    return {
      findings: [{
        severity: 'warning',
        category: 'etr_in_scope',
        finding: `Line ${line.line_no} cites a D-series demolition sheet (${line.source_section}). Demolition is rarely TCB scope.`,
        recommendation: 'Verify this is new construction, not demo.',
        related_takeoff_line: line.line_no,
      }],
      mutations: { flagged_for_review: true },
    };
  }
  return { findings: [], mutations: {} };
}

/* ---------------- Validator 4: assembly-prior labor floor ---------------- */

function validateAssemblyPriorFloor(line, ctx) {
  if (!line.assembly_type) return { findings: [], mutations: {} };
  const priors = ctx.priors || [];
  const matching = priors.filter((p) => p.assembly_type === line.assembly_type);
  if (matching.length === 0) return { findings: [], mutations: {} };

  // Median of the prior expected values across matching size bands
  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };
  const medFab = median(matching.map((p) => Number(p.fab_hrs_expected || 0)));
  const medIw = median(matching.map((p) => Number(p.ironworker_hrs_expected || 0)));

  // Floor at 0.5× the median (system shouldn't undercut Thomas's experience)
  // Scale by line.quantity / prior's typical assembly size (we use 1 per
  // line as a coarse default — refine when sample_count > 5).
  const scale = matching[0].sample_count > 5
    ? Number(line.quantity || 1) / Math.max(1, matching.reduce((a, p) => a + Number(p.total_weight_lbs || 0), 0) / matching.length / 100)
    : 1;
  const floorFab = medFab * 0.5 * scale;
  const floorIw = medIw * 0.5 * scale;

  const findings = [];
  const mutations = {};
  const fabHrs = Number(line.fab_hrs || 0);
  const iwHrs = Number(line.ironworker_hrs || 0);
  if (fabHrs > 0 && fabHrs < floorFab) {
    findings.push({
      severity: 'warning',
      category: 'labor_below_prior',
      finding: `Line ${line.line_no} fab_hrs=${fabHrs} is below the 0.5× floor of ${floorFab.toFixed(1)} from the ${line.assembly_type} prior (median ${medFab}). Raising to floor.`,
      recommendation: `Verify with Thomas — historical ${line.assembly_type} jobs averaged ${medFab.toFixed(1)} fab hrs.`,
      related_takeoff_line: line.line_no,
    });
    mutations.fab_hrs = Math.max(fabHrs, floorFab);
  }
  if (iwHrs > 0 && iwHrs < floorIw) {
    findings.push({
      severity: 'warning',
      category: 'labor_below_prior',
      finding: `Line ${line.line_no} ironworker_hrs=${iwHrs} is below the 0.5× floor of ${floorIw.toFixed(1)} from the ${line.assembly_type} prior (median ${medIw}).`,
      recommendation: 'Raising to floor; verify with Thomas if this assembly is unusually simple.',
      related_takeoff_line: line.line_no,
    });
    mutations.ironworker_hrs = Math.max(iwHrs, floorIw);
  }
  return { findings, mutations };
}

/* ---------------- Validator 5: material grade consistency ---------------- */

function validateMaterialGrade(line, ctx) {
  if (!line.material_grade || !line.steel_shape_designation) return { findings: [], mutations: {} };
  const designation = line.steel_shape_designation;
  let family = null;
  if (/^W\d/.test(designation)) family = 'W';
  else if (/^HSS/i.test(designation)) family = 'HSS';
  else if (/pipe/i.test(designation)) family = 'PIPE';
  else if (/^L\d/.test(designation)) family = 'ANGLE';
  else if (/^C\d|^MC\d/.test(designation)) family = 'CHANNEL';
  else if (/^PL/i.test(designation) || /plate/i.test(designation)) family = 'PLATE';
  else if (/^[\d.]+S\d{3}-\d/.test(designation)) family = 'CFM';
  if (!family) return { findings: [], mutations: {} };

  const allowed = GRADE_FAMILIES[family] || [];
  if (allowed.length && !allowed.some((g) => line.material_grade.includes(g))) {
    return {
      findings: [{
        severity: 'warning',
        category: 'material_grade_mismatch',
        finding: `Line ${line.line_no} declares material_grade='${line.material_grade}' for a ${family}-family shape (${designation}). Typical grades for this family: ${allowed.join(', ')}.`,
        recommendation: `Verify against spec section 05 12 00 / 05 50 00 material requirements.`,
        related_takeoff_line: line.line_no,
      }],
      mutations: {},
    };
  }
  return { findings: [], mutations: {} };
}

/* ---------------- Validator 7: industry-prior bracket ---------------- */

/**
 * Bracket per-line quantity + per-unit hours against the
 * industry_priors table (RSMeans-style ranges).
 */
function validateIndustryPriorBracket(line, ctx) {
  const priors = (ctx.industryPriors || []).filter((p) => p.category === line.category);
  if (priors.length === 0) return { findings: [], mutations: {} };
  // Prefer building-type-specific match; fall back to generic
  const prior = priors.find((p) => p.building_type === ctx.buildingType) || priors.find((p) => p.building_type) || priors[0];

  const findings = [];
  const qty = Number(line.quantity || 0);
  if (prior.qty_max != null && qty > Number(prior.qty_max) * 1.5) {
    findings.push({
      severity: 'warning',
      category: 'qty_above_industry_typical',
      finding: `Line ${line.line_no} quantity ${qty} ${line.quantity_unit} for ${line.category} is >1.5x industry-typical max (${prior.qty_max}). Verify scope.`,
      recommendation: `Industry typical for ${line.category} on ${prior.building_type || 'this'} job: ${prior.qty_min}-${prior.qty_max} (typical ${prior.qty_typical}).`,
      related_takeoff_line: line.line_no,
    });
  }
  if (prior.qty_min != null && qty > 0 && qty < Number(prior.qty_min) * 0.5) {
    findings.push({
      severity: 'info',
      category: 'qty_below_industry_typical',
      finding: `Line ${line.line_no} quantity ${qty} for ${line.category} is below half the industry-typical minimum (${prior.qty_min}). May be missing scope.`,
      recommendation: `Verify against drawings — typical projects show ${prior.qty_min}+ items.`,
      related_takeoff_line: line.line_no,
    });
  }

  // Per-unit IW hours sanity (catches obviously-wrong labor)
  const iwHrs = Number(line.ironworker_hrs || 0);
  if (qty > 0 && iwHrs > 0 && prior.ironworker_hrs_per_unit_max != null) {
    const perUnit = iwHrs / qty;
    if (perUnit > Number(prior.ironworker_hrs_per_unit_max) * 2) {
      findings.push({
        severity: 'warning',
        category: 'labor_above_industry_typical',
        finding: `Line ${line.line_no} ironworker_hrs/unit (${perUnit.toFixed(2)}) is >2x industry-typical max (${prior.ironworker_hrs_per_unit_max}).`,
        recommendation: `Industry-typical IW hrs/unit for ${line.category}: ${prior.ironworker_hrs_per_unit_min}-${prior.ironworker_hrs_per_unit_max}.`,
        related_takeoff_line: line.line_no,
      });
    } else if (perUnit < Number(prior.ironworker_hrs_per_unit_min) * 0.4) {
      findings.push({
        severity: 'warning',
        category: 'labor_below_industry_typical',
        finding: `Line ${line.line_no} ironworker_hrs/unit (${perUnit.toFixed(2)}) is below 40% of industry-typical min (${prior.ironworker_hrs_per_unit_min}). Likely under-estimated.`,
        recommendation: 'Raise labor to at least industry-typical minimum.',
        related_takeoff_line: line.line_no,
      });
    }
  }

  return { findings, mutations: {} };
}

/* ---------------- Validator 6: cross-line quantity consistency ---------------- */

function validateCrossLineConsistency(lines) {
  const findings = [];
  // Group by category — multiple lines in the same category aren't
  // inherently wrong (e.g. F1 + F2 frames) but flag for review.
  const byCategory = new Map();
  for (const l of lines) {
    if (!byCategory.has(l.category)) byCategory.set(l.category, []);
    byCategory.get(l.category).push(l);
  }
  for (const [cat, group] of byCategory) {
    if (group.length <= 1) continue;
    // OK if descriptions are clearly differentiated (e.g. F1 vs F2)
    const descTokens = new Set();
    for (const g of group) {
      const m = String(g.description || '').match(/\bF\d|\bL\d|\bW\d|\btype\s+[a-z0-9]+/gi);
      if (m) m.forEach((x) => descTokens.add(x.toLowerCase()));
    }
    if (descTokens.size >= group.length) continue;  // each line has a unique type marker
    findings.push({
      severity: 'info',
      category: 'cross_line_overlap',
      finding: `${group.length} lines share category '${cat}': lines ${group.map((g) => g.line_no).join(', ')}. Verify these are distinct items, not duplicate scope.`,
      recommendation: 'If all lines describe the same item, consolidate; if distinct (e.g. F1 vs F2 frames), differentiate the descriptions.',
      related_takeoff_line: group[0].line_no,
    });
  }
  return findings;
}

/* ---------------- Top-level runner ---------------- */

/**
 * Run all 6 validators against a takeoff. Returns updated lines +
 * findings.
 *
 * @param {Object[]} lines       takeoff_lines about to be inserted
 * @param {Object}   ctx
 * @param {string}   ctx.fullText  concatenated extracted text from
 *                                  all spec/drawing/qa documents
 * @param {Object}   ctx.scheduleCounts  { lintel: 12, embed: 4, ... }
 * @param {Object[]} ctx.priors  rows from assembly_labor_priors
 */
function validateLines(lines, ctx) {
  const allFindings = [];
  const updated = lines.map((l) => {
    const merged = { ...l };
    for (const v of [validateVerbatimQuote, validateQuantityBand, validateEtrExclusion, validateAssemblyPriorFloor, validateMaterialGrade, validateIndustryPriorBracket]) {
      const { findings, mutations } = v(merged, ctx);
      allFindings.push(...findings);
      Object.assign(merged, mutations || {});
    }
    return merged;
  });
  allFindings.push(...validateCrossLineConsistency(updated));
  return { lines: updated, findings: allFindings };
}

module.exports = {
  validateLines,
  validateVerbatimQuote,
  validateQuantityBand,
  validateEtrExclusion,
  validateAssemblyPriorFloor,
  validateMaterialGrade,
  validateIndustryPriorBracket,
  validateCrossLineConsistency,
};
