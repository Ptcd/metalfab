/**
 * lib/proposal/nestle-bid-form.js — fill out the Nestle/Camosy GC Bid
 * Form xlsx from a TCB takeoff snapshot.
 *
 * The form is a 58-line CSI matrix the GC published. TCB only fills four
 * rows (the metals scope) and zeroes out / leaves blank the rest. The
 * generated workbook preserves the GC's exact layout so it can be
 * dropped straight into Camosy Ariba without manual reformatting.
 *
 * Pure-ish: takes structured data + the template buffer, returns the
 * filled buffer. No Supabase calls, no fs reads in production code path
 * (the API route loads the template buffer once).
 *
 * Plain CommonJS to match the test convention (tests/ directory is
 * plain Node, no ts-node dependency). Imported by both the Next.js API
 * route and the standalone test runner.
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// Cell map: 1-indexed Excel rows in the GC template. Verified against
// `1_Nestle SCH-FAC_GC Bid Form-3.xlsx` (vendored copy at
// lib/proposal/templates/nestle-gc-bid-form.xlsx).
const ROWS = {
  STRUCTURAL_STEEL: 18, // item 7,  05 10 00 — TCB primary line (carries misc metals too)
  CFM_FRAMING:      19, // item 8,  05 40 00 — TCB excludes (drywall sub)
  METAL_STAIRS:     20, // item 9,  05 51 00 — no new stair scope
  DOORS_FRAMES:     28, // item 17, 08 00 00 — TCB carries HM frames only
  COMMENCEMENT:     84,
  COMPLETION:       85,
  SF:               87,
  LABOR_FOREMAN:    91,
  LABOR_JOURNEYMAN: 92,
  LABOR_LABORER:    93,
};

const COLS = {
  ITEM:        'A',
  CSI:         'B',
  DESCRIPTION: 'C',
  QTY:         'D',
  UNIT:        'E',
  UNIT_COST:   'F',
  EXTENSION:   'G',
};

/**
 * Map a takeoff line's category to which Nestle bid form row carries it.
 * The form has no 05 50 00 (Misc Metal Fabrications) row — bollards,
 * railings, gates, lintels, embeds all roll into row 18 (05 10 00) by
 * convention, with a clarifying note added to the description. This is
 * an open RFI for Camosy.
 */
function rowForCategory(category) {
  switch (category) {
    case 'structural_beam':
    case 'structural_column':
    case 'base_plate':
    case 'shelf_angle':
    case 'lintel':
    case 'embed':
    case 'pipe_support':
    case 'misc_metal':
    case 'bollard':
    case 'guardrail':
    case 'handrail':
    case 'overhead_door_framing':
      return 'STRUCTURAL_STEEL';
    case 'hollow_metal_frame':
      return 'DOORS_FRAMES';
    case 'stair':
      return 'METAL_STAIRS';
    case 'ladder':
      return 'STRUCTURAL_STEEL'; // No standalone row; folds into structural.
    default:
      return null;
  }
}

/**
 * Write a value to a cell. Preserves an existing formula if present —
 * SheetJS keeps both `f` and `v`, and Excel will recalculate on open.
 * If the formula reads from cells we just updated, the recompute will
 * give the right answer; in the meantime the cached value (the one we
 * write here) keeps the file readable in tools that don't recompute.
 */
function setCell(ws, row, col, value, type) {
  const t = type || (typeof value === 'number' ? 'n' : 's');
  const ref = `${col}${row}`;
  const existing = ws[ref];
  const cell = { v: value, t };
  if (existing && existing.f) cell.f = existing.f; // preserve formula
  ws[ref] = cell;
}

function loadTemplate() {
  const candidates = [
    path.resolve(__dirname, 'templates', 'nestle-gc-bid-form.xlsx'),
    path.resolve(process.cwd(), 'lib', 'proposal', 'templates', 'nestle-gc-bid-form.xlsx'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p); } catch { /* try next */ }
  }
  throw new Error('Could not locate nestle-gc-bid-form.xlsx template');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Generate the filled Nestle GC Bid Form xlsx. Returns the workbook
 * buffer, ready to upload to Supabase storage / hand to the user.
 *
 * The transformation is deterministic — same input always produces the
 * same output. Pricing comes from the takeoff (already rate-carded);
 * we only allocate it across the form's CSI rows.
 *
 * @param {Object} input
 * @param {Array<{line_no:number, category:string, description:string, quantity:number|null, quantity_unit:string|null, line_total_usd:number}>} input.lines
 * @param {number} input.bid_total_usd  marked-up bid total
 * @param {number} input.subtotal_usd   pre-markup subtotal
 * @param {{foreman_per_hr:number, ironworker_per_hr:number, fab_per_hr:number}} input.rate_card
 * @param {{project_name:string, sf:number|null, substantial_completion:string|null, commencement:string|null}} input.project
 * @param {string} input.proposal_number
 * @param {string[]} input.open_rfis
 * @param {string} input.generated_at
 * @param {Buffer} [templateBuffer]  optional pre-loaded template
 * @returns {Buffer}
 */
function generateNestleBidForm(input, templateBuffer) {
  const buf = templateBuffer || loadTemplate();
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  const ws = wb.Sheets['Sheet1'];
  if (!ws) throw new Error('Template missing Sheet1');

  // Allocate marked-up bid total across the form rows by category.
  const markup = input.subtotal_usd > 0 ? input.bid_total_usd / input.subtotal_usd : 1;
  const buckets = {
    STRUCTURAL_STEEL: { count: 0, lf: 0, ea: 0, total: 0 },
    DOORS_FRAMES:     { count: 0, lf: 0, ea: 0, total: 0 },
    METAL_STAIRS:     { count: 0, lf: 0, ea: 0, total: 0 },
  };

  for (const line of input.lines || []) {
    const target = rowForCategory(line.category);
    if (!target || !buckets[target]) continue;
    const b = buckets[target];
    b.count += 1;
    b.total += (line.line_total_usd || 0) * markup;
    if (line.quantity_unit === 'LF') b.lf += line.quantity || 0;
    if (line.quantity_unit === 'EA') b.ea += line.quantity || 0;
  }

  // Row 18 (05 10 00) — TCB primary catch-all
  const ss = buckets.STRUCTURAL_STEEL;
  if (ss.count > 0) {
    setCell(ws, ROWS.STRUCTURAL_STEEL, COLS.QTY, 1, 'n');
    setCell(ws, ROWS.STRUCTURAL_STEEL, COLS.UNIT, 'LS');
    setCell(ws, ROWS.STRUCTURAL_STEEL, COLS.UNIT_COST, round2(ss.total), 'n');
    setCell(ws, ROWS.STRUCTURAL_STEEL, COLS.EXTENSION, round2(ss.total), 'n');
    setCell(
      ws,
      ROWS.STRUCTURAL_STEEL,
      COLS.DESCRIPTION,
      'Structural Steel & Misc Metals (TCB scope) - includes structural beams, base plates, bollards, railings, gates per takeoff. RFI to GC: form has no 05 50 00 row; misc metals (bollards/rails/gate) currently grouped here. Confirm acceptable or relocate to alternates.',
    );
  }

  // Row 19 (05 40 00 CFM) — explicitly $0
  setCell(ws, ROWS.CFM_FRAMING, COLS.QTY, 0, 'n');
  setCell(ws, ROWS.CFM_FRAMING, COLS.UNIT, 'LS');
  setCell(ws, ROWS.CFM_FRAMING, COLS.UNIT_COST, 0, 'n');
  setCell(ws, ROWS.CFM_FRAMING, COLS.EXTENSION, 0, 'n');
  setCell(
    ws,
    ROWS.CFM_FRAMING,
    COLS.DESCRIPTION,
    "Cold-Formed Metal Framing - by drywall sub. Per S101 'TYPICAL HVAC RTU FRAME' detail: '800S162-68 STUDS' + 'G.C. TO COORDINATE WITH MECH. CONTRACTOR'. Excluded from TCB scope.",
  );

  // Row 20 (05 51 00 Metal Stairs) — explicitly $0
  setCell(ws, ROWS.METAL_STAIRS, COLS.QTY, 0, 'n');
  setCell(ws, ROWS.METAL_STAIRS, COLS.UNIT, 'LS');
  setCell(ws, ROWS.METAL_STAIRS, COLS.UNIT_COST, 0, 'n');
  setCell(ws, ROWS.METAL_STAIRS, COLS.EXTENSION, 0, 'n');
  setCell(
    ws,
    ROWS.METAL_STAIRS,
    COLS.DESCRIPTION,
    'Metal Stairs - no new metal stair scope identified in package. Existing stairs near locker rooms are ETR. $0 carried.',
  );

  // Row 28 (08 00 00 Doors/Frames) — HM only
  const df = buckets.DOORS_FRAMES;
  if (df.count > 0) {
    setCell(ws, ROWS.DOORS_FRAMES, COLS.QTY, df.ea > 0 ? df.ea : 1, 'n');
    setCell(ws, ROWS.DOORS_FRAMES, COLS.UNIT, df.ea > 0 ? 'EA' : 'LS');
    setCell(ws, ROWS.DOORS_FRAMES, COLS.UNIT_COST, df.ea > 0 ? round2(df.total / df.ea) : round2(df.total), 'n');
    setCell(ws, ROWS.DOORS_FRAMES, COLS.EXTENSION, round2(df.total), 'n');
    setCell(
      ws,
      ROWS.DOORS_FRAMES,
      COLS.DESCRIPTION,
      `Hollow Metal Frames only (TCB scope) - ${df.ea} HM door frames. Doors, hardware, glass, aluminum frames, and all 08 43 00 / 08 50 00 / 08 56 59 items by others. RFI to confirm Camosy accepts split.`,
    );
  }

  // Contract Time & Logistics
  if (input.project) {
    if (input.project.commencement) setCell(ws, ROWS.COMMENCEMENT, 'D', input.project.commencement);
    if (input.project.substantial_completion) setCell(ws, ROWS.COMPLETION, 'D', input.project.substantial_completion);
    if (input.project.sf != null) {
      setCell(ws, ROWS.SF, 'D', input.project.sf, 'n');
      setCell(ws, ROWS.SF, 'E', 'SF');
    }
  }

  // Labor Rates By Position. Map TCB rates to GC's Foreman/Journeyman/
  // Laborer expectation (closest equivalents). OT = 1.5× per industry.
  const rc = input.rate_card || {};
  const foreman = round2(rc.foreman_per_hr || 0);
  const journeyman = round2(rc.ironworker_per_hr || 0);
  const laborer = round2(rc.fab_per_hr || 0);
  setCell(ws, ROWS.LABOR_FOREMAN, 'D', foreman, 'n');
  setCell(ws, ROWS.LABOR_FOREMAN, 'E', round2(foreman * 1.5), 'n');
  setCell(ws, ROWS.LABOR_JOURNEYMAN, 'D', journeyman, 'n');
  setCell(ws, ROWS.LABOR_JOURNEYMAN, 'E', round2(journeyman * 1.5), 'n');
  setCell(ws, ROWS.LABOR_LABORER, 'D', laborer, 'n');
  setCell(ws, ROWS.LABOR_LABORER, 'E', round2(laborer * 1.5), 'n');

  // Pre-populate the cached values for the SUBTOTAL formulas so any
  // tool that doesn't auto-recalculate (older viewers, ePub renders,
  // some preview UIs) shows the right number. Excel will recalculate on
  // open and arrive at the same result either way.
  const lineSubtotal = ss.total + (buckets.METAL_STAIRS.total || 0); // CFM and DOORS_FRAMES are in different sub-totals
  const otherSubtotal = 0; // rows 58-67 are GC costs, all $0
  const specialSubtotal = 0; // rows 69-71 special breakouts, all $0
  // Sub-Total Construction Costs (G57) = SUBTOTAL of G12:G56
  // = ss.total (row 18) + 0s + 0s + 0s + ... + df.total (row 28)
  const constructionSubtotal = round2(ss.total + df.total);
  if (ws['G57']) ws['G57'].v = constructionSubtotal;
  // Sub-Total Other Costs (G68) — all 0
  if (ws['G68']) ws['G68'].v = otherSubtotal;
  // Sub-Total Special Breakouts (G72) — all 0
  if (ws['G72']) ws['G72'].v = specialSubtotal;
  // TOTAL CONSTRUCTION BID (G73)
  if (ws['G73']) ws['G73'].v = round2(constructionSubtotal + otherSubtotal + specialSubtotal);

  // Embed traceability marker so the source can be tied back to a
  // specific TCB run when Camosy emails follow-up questions.
  if (input.proposal_number) {
    const dateStr = (input.generated_at || new Date().toISOString()).slice(0, 10);
    setCell(ws, 11, 'L', `TCB ${input.proposal_number} - generated ${dateStr}`);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  generateNestleBidForm,
  rowForCategory,
  ROWS,
  COLS,
};
