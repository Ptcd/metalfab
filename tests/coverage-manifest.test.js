/**
 * tests/coverage-manifest.test.js — institutional memory for the
 * coverage manifest stage.
 *
 * The manifest exists because every prior takeoff iteration found
 * something the previous one missed. Each case below is a planted
 * bomb representing a specific past failure mode. If a future change
 * silently regresses one of these protections, this test fails.
 *
 * Run:
 *   node tests/coverage-manifest.test.js
 *
 * Exits 0 if every case passes; non-zero with a list of regressions.
 */

const { buildManifest, tagSpecSection, tagPlanSheet, tagSchedule } = require('../lib/coverage');
const { validateManifestCoverage } = require('../lib/takeoff/validate');

const failures = [];
const passes = [];
function check(label, condition, detail = '') {
  if (condition) passes.push(label);
  else failures.push({ label, detail });
}

/* ============================================================
   Synthetic digest mimicking the Nestle bid failure pattern:
   - Spec book has Div 05 50 00 (Metal Fabrications) and 08 12 13
     (Hollow Metal Frames) as included scope.
   - Spec book also has 09 91 23 (Painting) and 08 71 00 (Door
     Hardware) — explicitly excluded scope (carve-outs).
   - Spec book has 10 14 23 (Panel Signage) — needs human judgment.
   - Plan set has G900-G905 sheets where G900-G902 have low text
     extraction (the original failure: classified blank, never read).
   - Plan set has S101 (structural) and A1.13 (architectural with
     door schedule).
   - Door schedule + lintel schedule both present.
   ============================================================ */

const SYNTHETIC_DIGEST = {
  documents: [
    {
      filename: 'Project_Manual.pdf',
      classification: { kind: 'specification' },
      sheets: [],
      _pages: [
        { page_number: 1,  items: [{ str: 'TABLE OF CONTENTS' }] },
        { page_number: 48, items: [{ str: 'SECTION 05 50 00 METAL FABRICATIONS' }] },
        { page_number: 87, items: [{ str: 'SECTION 08 12 13 HOLLOW METAL FRAMES' }] },
        { page_number: 92, items: [{ str: 'SECTION 08 71 00 DOOR HARDWARE' }] },
        { page_number: 98, items: [{ str: 'SECTION 09 91 23 INTERIOR PAINTING' }] },
        { page_number: 105, items: [{ str: 'SECTION 10 14 23 PANEL SIGNAGE' }] },
        { page_number: 112, items: [{ str: 'SECTION 23 00 00 HVAC' }] },
      ],
    },
    {
      filename: 'Drawings.pdf',
      classification: { kind: 'drawing' },
      sheets: [
        { page_number: 1, sheet_no: 'G900', sheet_title: 'GENERAL NOTES',           item_count: 25, has_text_layer: true,  schedules_found: 0 },
        { page_number: 2, sheet_no: 'G901', sheet_title: 'CODE ANALYSIS',           item_count: 30, has_text_layer: true,  schedules_found: 0 },
        { page_number: 3, sheet_no: 'G902', sheet_title: 'ABBREVIATIONS',           item_count: 40, has_text_layer: true,  schedules_found: 0 },
        { page_number: 4, sheet_no: 'G905', sheet_title: 'PROJECT SPECIFICATIONS',  item_count: 35, has_text_layer: true,  schedules_found: 0 },
        { page_number: 5, sheet_no: 'S101', sheet_title: 'STRUCTURAL FRAMING',      item_count: 250, has_text_layer: true, schedules_found: 0 },
        { page_number: 6, sheet_no: 'A1.13', sheet_title: 'DOOR SCHEDULE',          item_count: 400, has_text_layer: true, schedules_found: 1 },
        { page_number: 7, sheet_no: 'D101', sheet_title: 'DEMOLITION PLAN',         item_count: 80,  has_text_layer: true, schedules_found: 0 },
        { page_number: 8, sheet_no: 'M201', sheet_title: 'MECHANICAL PLAN',         item_count: 200, has_text_layer: true, schedules_found: 0 },
      ],
    },
  ],
  summary: {
    tcb_sections: [],   // intentionally empty to force enumerateSpecSections
                        // to walk per-doc text — the higher-fidelity path.
    schedules: [
      { kind: 'door_schedule',   page_number: 6, source_filename: 'Drawings.pdf', row_count: 12, headers: ['MARK', 'TYPE', 'WIDTH'] },
      { kind: 'lintel_schedule', page_number: 5, source_filename: 'Drawings.pdf', row_count: 8,  headers: ['MARK', 'SIZE', 'BEARING'] },
      { kind: 'finish_schedule', page_number: 6, source_filename: 'Drawings.pdf', row_count: 30, headers: ['ROOM', 'FINISH'] },
    ],
  },
  generated_at: new Date().toISOString(),
};

const manifest = buildManifest(SYNTHETIC_DIGEST);

/* ============================================================
   Nestle regression: combined permit set is filename-classified
   as 'drawing' but contains spec content. plan-intelligence emits
   summary.spec_section_index[]; coverage builder must consume it.
   ============================================================ */
{
  // Persisted-digest shape: no _pages (stripped on persist), only
  // summary.spec_section_index. Mimics what the API route reads
  // from Supabase after plan-intelligence saves the digest.
  const persistedDigest = {
    documents: [
      {
        filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf',
        classification: { kind: 'drawing' },   // misclassified due to filename
        sheets: [],
      },
    ],
    summary: {
      tcb_sections: [],
      spec_section_index: [
        { code: '05 50 00', title: 'METAL FABRICATIONS',  source_filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf', first_page: 48 },
        { code: '08 12 13', title: 'HOLLOW METAL FRAMES', source_filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf', first_page: 87 },
        { code: '08 71 00', title: 'DOOR HARDWARE',       source_filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf', first_page: 92 },
        { code: '09 91 23', title: 'INTERIOR PAINTING',   source_filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf', first_page: 98 },
        { code: '23 00 00', title: 'HVAC',                source_filename: '4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf', first_page: 112 },
      ],
      schedules: [],
    },
    generated_at: new Date().toISOString(),
  };
  const m = buildManifest(persistedDigest);
  const includedCodes = new Set(m.spec_sections.filter((s) => s.tag === 'included').map((s) => s.code));
  const excludedCodes = new Set(m.spec_sections.filter((s) => s.tag === 'excluded').map((s) => s.code));
  check('NESTLE-1: spec_section_index drives section enumeration even when doc is filename-classified as drawing',
    m.spec_sections.length === 5,
    `got ${m.spec_sections.length} sections`);
  check('NESTLE-1: 05 50 00 + 08 12 13 included from spec_section_index',
    includedCodes.has('05 50 00') && includedCodes.has('08 12 13'),
    `included: ${[...includedCodes].join(', ')}`);
  check('NESTLE-1: 08 71 00 + 09 91 23 + 23 00 00 excluded from spec_section_index',
    excludedCodes.has('08 71 00') && excludedCodes.has('09 91 23') && excludedCodes.has('23 00 00'),
    `excluded: ${[...excludedCodes].join(', ')}`);
}

/* ============================================================
   buildManifest cases
   ============================================================ */

// Case B-1: included spec sections from per-doc text walk
{
  const includes = manifest.spec_sections.filter((s) => s.tag === 'included');
  const codes = new Set(includes.map((s) => s.code));
  check(
    'B-1: 05 50 00 enumerated and tagged included',
    codes.has('05 50 00'),
    `included codes: ${[...codes].join(', ')}`
  );
  check(
    'B-1: 08 12 13 enumerated and tagged included',
    codes.has('08 12 13'),
    `included codes: ${[...codes].join(', ')}`
  );
}

// Case B-2: excluded spec sections get correct tag
{
  const excluded = manifest.spec_sections.filter((s) => s.tag === 'excluded');
  const codes = new Set(excluded.map((s) => s.code));
  check(
    'B-2: 08 71 00 (door hardware) tagged excluded',
    codes.has('08 71 00'),
    `excluded codes: ${[...codes].join(', ')}`
  );
  check(
    'B-2: 09 91 23 (painting) tagged excluded',
    codes.has('09 91 23'),
    `excluded codes: ${[...codes].join(', ')}`
  );
  check(
    'B-2: 23 00 00 (HVAC) tagged excluded via division-prefix rule',
    codes.has('23 00 00'),
    `excluded codes: ${[...codes].join(', ')}`
  );
}

// Case B-3: unknown sections go to needs_human_judgment with helpful reason
{
  const unresolved = manifest.spec_sections.filter((s) => s.tag === 'needs_human_judgment');
  const codes = new Set(unresolved.map((s) => s.code));
  check(
    'B-3: 10 14 23 (panel signage) flagged needs_human_judgment',
    codes.has('10 14 23'),
    `needs_human_judgment codes: ${[...codes].join(', ')}`
  );
  // Must also appear in the unresolved[] queue
  const inQueue = manifest.unresolved.find((u) => u.kind === 'spec_section' && u.ref === '10 14 23');
  check('B-3: 10 14 23 in unresolved[] queue', !!inQueue);
}

/* ============================================================
   Plan-sheet vision flags — the G900-G905 failure class.
   Sheets with thin text extraction (item_count < 80) and a default
   tag of 'included' (G-series) MUST be flagged needs_vision.
   ============================================================ */

// Case B-4: G900 (item_count=25) flagged needs_vision
{
  const g900 = manifest.plan_sheets.find((p) => p.sheet_no === 'G900');
  check('B-4: G900 present in manifest', !!g900);
  check('B-4: G900 tagged included', g900?.tag === 'included', `tag: ${g900?.tag}`);
  check(
    'B-4: G900 needs_vision=true (the original failure mode)',
    g900?.needs_vision === true,
    `needs_vision: ${g900?.needs_vision}`
  );
  check('B-4: G900 has vision_reason explaining why', !!g900?.vision_reason);
}

// Case B-5: S101 (item_count=250, ample text) does NOT need vision
{
  const s101 = manifest.plan_sheets.find((p) => p.sheet_no === 'S101');
  check('B-5: S101 tagged included (structural)', s101?.tag === 'included');
  check('B-5: S101 needs_vision=false (rich text)', s101?.needs_vision === false);
}

// Case B-6: D101 (demolition) tagged excluded
{
  const d101 = manifest.plan_sheets.find((p) => p.sheet_no === 'D101');
  check('B-6: D101 tagged excluded (demolition)', d101?.tag === 'excluded', `tag: ${d101?.tag}`);
}

// Case B-7: A1.13 (architectural) needs_human_judgment + needs_vision
{
  const a113 = manifest.plan_sheets.find((p) => p.sheet_no === 'A1.13');
  check('B-7: A1.13 tagged needs_human_judgment', a113?.tag === 'needs_human_judgment');
  check('B-7: A1.13 needs_vision=true (architectural — may carry scope)', a113?.needs_vision === true);
}

/* ============================================================
   Schedule tagging
   ============================================================ */

// Case B-8: schedules tagged correctly
{
  const door = manifest.schedules.find((s) => s.kind === 'door_schedule');
  const lintel = manifest.schedules.find((s) => s.kind === 'lintel_schedule');
  const finish = manifest.schedules.find((s) => s.kind === 'finish_schedule');
  check('B-8: door_schedule tagged included', door?.tag === 'included');
  check('B-8: lintel_schedule tagged included', lintel?.tag === 'included');
  check('B-8: finish_schedule tagged n_a', finish?.tag === 'n_a');
}

// Case B-9: expected_categories union
{
  const cats = new Set(manifest.expected_categories);
  check('B-9: expected_categories includes lintel (from 05 50 00)', cats.has('lintel'));
  check('B-9: expected_categories includes hollow_metal_frame (from 08 12 13)', cats.has('hollow_metal_frame'));
  check('B-9: expected_categories includes bollard (from 05 50 00)', cats.has('bollard'));
}

/* ============================================================
   validateManifestCoverage — the BLOCKING invariant
   ============================================================ */

const fakeLines = (sections) => sections.map((sec, i) => ({
  line_no: i + 1, category: 'lintel', source_section: sec, source_evidence: 'x', quantity: 1, quantity_unit: 'EA',
}));

// Case V-1: takeoff covers all included sections via line.source_section
//           (lenient path — no explicit manifest_reconciliation.covered)
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G901', 'G902', 'G905', 'A1.13'],
    covered: [
      { kind: 'schedule', ref: 'door_schedule',   covered_by_lines: [1] },
      { kind: 'schedule', ref: 'lintel_schedule', covered_by_lines: [1] },
    ],
    intentionally_excluded: [],
  };
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00', '08 12 13'])
  );
  const errors = findings.filter((f) => f.severity === 'error');
  check(
    'V-1: complete coverage (sections via source_section, sheets in vision_reads_completed) → no errors',
    errors.length === 0,
    `errors: ${errors.map((e) => e.finding.slice(0, 60)).join(' | ')}`
  );
}

// Case V-2: takeoff missing 08 12 13 (the Nestle HM-frame failure)
//           → manifest_coverage_missing error
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G901', 'G902', 'G905', 'A1.13'],
    covered: [
      { kind: 'schedule', ref: 'door_schedule',   covered_by_lines: [1] },
      { kind: 'schedule', ref: 'lintel_schedule', covered_by_lines: [1] },
    ],
    intentionally_excluded: [],
  };
  // Only covers 05 50 00, not 08 12 13
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00'])
  );
  const missing = findings.find(
    (f) => f.category === 'manifest_coverage_missing' && f.finding.includes('08 12 13')
  );
  check(
    'V-2: missing 08 12 13 coverage → manifest_coverage_missing error fires',
    !!missing && missing.severity === 'error',
    `findings: ${findings.map((f) => `${f.severity}/${f.category}`).join(', ')}`
  );
}

// Case V-3: needs_vision sheet not in vision_reads_completed
//           → manifest_coverage_missing error
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G905'],   // missing G901, G902, A1.13
    covered: [
      { kind: 'schedule', ref: 'door_schedule',   covered_by_lines: [1] },
      { kind: 'schedule', ref: 'lintel_schedule', covered_by_lines: [1] },
    ],
    intentionally_excluded: [],
  };
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00', '08 12 13'])
  );
  const missingG901 = findings.find(
    (f) => f.category === 'manifest_coverage_missing' && f.finding.includes('G901')
  );
  check(
    'V-3: needs_vision sheet G901 not read → manifest_coverage_missing error fires',
    !!missingG901 && missingG901.severity === 'error',
    `findings: ${findings.map((f) => `${f.severity}/${f.category}`).join(', ')}`
  );
}

// Case V-4: intentionally_excluded with empty reason
//           → manifest_coverage_missing error
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G901', 'G902', 'G905', 'A1.13'],
    covered: [
      { kind: 'schedule', ref: 'door_schedule',   covered_by_lines: [1] },
      { kind: 'schedule', ref: 'lintel_schedule', covered_by_lines: [1] },
    ],
    intentionally_excluded: [
      { kind: 'spec_section', ref: '08 12 13', reason: '' },   // empty reason
    ],
  };
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00'])
  );
  const emptyReason = findings.find(
    (f) => f.category === 'manifest_coverage_missing' && f.finding.includes('reason is too short')
  );
  check(
    'V-4: intentionally_excluded with empty reason → error fires',
    !!emptyReason,
    `findings: ${findings.map((f) => f.finding.slice(0, 80)).join(' | ')}`
  );
}

// Case V-5: intentionally_excluded with proper reason → no error
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G901', 'G902', 'G905', 'A1.13'],
    covered: [
      { kind: 'schedule', ref: 'door_schedule',   covered_by_lines: [1] },
      { kind: 'schedule', ref: 'lintel_schedule', covered_by_lines: [1] },
    ],
    intentionally_excluded: [
      { kind: 'spec_section', ref: '08 12 13', reason: 'Owner directed in Q&A response #14: HM frames furnished by owner.' },
    ],
  };
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00'])
  );
  const errors = findings.filter((f) => f.severity === 'error' && f.finding.includes('08 12 13'));
  check(
    'V-5: intentionally_excluded with substantive reason → no 08 12 13 error',
    errors.length === 0,
    `errors: ${errors.map((e) => e.finding.slice(0, 60)).join(' | ')}`
  );
}

// Case V-6: missing schedule coverage → error
{
  const reconciliation = {
    manifest_version: 'manifest-v1',
    vision_reads_completed: ['G900', 'G901', 'G902', 'G905', 'A1.13'],
    covered: [
      { kind: 'schedule', ref: 'door_schedule', covered_by_lines: [1] },
      // missing lintel_schedule
    ],
    intentionally_excluded: [],
  };
  const findings = validateManifestCoverage(
    manifest,
    { manifest_reconciliation: reconciliation },
    fakeLines(['05 50 00', '08 12 13'])
  );
  const missingSchedule = findings.find(
    (f) => f.category === 'manifest_coverage_missing' && f.finding.includes('lintel_schedule')
  );
  check(
    'V-6: lintel_schedule not covered → manifest_coverage_missing error fires',
    !!missingSchedule && missingSchedule.severity === 'error',
    `findings: ${findings.map((f) => `${f.severity}/${f.category}`).join(', ')}`
  );
}

// Case V-7: no manifest at all → backwards-compat warning, NOT an error
{
  const findings = validateManifestCoverage(null, { manifest_reconciliation: {} }, []);
  const warnings = findings.filter((f) => f.severity === 'warning');
  const errors = findings.filter((f) => f.severity === 'error');
  check(
    'V-7: missing manifest → warning, not blocking error',
    warnings.length === 1 && errors.length === 0 && warnings[0].category === 'no_coverage_manifest',
    `findings: ${findings.map((f) => `${f.severity}/${f.category}`).join(', ')}`
  );
}

/* ============================================================
   Report
   ============================================================ */

console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.label}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
  process.exit(1);
}
console.log('All coverage manifest cases passed.');
