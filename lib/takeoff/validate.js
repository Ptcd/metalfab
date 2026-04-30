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
    .replace(/ /g, ' ')                  // non-breaking space → space
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

// Pull anything inside quote marks (single, double, smart quotes) — those
// segments are claims of literal-text presence and must be exact substrings.
// Used to defeat the fabrication failure mode where an agent paraphrases a
// real source then tucks an invented "verbatim" §-citation inside quotes.
const QUOTED_SPAN_RE = /(?:["'‘’“”])([^"'‘’“”]{8,})(?:["'‘’“”])/g;

function extractQuotedSpans(text) {
  const out = [];
  if (!text) return out;
  let m;
  QUOTED_SPAN_RE.lastIndex = 0;
  while ((m = QUOTED_SPAN_RE.exec(text)) !== null) {
    if (m[1] && m[1].trim().length >= 8) out.push(m[1].trim());
  }
  return out;
}

function validateVerbatimQuote(line, ctx) {
  if (!line.source_evidence || line.source_kind === 'manual' || line.source_kind === 'industry_default') {
    return { findings: [], mutations: {} };
  }
  const docText = ctx.fullText || '';
  if (!docText) return { findings: [], mutations: {} };

  const norm = normalizeForMatch(docText);

  // FIRST CHECK: any literally-quoted span inside source_evidence MUST be a
  // verbatim substring (after whitespace + smart-quote normalization). This
  // catches the fabrication mode where an agent invents a "§2.01.B" citation
  // tucked inside quotes. Paraphrased prose around the quote is fine.
  const quoted = extractQuotedSpans(line.source_evidence);
  for (const span of quoted) {
    const spanNorm = normalizeForMatch(span);
    if (spanNorm.length < 8) continue;
    if (!norm.includes(spanNorm)) {
      return {
        findings: [{
          severity: 'error',
          category: 'fabricated_quote',
          finding: `Line ${line.line_no} (${line.category}) source_evidence contains a quoted span "${span.slice(0, 80)}${span.length > 80 ? '...' : ''}" that is NOT a verbatim substring of the package. Quoted text must be literal — paraphrase if you don't have the exact wording.`,
          recommendation: 'Either provide the exact verbatim text from the package, or rephrase without quote marks. Refusing to merge until quote is verified.',
          related_takeoff_line: line.line_no,
        }],
        mutations: { flagged_for_review: true, confidence: Math.min(Number(line.confidence || 0), 0.40) },
      };
    }
  }

  // SECOND CHECK: the overall source_evidence prose should still pass
  // token-overlap. Threshold raised from 50% → 70% so a paraphrased
  // citation that name-drops random package vocabulary doesn't slip
  // through. Direct substring (well-extracted quotes) still preferred.
  const evidenceNorm = normalizeForMatch(line.source_evidence);
  if (evidenceNorm.length >= 12 && norm.includes(evidenceNorm.slice(0, Math.min(80, evidenceNorm.length)))) {
    return { findings: [], mutations: {} };
  }
  const tokens = tokenSetFromQuote(line.source_evidence);
  if (tokens.size === 0) return { findings: [], mutations: {} };
  let hits = 0;
  for (const t of tokens) {
    if (norm.includes(t)) hits++;
  }
  const ratio = hits / tokens.size;
  if (ratio < 0.70) {
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

/* ---------------- Validator: CFM (cold-formed) auto-exclusion ---------------- */

const CFM_DESIGNATION_RE = /^\d+S\d+(?:-\d+)?$/i;   // 800S162-68

function validateCfmExclusion(line) {
  if (line.steel_shape_designation && CFM_DESIGNATION_RE.test(line.steel_shape_designation)) {
    return {
      findings: [{
        severity: 'warning',
        category: 'cfm_not_tcb_scope',
        finding: `Line ${line.line_no} uses cold-formed metal framing designation "${line.steel_shape_designation}" — this is light-gauge steel typically carried by the drywall / 09 21 00 contractor, not 05 10 00 structural metals.`,
        recommendation: `Confirm scope split with GC. If TCB does carry CFM, line should map to CSI 05 40 00 not 05 50 00.`,
        related_takeoff_line: line.line_no,
      }],
      mutations: { flagged_for_review: true },
    };
  }
  return { findings: [], mutations: {} };
}

/* ---------------- Validator: V.I.F. / "match existing" auto-RFI ---------------- */

// Material / spec V.I.F. — high risk. Not knowing what material to fabricate
// is a real blocker; price can't be locked without a GC answer.
const VIF_MATERIAL_PATTERNS = [
  /\bmatch\s+existing\b/i,
  /\bsame\s+as\s+existing\b/i,
];

// Dimensional V.I.F. — standard renovation practice. Architect can't measure
// a partial-demo wall before construction. Estimator carries nominal × 1.05
// for V.I.F. allowance and prices the line normally.
const VIF_DIMENSIONAL_PATTERNS = [
  /\d+'\s*-?\s*\d+(?:\s*\d+\/\d+)?"\s*(?:\+\/-|V\.I\.F\.)/i,       // "9'-8" V.I.F." or "12'-0" +/-"
  /\bverify\s+in\s+field\b/i,
  /\bfield\s+verify\b/i,
  /V\.I\.F\./i,                                                     // bare V.I.F. — assume dimensional unless paired with material language
];

// Existing-condition documentation — when the package contains demo plans,
// existing-conditions notes, or a verbatim photo/elevation of the existing
// rail, "match existing" stops being an RFI and becomes a recorded measurement.
const EXISTING_CONDITION_DOCUMENTED = [
  /existing\s+condition\s+documented/i,
  /demo\s+plan\s+(?:shows|p\d+)/i,
  /existing\s+(?:rail|bollard|frame)\s+(?:shown|in)\s+(?:p|sheet)/i,
  /verbatim\s+from\s+(?:elevation|demo)/i,
];

// "Match existing" sometimes refers ONLY to finish/paint color, not structural
// material — when the structural spec (size/shape/grade) is already defined
// elsewhere in the same line. That's a low-risk finish V.I.F., not a true
// material RFI. Detected by presence of explicit shape/size language alongside
// the match-existing note.
const STRUCTURAL_SPEC_PRESENT = [
  /\b(?:HSS|W\d+|C\d+|L\d+|MC\d+|S\d+|PL)\s*[\dx\/."]/i,             // shape designation present
  /\b\d+"\s*(?:dia(?:meter)?|sch(?:edule)?\s*\d+|pipe)/i,            // pipe size present
  /\b\d+\s*ga(?:uge)?\b/i,                                            // gauge spec
  /\b\d+'\s*-?\s*\d*"?\s*(?:high|tall|long|wide)\b/i,                 // dimensional spec
  /\bbi-?parting\s+gate\b/i,                                          // assembly type explicit
];

function classifyVif(text) {
  const hasMaterialVif = VIF_MATERIAL_PATTERNS.some((re) => re.test(text));
  const hasDimensionalVif = VIF_DIMENSIONAL_PATTERNS.some((re) => re.test(text));
  const isDocumented = EXISTING_CONDITION_DOCUMENTED.some((re) => re.test(text));
  const hasStructuralSpec = STRUCTURAL_SPEC_PRESENT.some((re) => re.test(text));
  if (hasMaterialVif && hasStructuralSpec && !isDocumented) return 'finish_vif';
  if (hasMaterialVif && !isDocumented) return 'material_vif_unresolved';
  if (hasMaterialVif && isDocumented) return 'material_vif_documented';
  if (hasDimensionalVif) return 'dimensional_vif';
  return null;
}

function validateVifAutoRfi(line) {
  const text = `${line.source_evidence || ''} ${line.description || ''} ${line.assumptions || ''}`;
  const kind = classifyVif(text);
  if (!kind) return { findings: [], mutations: {} };

  if (kind === 'finish_vif') {
    // Material is structurally defined; only finish (paint color, mounting
    // hardware style, etc.) is unspecified. Low-risk; carry painter
    // contingency in finish budget. Cap at 0.85, not 0.50.
    return {
      findings: [{
        severity: 'info',
        category: 'finish_vif_only',
        finding: `Line ${line.line_no} cites "match existing" but the structural spec (size/shape/dimensions) is fully defined — only finish/color is V.I.F. Low-risk finish RFI, not a structural blocker.`,
        recommendation: 'Carry painter finish contingency. No structural RFI needed. Confidence capped at 0.85.',
        related_takeoff_line: line.line_no,
      }],
      mutations: { confidence: Math.min(Number(line.confidence || 0), 0.85) },
    };
  }

  if (kind === 'dimensional_vif') {
    // Information-only finding; no confidence drop. Standard renovation practice.
    return {
      findings: [{
        severity: 'info',
        category: 'vif_dimensional_noted',
        finding: `Line ${line.line_no} cites a dimensional V.I.F. — standard for renovation work. Carry nominal × 1.05 for field-verify allowance; no RFI needed.`,
        recommendation: 'Add 5% to material quantity in pricing to absorb field-verified dimensional variance.',
        related_takeoff_line: line.line_no,
      }],
      mutations: {},
    };
  }

  if (kind === 'material_vif_documented') {
    // Material V.I.F. but the package documents the existing condition (demo
    // plan / photo / elevation). Cap conf at 0.75, not 0.50.
    return {
      findings: [{
        severity: 'info',
        category: 'vif_resolved_by_existing_documentation',
        finding: `Line ${line.line_no} cites "match existing" but the package documents the existing condition — not a true RFI.`,
        recommendation: 'Cite the demo plan / elevation page in source_evidence. Confidence capped at 0.75 to retain field-verify margin.',
        related_takeoff_line: line.line_no,
      }],
      mutations: { confidence: Math.min(Number(line.confidence || 0), 0.75) },
    };
  }

  // material_vif_unresolved — original strict behavior
  return {
    findings: [{
      severity: 'warning',
      category: 'vif_requires_confirmation',
      finding: `Line ${line.line_no} cites a "match existing" / V.I.F. condition — quantity or material requires field confirmation before pricing can be locked.`,
      recommendation: 'Auto-RFI to GC for material/dimension confirmation. Drop confidence to 0.5 until resolved.',
      related_takeoff_line: line.line_no,
    }],
    mutations: { flagged_for_review: true, confidence: Math.min(Number(line.confidence || 0), 0.50) },
  };
}

/* ---------------- Validator: relevant-page coverage ---------------- */

/**
 * For every takeoff line, plan-intelligence has identified which pages
 * in the package contain strong-signal content for that category
 * (ctx.categoryPages: { bollard: [21, 27, 32], guardrail: [...], ... }).
 * The line's source_evidence must cite at least one of those pages.
 *
 * Catches the failure mode where the agent's regex matched one page,
 * the agent treated that as the evidence ceiling, and never opened
 * sibling pages with richer detail (e.g. citing only the equipment
 * schedule on p27 but never reading the bollard fab detail on p21).
 *
 * Run-level: also fires `unread_relevant_page` for any page in the
 * category-pages map that NO line cites — surfacing pages the agent
 * silently skipped.
 */
function validateRelevantPageCoverage(line, ctx) {
  if (!ctx || !ctx.categoryPages) return { findings: [], mutations: {} };
  const relevantPages = ctx.categoryPages[line.category] || ctx.categoryPages[line.assembly_type];
  if (!relevantPages || relevantPages.length === 0) return { findings: [], mutations: {} };

  // Find page numbers cited in source_evidence + assumptions
  const blob = `${line.source_evidence || ''} ${line.assumptions || ''} ${line.notes || ''} ${line.source_section || ''}`;
  const citedPages = new Set();
  // Match "p27", "p. 21", "page 32", "S101 (p19)", or numeric source_page.
  const re = /\bp(?:age|\.)?\s*(\d{1,3})\b/gi;
  let m;
  while ((m = re.exec(blob)) !== null) citedPages.add(Number(m[1]));
  if (line.source_page != null) citedPages.add(Number(line.source_page));

  // Did the line cite at least one strongly-relevant page?
  const overlap = relevantPages.filter((p) => citedPages.has(p));
  if (overlap.length > 0) return { findings: [], mutations: {} };

  return {
    findings: [{
      severity: 'warning',
      category: 'relevant_page_uncited',
      finding: `Line ${line.line_no} (${line.category}) cites pages [${[...citedPages].join(', ') || 'none'}] but plan-intelligence flagged pages [${relevantPages.join(', ')}] as containing strong-signal ${line.category} content. Likely missed fab-detail content.`,
      recommendation: `Open and read pages ${relevantPages.slice(0, 3).join(', ')} before pricing. Cite the specific detail you used in source_evidence.`,
      related_takeoff_line: line.line_no,
    }],
    mutations: { confidence: Math.min(Number(line.confidence || 0), 0.65) },
  };
}

/* ---------------- Run-level validator: pages that no line cites ----- */

function validatePageCoverageAtRunLevel(lines, ctx) {
  if (!ctx || !ctx.categoryPages) return [];
  const findings = [];

  // Build set of all cited pages across all lines
  const citedPages = new Set();
  for (const l of lines) {
    if (l.source_page != null) citedPages.add(Number(l.source_page));
    const blob = `${l.source_evidence || ''} ${l.assumptions || ''} ${l.notes || ''} ${l.source_section || ''}`;
    const re = /\bp(?:age|\.)?\s*(\d{1,3})\b/gi;
    let m;
    while ((m = re.exec(blob)) !== null) citedPages.add(Number(m[1]));
  }

  // For each category in the takeoff, flag pages not cited
  const takeoffCats = new Set(lines.map((l) => l.category));
  for (const cat of takeoffCats) {
    const relevant = ctx.categoryPages[cat];
    if (!relevant || relevant.length === 0) continue;
    const missed = relevant.filter((p) => !citedPages.has(p));
    if (missed.length === 0) continue;
    findings.push({
      severity: 'warning',
      category: 'relevant_pages_unread_at_run_level',
      finding: `Pages [${missed.join(', ')}] contain strong-signal ${cat} content but no takeoff line cites them. The agent may have stopped reading after the first hit.`,
      recommendation: `Open pages ${missed.slice(0, 5).join(', ')} and confirm there's no missed scope before locking the bid.`,
      related_takeoff_line: null,
    });
  }
  return findings;
}

/* ---------------- Validator: ghost-spec-section reference --------- */

/**
 * If a line cites "Section 05 52 13" or "per spec 05 50 00" but that
 * section isn't actually in the package's tcb_sections, the agent is
 * either citing from training-data memory of typical spec language or
 * (worse) fabricating a spec to back a takeoff line.
 *
 * Caller passes ctx.specSectionsAbsent: array of CSI codes referenced
 * in drawings but not present in the package.
 */
const SPEC_REF_RE_VALIDATOR = /\b(?:SECTION|SPEC(?:IFICATION)?|PER)\s+(\d{2})\s*(\d{2})\s*(\d{2})\b/gi;

function validateSpecSectionReference(line, ctx) {
  if (!ctx || !Array.isArray(ctx.specSectionsAbsent) || ctx.specSectionsAbsent.length === 0) {
    return { findings: [], mutations: {} };
  }
  const blob = `${line.source_evidence || ''} ${line.assumptions || ''} ${line.notes || ''} ${line.description || ''}`;
  const cited = new Set();
  let m;
  SPEC_REF_RE_VALIDATOR.lastIndex = 0;
  while ((m = SPEC_REF_RE_VALIDATOR.exec(blob)) !== null) {
    cited.add(`${m[1]} ${m[2]} ${m[3]}`);
  }
  const ghostRefs = [...cited].filter((s) => ctx.specSectionsAbsent.includes(s));
  if (!ghostRefs.length) return { findings: [], mutations: {} };
  return {
    findings: [{
      severity: 'error',
      category: 'ghost_spec_reference',
      finding: `Line ${line.line_no} cites spec section(s) [${ghostRefs.join(', ')}] that the drawings reference but are NOT present in the package's spec coverage. Either the project manual wasn't uploaded, the architect pointed at a deleted section, or the citation is fabricated.`,
      recommendation: `Auto-RFI: request the project manual section(s) ${ghostRefs.join(', ')}. Until received, this line cannot be priced from documents alone.`,
      related_takeoff_line: line.line_no,
    }],
    mutations: { flagged_for_review: true, confidence: Math.min(Number(line.confidence || 0), 0.50) },
  };
}

/* ---------------- Run-level: multi-detail sheet read-through ----- */

/**
 * For each sheet a takeoff cites, count how many distinct detail blocks
 * appear on that sheet (DETAIL 1, DETAIL 2, ... or TYPICAL X / SECTION A-A).
 * If the takeoff lines collectively cite that sheet but reference only one
 * detail when many exist, flag — the agent likely tunnel-visioned on the
 * first hit.
 *
 * Caller passes ctx.sheetDetailCounts: { 'S101': 4, 'A001': 3, ... }
 * derived from plan-intelligence's per-sheet detail scan.
 */
function validateMultiDetailSheetReadthrough(lines, ctx) {
  if (!ctx || !ctx.sheetDetailCounts) return [];
  const findings = [];

  // Map sheet → detail numbers cited across all lines.
  const citedDetailsPerSheet = new Map();  // sheet → Set<number>
  const linesPerSheet = new Map();         // sheet → [line_no...]
  const DETAIL_REF = /\bDETAIL\s+(\d{1,2})\s*\/\s*((?:FP|FA|[GASMEPCLTID])\d{1,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b|\b(\d{1,2})\s*\/\s*((?:FP|FA|[GASMEPCLTID])\d{2,4}(?:[A-Z]\d?)?(?:\.\d+)?)\b/gi;

  for (const l of lines) {
    const blob = `${l.source_evidence || ''} ${l.assumptions || ''} ${l.notes || ''} ${l.description || ''}`;
    let m;
    DETAIL_REF.lastIndex = 0;
    while ((m = DETAIL_REF.exec(blob)) !== null) {
      const detailNum = Number(m[1] || m[3]);
      const sheet = (m[2] || m[4] || '').toUpperCase();
      if (!Number.isFinite(detailNum) || !sheet) continue;
      if (!citedDetailsPerSheet.has(sheet)) citedDetailsPerSheet.set(sheet, new Set());
      citedDetailsPerSheet.get(sheet).add(detailNum);
      if (!linesPerSheet.has(sheet)) linesPerSheet.set(sheet, []);
      linesPerSheet.get(sheet).push(l.line_no);
    }
  }

  for (const [sheet, totalDetails] of Object.entries(ctx.sheetDetailCounts)) {
    if (totalDetails < 2) continue;
    const cited = citedDetailsPerSheet.get(sheet) || new Set();
    if (cited.size === 0) continue;          // sheet not cited at all → not our problem here
    if (cited.size >= totalDetails - 1) continue;  // most details cited; ok
    const lineNos = linesPerSheet.get(sheet) || [];
    findings.push({
      severity: 'warning',
      category: 'multi_detail_sheet_undercited',
      finding: `Sheet ${sheet} has ${totalDetails} distinct detail blocks but the takeoff cites only ${cited.size} (Detail ${[...cited].join(', ')}). Lines [${lineNos.join(', ')}] reference this sheet — confirm the other ${totalDetails - cited.size} detail(s) aren't TCB scope or document the exclusion in source_evidence.`,
      recommendation: `Open ${sheet} and walk every detail block. If a detail is non-TCB (e.g., "TYPICAL HVAC RTU FRAME" → CFM scope), note the exclusion explicitly in the line's assumptions field.`,
      related_takeoff_line: lineNos[0] || null,
    });
  }
  return findings;
}

/* ---------------- Validator: ghost-sheet reference ---------------- */

/**
 * If a line cites "Detail 3/A060" or "REFER TO SHEET A060" but A060
 * isn't in the project's drawing index, that's a real gap. Either the
 * architect deleted the sheet or never produced it. Auto-RFI it
 * rather than letting the line ship with confidence based on a sheet
 * we don't have.
 *
 * Caller passes ctx.drawingIndexSheets (array of {number, name}).
 * If absent, the validator no-ops (we don't have an index for legacy
 * runs / pre-GMP packages).
 */
function validateSheetReferences(line, ctx) {
  const sheets = ctx.drawingIndexSheets;
  if (!Array.isArray(sheets) || sheets.length < 8) {
    return { findings: [], mutations: {} };  // no reliable index
  }
  const { extractSheetReferences } = require('../plan-intelligence/parse-drawing-index');

  const blob = `${line.source_evidence || ''} ${line.description || ''} ${line.assumptions || ''} ${line.notes || ''}`;
  const refs = extractSheetReferences(blob);
  if (!refs.length) return { findings: [], mutations: {} };

  const indexNumbers = new Set(sheets.map((s) => String(s.number).toUpperCase()));
  const ghosts = refs.filter((r) => !indexNumbers.has(r));
  if (!ghosts.length) return { findings: [], mutations: {} };

  return {
    findings: [{
      severity: 'error',
      category: 'ghost_sheet_reference',
      finding: `Line ${line.line_no} (${line.category}) cites sheet(s) [${ghosts.join(', ')}] that are NOT in the project drawing index. Either the sheet was deleted/renamed or the citation is wrong.`,
      recommendation: `Auto-RFI to GC: which sheet supersedes ${ghosts[0]}? Until resolved, this line cannot be priced from documents alone.`,
      related_takeoff_line: line.line_no,
    }],
    mutations: { flagged_for_review: true, confidence: Math.min(Number(line.confidence || 0), 0.55) },
  };
}

/* ---------------- Validator: lazy-allowance detector ---------------- */

/**
 * Catches the pattern where a line has low confidence (<0.70) plus
 * either (a) a >2x range spread, (b) the word "allowance" or
 * "placeholder" in description/assumptions, or (c) an RFI in the
 * recommended list that asks for length/count/dimension on a
 * callout — without showing evidence the agent attempted to MEASURE
 * by looking at nearby dimensions on the same page.
 *
 * Valid measurement evidence in source_evidence or assumptions
 * includes any of:
 *   - dimension chain text like 5'-0" | 4'-6"
 *   - "callout (X,Y)" + "dimension N px from callout"
 *   - "measured: N LF based on ..."
 *   - "callout count: N on p<page>"
 *
 * If none of the above appears AND confidence < 0.70 AND
 * (range spread > 2x OR allowance language), the line fails:
 * agent must re-extract dimensions before submitting.
 */
const LAZY_LANGUAGE = [
  /\ballowance\b/i,
  /\bplaceholder\b/i,
  /\bwild\s*guess\b/i,
  /\bI'?ll\s+(?:assume|use|carry)\s+\d/i,
  /\bpending\s+RFI\b/i,
  /\bcould\s+be\s+0\b/i,
];

const MEASUREMENT_EVIDENCE = [
  /\d+'\s*-?\s*\d+(?:\s*\d+\/\d+)?"/,             // dimension string
  /dimension\s+chain/i,
  /\bcallout\s+\(\s*\d+\s*,\s*\d+\s*\)/i,         // "callout (524,449)"
  /measured(?:\s+from)?:\s*\d+\s*(?:LF|EA)/i,
  /callout\s+count:\s*\d+/i,
  /\bspac(?:ed|ing)\s+(?:at\s+)?\d/i,             // "spaced at 4'-6" o.c."
  /typical\s+run\s+reads/i,
  /adjacent\s+dimension/i,
];

function validateLazyAllowance(line) {
  const blob = `${line.description || ''} ${line.source_evidence || ''} ${line.assumptions || ''} ${line.notes || ''}`;
  const conf = Number(line.confidence || 0);
  const qmin = Number(line.quantity_min || line.quantity || 0);
  const qmax = Number(line.quantity_max || line.quantity || 0);
  const spread = qmin > 0 ? qmax / qmin : (qmax > 0 ? Infinity : 1);

  const usedLazyLanguage = LAZY_LANGUAGE.some((re) => re.test(blob));
  const hasWideSpread = spread >= 2.0 && line.quantity_band !== 'point';
  const lowConfidence = conf < 0.70;

  if (!lowConfidence && !usedLazyLanguage) return { findings: [], mutations: {} };
  if (!usedLazyLanguage && !hasWideSpread) return { findings: [], mutations: {} };

  const hasMeasurementEvidence = MEASUREMENT_EVIDENCE.some((re) => re.test(blob));
  if (hasMeasurementEvidence) return { findings: [], mutations: {} };

  const reasons = [];
  if (lowConfidence) reasons.push(`confidence=${conf.toFixed(2)} < 0.70`);
  if (hasWideSpread) reasons.push(`quantity range spread ${spread.toFixed(1)}× (${qmin}–${qmax})`);
  if (usedLazyLanguage) {
    const matched = LAZY_LANGUAGE.find((re) => re.test(blob));
    reasons.push(`uses lazy language matching ${matched.source}`);
  }

  return {
    findings: [{
      severity: 'error',
      category: 'lazy_allowance',
      finding: `Line ${line.line_no} (${line.category}) looks like a guessed allowance, not a measurement. Reasons: ${reasons.join('; ')}. The source_evidence/assumptions show no dimension extraction, callout-count, or spacing measurement.`,
      recommendation: `Before this line can ship: open the cited PDF page near the callout coords and either (a) extract nearby dimensions (search same-page text for strings matching /\\d+'\\s*-\\s*\\d+\"/ within ~250–500px of the callout), (b) count the callout symbol occurrences across the relevant pages, or (c) document why measurement is impossible (e.g., scale-only drawing, no dimensions placed). Then update source_evidence with the measured anchor.`,
      related_takeoff_line: line.line_no,
    }],
    mutations: { flagged_for_review: true, confidence: Math.min(conf, 0.45) },
  };
}

/* ---------------- Validator: demo + new-equipment discrimination ---------------- */

/**
 * If a category has both a 'remove existing' note AND an entry in
 * the equipment schedule, treat the equipment-schedule entry as
 * authoritative new scope. Caller passes { hasNewEquipment: bool }
 * via ctx.equipmentScheduleCategories.
 */
function validateDemoNewDiscrimination(line, ctx) {
  if (!line.source_evidence) return { findings: [], mutations: {} };
  const ev = String(line.source_evidence);
  const hasDemoMarker = /remove\s+existing|demo(?:lition|lish|\.)/i.test(ev);
  if (!hasDemoMarker) return { findings: [], mutations: {} };
  const hasNewEquip = (ctx.equipmentScheduleCategories || []).includes(line.category);
  if (hasNewEquip) {
    // It's a replacement scope — not ETR. Override the ETR validator's flag.
    return {
      findings: [{
        severity: 'info',
        category: 'demo_replaced_by_new',
        finding: `Line ${line.line_no} cites a demolition note BUT the equipment schedule shows new ${line.category} items — this is replacement scope, not ETR.`,
        recommendation: 'Keep line. The equipment schedule is the authoritative source for new items.',
        related_takeoff_line: line.line_no,
      }],
      mutations: { flagged_for_review: false, in_tcb_scope: true },
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

/* ---------------- Density sanity (run-level, not per-line) ---------------- */

// lbs of TCB metals per SF for typical building / project types.
// If the run total falls way outside this band given the SOW's
// stated SF, something's missing or wildly over-counted.
const DENSITY_BAND_LBS_PER_SF = {
  small_commercial_renovation: { min: 0.05, typical: 0.40, max: 1.00 },
  industrial_factory_renovation: { min: 0.10, typical: 0.50, max: 2.00 },
  warehouse_addition: { min: 0.50, typical: 2.00, max: 5.00 },
  generic: { min: 0.05, typical: 0.50, max: 5.00 },
};

function validateDensitySanity(totalWeightLbs, projectSf, buildingType) {
  if (!projectSf || projectSf <= 0) return { findings: [], mutations: {} };
  const band = DENSITY_BAND_LBS_PER_SF[buildingType] || DENSITY_BAND_LBS_PER_SF.generic;
  const density = totalWeightLbs / projectSf;
  const findings = [];
  if (density < band.min * 0.5) {
    findings.push({
      severity: 'warning',
      category: 'density_below_typical',
      finding: `Takeoff total ${Math.round(totalWeightLbs)} lbs over ${projectSf} SF = ${density.toFixed(2)} lbs/SF, below half the typical floor (${band.min}). Likely missing scope items.`,
      recommendation: `Industry typical for ${buildingType.replace(/_/g, ' ')}: ${band.min}-${band.max} lbs/SF (typical ${band.typical}).`,
    });
  } else if (density > band.max * 1.5) {
    findings.push({
      severity: 'warning',
      category: 'density_above_typical',
      finding: `Takeoff total ${Math.round(totalWeightLbs)} lbs over ${projectSf} SF = ${density.toFixed(2)} lbs/SF, above 1.5× typical max (${band.max}). Likely over-counted.`,
      recommendation: 'Verify each line against drawings.',
    });
  }
  return findings;
}

/* ---------------- Spec-section absence audit ---------------- */

/**
 * If spec section X is in the project manual but no takeoff line
 * cites a category that maps to X, that's missing scope.
 */
const SPEC_TO_CATEGORY = {
  '05 12 00': ['structural_beam', 'structural_column', 'base_plate'],
  '05 21 00': ['structural_beam'],
  '05 50 00': ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing'],
  '05 51 00': ['stair'],
  '05 51 13': ['stair'],
  '05 51 33': ['ladder'],
  '05 52 00': ['handrail', 'guardrail'],
  '05 52 13': ['handrail', 'guardrail'],
  '05 53 00': ['misc_metal'],
  '05 70 00': ['misc_metal'],
  '05 73 00': ['handrail', 'guardrail'],
  '08 11 13': ['hollow_metal_frame'],
  '08 12 11': ['hollow_metal_frame'],
};

function validateSpecSectionCoverage(takeoffCategories, tcbSections) {
  const findings = [];
  const present = new Set(takeoffCategories);
  for (const sec of tcbSections || []) {
    const expected = SPEC_TO_CATEGORY[sec.section] || [];
    if (expected.length === 0) continue;
    const covered = expected.some((c) => present.has(c));
    if (!covered) {
      findings.push({
        severity: 'warning',
        category: 'spec_section_uncovered',
        finding: `Spec section ${sec.section} (${sec.label}) is in the project manual at p${sec.first_page} but no takeoff line covers it. Categories expected: ${expected.join(', ')}.`,
        recommendation: `Add a line for the items in ${sec.section}, or explicitly exclude with reason.`,
      });
    }
  }
  return findings;
}

/**
 * Run all validators against a takeoff. Returns updated lines +
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
    for (const v of [validateVerbatimQuote, validateQuantityBand, validateEtrExclusion, validateDemoNewDiscrimination, validateAssemblyPriorFloor, validateMaterialGrade, validateIndustryPriorBracket, validateCfmExclusion, validateVifAutoRfi, validateLazyAllowance, validateSheetReferences, validateRelevantPageCoverage, validateSpecSectionReference]) {
      const { findings, mutations } = v(merged, ctx);
      allFindings.push(...findings);
      Object.assign(merged, mutations || {});
    }
    return merged;
  });
  allFindings.push(...validateCrossLineConsistency(updated));
  // Run-level checks
  if (ctx.tcbSections) {
    allFindings.push(...validateSpecSectionCoverage(updated.map((l) => l.category), ctx.tcbSections));
  }
  if (ctx.totalWeightLbs && ctx.projectSf) {
    allFindings.push(...validateDensitySanity(ctx.totalWeightLbs, ctx.projectSf, ctx.buildingType || 'generic'));
  }
  if (ctx.categoryPages) {
    allFindings.push(...validatePageCoverageAtRunLevel(updated, ctx));
  }
  if (ctx.sheetDetailCounts) {
    allFindings.push(...validateMultiDetailSheetReadthrough(updated, ctx));
  }
  return { lines: updated, findings: allFindings };
}

module.exports = {
  validateLines,
  validateVerbatimQuote,
  validateQuantityBand,
  validateEtrExclusion,
  validateDemoNewDiscrimination,
  validateAssemblyPriorFloor,
  validateMaterialGrade,
  validateIndustryPriorBracket,
  validateCrossLineConsistency,
  validateCfmExclusion,
  validateVifAutoRfi,
  validateLazyAllowance,
  validateSheetReferences,
  validateRelevantPageCoverage,
  validatePageCoverageAtRunLevel,
  validateMultiDetailSheetReadthrough,
  validateSpecSectionReference,
  validateSpecSectionCoverage,
  validateDensitySanity,
  extractQuotedSpans,
};
