/**
 * tests/nestle-bid-form.test.js — verify the Nestle GC Bid Form Excel
 * auto-fill transformer.
 *
 * Plain-Node smoke test (matches the rest of tests/). Run:
 *   node tests/nestle-bid-form.test.js
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { generateNestleBidForm } = require('../lib/proposal/nestle-bid-form');

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    process.exitCode = 1;
  }
}

function getCell(ws, row, col) {
  return ws[`${col}${row}`];
}

function nearly(a, b, tol = 1) {
  return Math.abs(a - b) <= tol;
}

console.log('Nestle bid form generator');

// Synthetic input that mirrors the real Nestle takeoff shape.
const input = {
  lines: [
    { line_no: 1, category: 'structural_beam', description: 'W10x68 RTU beam', quantity: 12, quantity_unit: 'LF', line_total_usd: 6695.20 },
    { line_no: 2, category: 'base_plate', description: '4 EA base plates', quantity: 4, quantity_unit: 'EA', line_total_usd: 1006.12 },
    { line_no: 3, category: 'hollow_metal_frame', description: '8 HM frames', quantity: 8, quantity_unit: 'EA', line_total_usd: 4433.00 },
    { line_no: 4, category: 'bollard', description: '12 Sch 80 bollards', quantity: 12, quantity_unit: 'EA', line_total_usd: 7945.40 },
    { line_no: 5, category: 'guardrail', description: 'Receiving Dock 130 rail+gate', quantity: 1, quantity_unit: 'EA', line_total_usd: 4870.00 },
    { line_no: 6, category: 'handrail', description: '38 LF wall handrail', quantity: 38, quantity_unit: 'LF', line_total_usd: 3727.39 },
  ],
  bid_total_usd: 40248.85,
  subtotal_usd: 28677.11, // sum of the 6 lines
  rate_card: {
    foreman_per_hr: 100,
    ironworker_per_hr: 100,
    fab_per_hr: 100,
  },
  project: {
    project_name: 'Nestle Schaumburg',
    sf: 5000,
    substantial_completion: '2026-12-18',
    commencement: '2026-06-29',
  },
  proposal_number: 'TCB-2026-0001',
  open_rfis: [],
  generated_at: '2026-05-03T01:00:00.000Z',
};

const buf = generateNestleBidForm(input);
check('returned a buffer', Buffer.isBuffer(buf), `got ${typeof buf}`);
check('buffer is non-trivial size', buf.length > 50_000, `got ${buf.length} bytes`);

// Re-parse the output and assert cells are filled.
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets['Sheet1'];

// Row 18 — 05 10 00 Structural Steel — gets bulk of TCB scope
const r18Ext = getCell(ws, 18, 'G');
const r18Qty = getCell(ws, 18, 'D');
const r18Unit = getCell(ws, 18, 'E');
check('row 18 (05 10 00) extension > 0', r18Ext?.v > 0, `got ${r18Ext?.v}`);
check('row 18 unit is LS', r18Unit?.v === 'LS', `got ${r18Unit?.v}`);
check('row 18 qty is 1', r18Qty?.v === 1);

// Row 19 — 05 40 00 CFM — explicitly $0
const r19Ext = getCell(ws, 19, 'G');
check('row 19 (05 40 00 CFM) extension is $0', r19Ext?.v === 0, `got ${r19Ext?.v}`);

// Row 20 — 05 51 00 Metal Stairs — explicitly $0
const r20Ext = getCell(ws, 20, 'G');
check('row 20 (05 51 00 Stairs) extension is $0', r20Ext?.v === 0, `got ${r20Ext?.v}`);

// Row 28 — 08 00 00 Doors/Frames — HM portion
const r28Ext = getCell(ws, 28, 'G');
const r28Qty = getCell(ws, 28, 'D');
check('row 28 (08 00 00) extension > 0', r28Ext?.v > 0, `got ${r28Ext?.v}`);
check('row 28 qty matches 8 HM frames', r28Qty?.v === 8, `got ${r28Qty?.v}`);

// Sum of TCB rows should be ≈ bid_total_usd
const totalTcb = (r18Ext?.v ?? 0) + (r19Ext?.v ?? 0) + (r20Ext?.v ?? 0) + (r28Ext?.v ?? 0);
check(
  'sum of TCB rows ≈ bid_total_usd within $5',
  nearly(totalTcb, input.bid_total_usd, 5),
  `sum=${totalTcb} expected=${input.bid_total_usd}`,
);

// Row 21 (next CSI line, 06 00 00 Wood) untouched — no TCB scope
const r21Ext = getCell(ws, 21, 'G');
check('row 21 (06 00 00 Wood) untouched at $0', r21Ext?.v === 0, `got ${r21Ext?.v}`);

// Labor rates filled
const r91 = getCell(ws, 91, 'D');
const r92 = getCell(ws, 92, 'D');
const r93 = getCell(ws, 93, 'D');
check('Foreman rate set', r91?.v === 100);
check('Journeyman rate set', r92?.v === 100);
check('Laborer rate set', r93?.v === 100);

// OT rates = 1.5× straight time
const r91ot = getCell(ws, 91, 'E');
check('Foreman OT = 1.5× ST', r91ot?.v === 150);

// Square Feet
const r87 = getCell(ws, 87, 'D');
check('SF = 5000', r87?.v === 5000);

// Substantial Completion
const r85 = getCell(ws, 85, 'D');
check('Substantial Completion set', !!r85?.v);

// Empty input (zero lines) — should still produce a valid workbook
const empty = generateNestleBidForm({
  ...input,
  lines: [],
  bid_total_usd: 0,
  subtotal_usd: 0,
});
check('handles empty input without throwing', Buffer.isBuffer(empty));

// Proposal number trace marker on row 11 column L
const r11L = getCell(ws, 11, 'L');
check('proposal-number trace marker present', String(r11L?.v ?? '').includes('TCB-2026-0001'));

if (process.exitCode) {
  console.error('\n✗ Some assertions failed.');
  process.exit(1);
}
console.log('\n✓ All assertions passed.');
