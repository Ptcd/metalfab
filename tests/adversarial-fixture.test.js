/**
 * tests/adversarial-fixture.test.js — institutional memory in test form.
 *
 * Each case is a planted bomb: a takeoff line crafted to defeat exactly
 * one of the system's reliability checks. The test asserts the right
 * validator catches it. If a future change silently breaks one of these
 * protections, this test fails and the PR cannot merge.
 *
 * Run:
 *   node tests/adversarial-fixture.test.js
 *
 * Exits 0 if every case is caught; non-zero with a list of regressions
 * otherwise. CI runs it on every PR.
 */

const { validateLines } = require('../lib/takeoff/validate');
const { computeConfidence } = require('../lib/takeoff/confidence');
const { crossCheckTakeoffCategories } = require('../lib/plan-intelligence/parse-bid-form');

const failures = [];
const passes = [];
function check(label, condition, detail = '') {
  if (condition) passes.push(label);
  else failures.push({ label, detail });
}

// Synthetic "extracted text" — what the package actually contains.
// Anything cited that's not in here is a fabricated quote.
const FIXTURE_PACKAGE_TEXT = `
SECTION 05 50 00 METAL FABRICATIONS
1.01 SUMMARY: Provide loose lintels, pipe bollards, shelf and relieving angles,
structural steel overhead door frames, steel plates embedded in concrete walls.
2.06 LOOSE STEEL LINTELS: Fabricate from steel angles ASTM A36, hot-dip galvanized
per ASTM A123. 1" bearing per foot of clear span minimum 8" each side.
DRAWING S101 — STRUCTURAL FRAMING PLAN
W10X68 T/STL EL +10'-2" CENTER TO CENTER OF EXIST. COL. 12'-0" V.I.F.
BRG. PLATE 7" X 10" X 3/4" THK
DOOR SCHEDULE — Room 103 EMPLOYEE ENTRY F1 HM PTD 3'-0" 7'-0"
Room 124 QA LAB ETR (existing to remain)
DEMOLITION PLAN D101 — remove existing partition wall.
`;

const INDUSTRY_PRIORS = [
  { category: 'lintel', building_type: 'small_commercial_renovation',
    qty_min: 4, qty_typical: 8, qty_max: 12, qty_unit: 'EA',
    fab_hrs_per_unit_min: 0.5, fab_hrs_per_unit_typ: 1.0, fab_hrs_per_unit_max: 2.0,
    ironworker_hrs_per_unit_min: 1.0, ironworker_hrs_per_unit_typ: 2.0, ironworker_hrs_per_unit_max: 3.5 },
  { category: 'hollow_metal_frame', building_type: 'small_commercial_renovation',
    qty_min: 4, qty_typical: 12, qty_max: 30, qty_unit: 'EA',
    fab_hrs_per_unit_min: 0.5, fab_hrs_per_unit_typ: 1.0, fab_hrs_per_unit_max: 1.5,
    ironworker_hrs_per_unit_min: 1.5, ironworker_hrs_per_unit_typ: 2.0, ironworker_hrs_per_unit_max: 3.0 },
];

const ASSEMBLY_PRIORS = [
  { assembly_type: 'lintel_set', size_band: 'medium',
    fab_hrs_expected: 32, ironworker_hrs_expected: 64, sample_count: 1, total_weight_lbs: 1116 },
];

const VALIDATOR_CTX = {
  fullText: FIXTURE_PACKAGE_TEXT,
  scheduleCounts: { hollow_metal_frame: 7 },
  priors: ASSEMBLY_PRIORS,
  industryPriors: INDUSTRY_PRIORS,
  buildingType: 'small_commercial_renovation',
};

/* ============================================================
   Case 1: Fabricated quote
   The line cites a quote that doesn't exist in the package text.
   Expectation: validateVerbatimQuote fires 'fabricated_quote' error.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'lintel', source_kind: 'spec',
    source_evidence: 'Section 99 99 99: provide quantum-fluctuating lintel beams at all moonbeam openings. Custom alloy required.',
    quantity: 5, quantity_unit: 'EA', quantity_band: 'point',
    fab_hrs: 5, ironworker_hrs: 10, material_grade: 'A36',
    steel_shape_designation: 'L4x4x3/8', flagged_for_review: false,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 1: fabricated_quote detected',
    r.findings.some((f) => f.category === 'fabricated_quote'),
    `findings: ${r.findings.map(f=>f.category).join(', ') || '(none)'}`);
}

/* ============================================================
   Case 2: Unanchored point quantity
   'point' claimed without a schedule row or dimensional anchor.
   Expectation: auto-downgrade to 'range' + warning.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'lintel', source_kind: 'spec',
    source_evidence: 'Provide loose lintels at masonry openings per spec section 05 50 00',
    quantity: 6, quantity_unit: 'EA', quantity_band: 'point',
    fab_hrs: 6, ironworker_hrs: 12, material_grade: 'A36',
    steel_shape_designation: 'L4x4x3/8', flagged_for_review: false,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 2: unanchored_point_quantity detected',
    r.findings.some((f) => f.category === 'unanchored_point_quantity'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
  check('Case 2: quantity_band auto-downgraded',
    r.lines[0].quantity_band === 'range',
    `band: ${r.lines[0].quantity_band}`);
}

/* ============================================================
   Case 3: ETR / existing-to-remain item
   Line cites a row marked ETR.
   Expectation: validateEtrExclusion fires + line marked out-of-scope.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'hollow_metal_frame', source_kind: 'drawing',
    source_evidence: 'Room 124 QA LAB ETR (existing to remain) HM frame',
    quantity: 1, quantity_unit: 'EA', quantity_band: 'point',
    fab_hrs: 1, ironworker_hrs: 2, finish: 'shop_primer',
    flagged_for_review: false, in_tcb_scope: true,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 3: etr_in_scope detected',
    r.findings.some((f) => f.category === 'etr_in_scope'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
  check('Case 3: line auto-flagged out of TCB scope',
    r.lines[0].in_tcb_scope === false || r.lines[0].flagged_for_review === true);
}

/* ============================================================
   Case 4: Demolition-sheet citation
   Source section is D-series sheet (D101). Demo isn't TCB scope.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'misc_metal', source_kind: 'drawing',
    source_section: 'D101', source_evidence: 'remove existing partition wall',
    quantity: 1, quantity_unit: 'LS', quantity_band: 'assumed_typical',
    fab_hrs: 4, ironworker_hrs: 4, flagged_for_review: false,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 4: D-series demolition sheet detected',
    r.findings.some((f) => f.category === 'etr_in_scope'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
}

/* ============================================================
   Case 5: Material grade mismatch
   W-shape claimed with A36 grade (should be A992 or A572).
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'structural_beam', source_kind: 'drawing',
    source_evidence: 'W10X68 T/STL EL +10\'-2"',
    quantity: 12, quantity_unit: 'LF', quantity_band: 'point',
    fab_hrs: 8, ironworker_hrs: 14, material_grade: 'A36',
    steel_shape_designation: 'W10x68', flagged_for_review: false,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 5: material_grade_mismatch detected',
    r.findings.some((f) => f.category === 'material_grade_mismatch'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
}

/* ============================================================
   Case 6: Quantity above industry-typical max
   50 lintels claimed for a renovation — typical max is 12.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'lintel', source_kind: 'spec',
    source_evidence: 'Section 05 50 00: Provide loose lintels at masonry openings',
    quantity: 50, quantity_unit: 'EA', quantity_band: 'assumed_typical',
    fab_hrs: 25, ironworker_hrs: 50, material_grade: 'A36',
    steel_shape_designation: 'L4x4x3/8', flagged_for_review: false,
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 6: qty_above_industry_typical detected',
    r.findings.some((f) => f.category === 'qty_above_industry_typical'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
}

/* ============================================================
   Case 7: Bid-form scope envelope (cross-check)
   Takeoff has a 'lintel' category but the GC bid form lists no
   05 50 00 line.
   ============================================================ */
{
  const csiCodes = [
    { code: '05 10 00' }, { code: '05 40 00' }, { code: '05 51 00' }, { code: '08 00 00' },
  ];
  const result = crossCheckTakeoffCategories(['lintel', 'hollow_metal_frame', 'structural_beam'], csiCodes);
  check('Case 7: phantom lintel detected against bid form',
    result.phantom.includes('lintel'),
    `phantom: ${result.phantom.join(', ') || '(none)'}`);
  check('Case 7: hollow_metal_frame allowed (08 00 00 covers it)',
    !result.phantom.includes('hollow_metal_frame'));
  check('Case 7: structural_beam allowed (05 10 00 covers it)',
    !result.phantom.includes('structural_beam'));
}

/* ============================================================
   Case 8: Confidence formula sanity
   A schedule-sourced point line at 1 corroborating source
   should compute confidence > 0.85.
   ============================================================ */
{
  const conf = computeConfidence({
    source_kind: 'drawing',
    quantity_band: 'point',
    quantity: 7, quantity_min: 7, quantity_max: 7,
    from_schedule: true,
  });
  check('Case 8: schedule-sourced point line has confidence ≥ 0.90',
    conf >= 0.90,
    `confidence: ${conf}`);

  // Conversely, an assumption-only line should land between 0.30-0.50
  const lowConf = computeConfidence({
    source_kind: 'assumption',
    quantity_band: 'assumed_typical',
    quantity: 8, quantity_min: 4, quantity_max: 12,
  });
  check('Case 8: assumption-only line has confidence ≤ 0.55',
    lowConf <= 0.55,
    `confidence: ${lowConf}`);
}

/* ============================================================
   Case 9: Cross-line duplicate without differentiation
   Two 'lintel' lines without F1/F2/type-marker differentiation.
   ============================================================ */
{
  const lines = [
    { line_no: 1, category: 'lintel', source_kind: 'spec',
      source_evidence: 'Section 05 50 00: Provide loose lintels',
      quantity: 4, quantity_unit: 'EA', quantity_band: 'assumed_typical',
      fab_hrs: 4, ironworker_hrs: 8, description: 'Loose lintels', material_grade: 'A36',
      steel_shape_designation: 'L4x4x3/8' },
    { line_no: 2, category: 'lintel', source_kind: 'spec',
      source_evidence: 'Section 05 50 00: Provide loose lintels',
      quantity: 3, quantity_unit: 'EA', quantity_band: 'assumed_typical',
      fab_hrs: 3, ironworker_hrs: 6, description: 'Loose lintels', material_grade: 'A36',
      steel_shape_designation: 'L4x4x3/8' },
  ];
  const r = validateLines(lines, VALIDATOR_CTX);
  check('Case 9: cross_line_overlap detected',
    r.findings.some((f) => f.category === 'cross_line_overlap'),
    `findings: ${r.findings.map(f=>f.category).join(', ')}`);
}

/* ============================================================
   Negative case: a clean, well-cited line should produce ZERO
   reliability findings. Catches false-positives in the validators.
   ============================================================ */
{
  const lines = [{
    line_no: 1, category: 'structural_beam', source_kind: 'drawing',
    source_section: 'S101',
    source_evidence: 'W10X68 T/STL EL +10\'-2" CENTER TO CENTER OF EXIST. COL. 12\'-0"',
    quantity: 12, quantity_unit: 'LF', quantity_band: 'point',
    quantity_min: 11, quantity_max: 14,
    fab_hrs: 8, ironworker_hrs: 14, material_grade: 'A992',
    steel_shape_designation: 'W10x68', flagged_for_review: false, description: 'W10x68 RTU beam',
  }];
  const r = validateLines(lines, VALIDATOR_CTX);
  const realFindings = r.findings.filter((f) => f.severity === 'error' || f.severity === 'warning');
  check('Negative case: clean line produces zero error/warning findings',
    realFindings.length === 0,
    `unexpected findings: ${realFindings.map(f=>f.category).join(', ') || '(none)'}`);
}

/* ============================================================
   Report
   ============================================================ */
console.log(`\n${passes.length} passed`);
for (const p of passes) console.log(`  ✓ ${p}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.label}\n    ${f.detail}`);
  process.exit(1);
}
console.log('\n✓ All adversarial cases caught.');
