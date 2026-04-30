#!/usr/bin/env node
/**
 * takeoff-commit.js — read ./takeoff-queue/<opp_id>/takeoff.json,
 * apply the rate card deterministically, persist to takeoff_runs +
 * takeoff_lines.
 *
 * The Claude Code session writes scope, quantity, weight, and labor
 * hours per line. This script computes material/labor/finish/line
 * costs and the bid roll-up using the rate card values — keeping
 * pricing math out of the LLM hands.
 *
 * Usage:
 *   node scripts/takeoff-commit.js --opp=<opportunity_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { computeConfidence } = require('../lib/takeoff/confidence');
const { crossCheckTakeoffCategories } = require('../lib/plan-intelligence/parse-bid-form');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_DIR = path.join(__dirname, '..', 'takeoff-queue');

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { opp: null };
  for (const a of args) {
    const m = a.match(/^--opp=(.+)$/);
    if (m) out.opp = m[1];
  }
  return out;
}

const VALID_CATEGORIES = new Set([
  'lintel', 'pipe_support', 'hollow_metal_frame', 'bollard', 'embed',
  'stair', 'handrail', 'guardrail', 'ladder', 'misc_metal',
  'structural_beam', 'structural_column', 'base_plate', 'shelf_angle',
  'overhead_door_framing', 'other',
]);

const VALID_FINISHES = new Set(['galvanized', 'shop_primer', 'powder_coat', 'none', null]);

function validateLine(line, idx) {
  const errors = [];
  if (!line.category || !VALID_CATEGORIES.has(line.category)) {
    errors.push(`line ${idx}: invalid category "${line.category}"`);
  }
  if (typeof line.quantity !== 'number' || line.quantity < 0) {
    errors.push(`line ${idx}: quantity must be a non-negative number`);
  }
  if (!line.quantity_unit) {
    errors.push(`line ${idx}: quantity_unit required`);
  }
  if (!line.source_kind) {
    errors.push(`line ${idx}: source_kind required`);
  }
  if (!line.source_evidence) {
    errors.push(`line ${idx}: source_evidence required (cite the spec/Q&A/sheet text)`);
  }
  if (line.confidence === undefined || line.confidence < 0 || line.confidence > 1) {
    errors.push(`line ${idx}: confidence must be between 0 and 1`);
  }
  if (line.finish !== undefined && !VALID_FINISHES.has(line.finish)) {
    errors.push(`line ${idx}: invalid finish "${line.finish}"`);
  }
  return errors;
}

function priceLine(line, rate, shapesByDesignation) {
  // Resolve unit weight from catalog if line names a steel shape but
  // didn't fill in unit_weight directly.
  let unitWeight = line.unit_weight;
  let unitWeightUnit = line.unit_weight_unit;
  let steelShapeId = null;
  if (line.steel_shape_designation) {
    const shape = shapesByDesignation.get(line.steel_shape_designation);
    if (shape) {
      steelShapeId = shape.id;
      if (unitWeight == null) unitWeight = Number(shape.unit_weight);
      if (!unitWeightUnit) unitWeightUnit = shape.unit;
    }
  }

  // Total weight (Claude can pre-compute, but recompute here as
  // ground truth — drops dependency on the model getting math right).
  let totalWeight = null;
  if (unitWeight != null && line.quantity != null) {
    const qty = Number(line.quantity);
    const uw = Number(unitWeight);
    if (unitWeightUnit === 'lb/ft' && (line.quantity_unit === 'LF' || line.quantity_unit === 'FT')) {
      totalWeight = qty * uw;
    } else if (unitWeightUnit === 'lb/ea' && line.quantity_unit === 'EA') {
      totalWeight = qty * uw;
    } else if (line.quantity_unit === 'LBS') {
      totalWeight = qty;
    } else if (unitWeight && line.quantity != null) {
      // Best-effort fallthrough: use prior or LLM-supplied total_weight_lbs
      totalWeight = Number(line.total_weight_lbs ?? qty * uw);
    }
    if (totalWeight != null) {
      totalWeight = totalWeight * (1 + Number(rate.waste_factor || 0));
    }
  } else if (line.total_weight_lbs != null) {
    totalWeight = Number(line.total_weight_lbs) * (1 + Number(rate.waste_factor || 0));
  }

  // Material cost
  const materialRate =
    line.material_grade && /STAINLESS|316|304/i.test(line.material_grade)
      ? Number(rate.stainless_per_lb)
      : Number(rate.steel_per_lb);
  const materialCost = totalWeight != null ? totalWeight * materialRate : null;

  // Labor cost — sum the categorized hours × their rates
  const labor =
    (Number(line.fab_hrs || 0) * Number(rate.fab_per_hr)) +
    (Number(line.det_hrs || 0) * Number(rate.det_per_hr)) +
    (Number(line.foreman_hrs || 0) * Number(rate.foreman_per_hr)) +
    (Number(line.ironworker_hrs || 0) * Number(rate.ironworker_per_hr));

  // Finish cost
  let finishCost = 0;
  if (totalWeight != null) {
    if (line.finish === 'galvanized') {
      finishCost = totalWeight * Number(rate.galv_per_lb);
    } else if (line.finish === 'shop_primer' || line.finish === 'powder_coat') {
      // Fall back to the legacy paint_factor on material cost when no
      // surface area is provided.
      finishCost = (line.finish_surface_sf
        ? Number(line.finish_surface_sf)  // SF basis would need a $/SF rate; deferred
        : (materialCost || 0) * Number(rate.paint_factor));
    }
  }

  const lineTotal = (materialCost || 0) + labor + finishCost;

  return {
    steel_shape_id: steelShapeId,
    unit_weight: unitWeight ?? null,
    unit_weight_unit: unitWeightUnit ?? null,
    total_weight_lbs: totalWeight ?? null,
    material_cost_usd: materialCost ?? null,
    labor_cost_usd: labor || null,
    finish_cost_usd: finishCost || null,
    line_total_usd: lineTotal || null,
  };
}

function summarize(lines, rate) {
  const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
  const totalWeight = sum('total_weight_lbs');
  const totalFab = sum('fab_hrs');
  const totalDet = sum('det_hrs');
  const totalForeman = sum('foreman_hrs');
  const totalIron = sum('ironworker_hrs');
  const matSub = sum('material_cost_usd');
  const labSub = sum('labor_cost_usd');
  const finSub = sum('finish_cost_usd');

  const fixed = Number(rate.delivery_flat || 0) + Number(rate.equipment_flat || 0);
  const subBeforeRollup = matSub + labSub + finSub + fixed;
  const salesTax = subBeforeRollup * Number(rate.sales_tax || 0);
  const subtotal = subBeforeRollup + salesTax;
  const overhead = subtotal * Number(rate.overhead || 0);
  const profit = (subtotal + overhead) * Number(rate.profit || 0);
  const bid = subtotal + overhead + profit;
  const bidWithBond = bid * (1 + Number(rate.bond_default || 0));

  const flagged = lines.filter((l) => l.flagged_for_review).length;
  const confSum = lines.reduce((a, l) => a + Number(l.confidence || 0), 0);

  return {
    total_weight_lbs: totalWeight,
    total_fab_hrs: totalFab,
    total_det_hrs: totalDet,
    total_foreman_hrs: totalForeman,
    total_ironworker_hrs: totalIron,
    material_subtotal_usd: matSub,
    labor_subtotal_usd: labSub,
    finish_subtotal_usd: finSub,
    fixed_costs_usd: fixed,
    subtotal_usd: subtotal,
    overhead_usd: overhead,
    profit_usd: profit,
    bid_total_usd: bidWithBond,
    confidence_avg: lines.length ? confSum / lines.length : 0,
    flagged_lines_count: flagged,
  };
}

async function main() {
  const args = parseArgs();
  if (!args.opp) {
    console.error('usage: node scripts/takeoff-commit.js --opp=<opportunity_id>');
    process.exit(1);
  }

  const oppDir = path.join(QUEUE_DIR, args.opp);
  const takeoffPath = path.join(oppDir, 'takeoff.json');
  if (!fs.existsSync(takeoffPath)) {
    console.error(`takeoff.json not found at ${takeoffPath}`);
    console.error('Run scripts/takeoff-prepare.js then the Claude Code session first.');
    process.exit(1);
  }

  const takeoff = JSON.parse(fs.readFileSync(takeoffPath, 'utf8'));
  const lines = Array.isArray(takeoff.lines) ? takeoff.lines : [];

  // Validation
  const errors = [];
  lines.forEach((l, i) => errors.push(...validateLine(l, i + 1)));
  if (errors.length) {
    console.error('Validation errors:');
    errors.forEach((e) => console.error('  -', e));
    process.exit(1);
  }

  // Load context.json (for stage + rate card pointer)
  const context = JSON.parse(fs.readFileSync(path.join(oppDir, 'context.json'), 'utf8'));
  const rate = context.rate_card;
  const shapesByDesignation = new Map((context.steel_shapes || []).map((s) => [s.designation, s]));
  // We'll need shape id, but the staged context doesn't include it. Pull from DB.
  const shapesRes = await fetch(`${SUPABASE_URL}/rest/v1/steel_shapes?select=id,designation,unit_weight,unit&limit=1000`, { headers: headers() });
  const shapesFull = await shapesRes.json();
  const shapesById = new Map(shapesFull.map((s) => [s.designation, s]));

  // Price every line + carry through the LLM-supplied fields
  const enrichedLines = lines.map((l, i) => {
    const priced = priceLine(l, rate, shapesById);
    return {
      line_no: l.line_no || (i + 1),
      category: l.category,
      description: l.description,
      in_tcb_scope: l.in_tcb_scope !== false,
      assembly_type: l.assembly_type || null,
      source_kind: l.source_kind,
      source_filename: l.source_filename || null,
      source_section: l.source_section || null,
      source_page: l.source_page ?? null,
      source_evidence: l.source_evidence,
      quantity: Number(l.quantity),
      quantity_unit: l.quantity_unit,
      quantity_band: l.quantity_band || 'point',
      quantity_min: l.quantity_min ?? null,
      quantity_max: l.quantity_max ?? null,
      steel_shape_id: priced.steel_shape_id,
      steel_shape_designation: l.steel_shape_designation || null,
      unit_weight: priced.unit_weight,
      unit_weight_unit: priced.unit_weight_unit,
      total_weight_lbs: priced.total_weight_lbs,
      material_grade: l.material_grade || null,
      fab_hrs: l.fab_hrs ?? null,
      det_hrs: l.det_hrs ?? null,
      foreman_hrs: l.foreman_hrs ?? null,
      ironworker_hrs: l.ironworker_hrs ?? null,
      finish: l.finish || null,
      finish_surface_sf: l.finish_surface_sf ?? null,
      finish_cost_usd: priced.finish_cost_usd,
      material_cost_usd: priced.material_cost_usd,
      labor_cost_usd: priced.labor_cost_usd,
      line_total_usd: priced.line_total_usd,
      confidence: computeConfidence({
        source_kind: l.source_kind,
        source_section: l.source_section,
        source_page: l.source_page,
        source_evidence: l.source_evidence,
        quantity_band: l.quantity_band,
        quantity_min: l.quantity_min,
        quantity_max: l.quantity_max,
        quantity: Number(l.quantity),
        steel_shape_designation: l.steel_shape_designation,
        unit_weight: l.unit_weight,
        from_schedule: l.from_schedule === true,
        corroborating_sources: l.corroborating_sources,
      }),
      flagged_for_review: !!l.flagged_for_review,
      assumptions: l.assumptions || null,
      notes: l.notes || null,
    };
  });

  const rollup = summarize(enrichedLines, rate);

  // Insert run
  const runBody = {
    opportunity_id: args.opp,
    stage: takeoff.stage || context.bid_stage || 'unknown',
    rate_card_version_id: rate.id,
    generated_by: 'oauth-claude-code',
    generator_version: takeoff.generator_version || 'takeoff-md-v1',
    raw_output: takeoff,
    notes: takeoff.scope_summary || null,
    status: 'draft',
    ...rollup,
  };
  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/takeoff_runs`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(runBody),
  });
  if (!runRes.ok) {
    console.error('takeoff_runs insert failed:', runRes.status, await runRes.text());
    process.exit(1);
  }
  const [run] = await runRes.json();
  console.log(`Inserted takeoff_run ${run.id}`);

  // Insert lines
  if (enrichedLines.length) {
    const linesBody = enrichedLines.map((l) => ({ ...l, takeoff_run_id: run.id }));
    const linesRes = await fetch(`${SUPABASE_URL}/rest/v1/takeoff_lines`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(linesBody),
    });
    if (!linesRes.ok) {
      console.error('takeoff_lines insert failed:', linesRes.status, await linesRes.text());
      process.exit(1);
    }
    console.log(`Inserted ${enrichedLines.length} takeoff_lines`);
  }

  // Print summary
  console.log('\n=== Takeoff Summary ===');
  console.log(`Stage:                 ${runBody.stage}`);
  console.log(`Lines:                 ${enrichedLines.length}  (flagged: ${rollup.flagged_lines_count})`);
  console.log(`Total weight:          ${rollup.total_weight_lbs?.toFixed(0) || 0} lbs`);
  console.log(`Total ironworker hrs:  ${rollup.total_ironworker_hrs?.toFixed(1) || 0}`);
  console.log(`Material subtotal:     $${(rollup.material_subtotal_usd || 0).toFixed(0)}`);
  console.log(`Labor subtotal:        $${(rollup.labor_subtotal_usd || 0).toFixed(0)}`);
  console.log(`Finish subtotal:       $${(rollup.finish_subtotal_usd || 0).toFixed(0)}`);
  console.log(`Subtotal (incl tax):   $${(rollup.subtotal_usd || 0).toFixed(0)}`);
  console.log(`Bid total (incl bond): $${(rollup.bid_total_usd || 0).toFixed(0)}`);
  console.log(`Confidence avg:        ${(rollup.confidence_avg * 100).toFixed(0)}%`);

  // Bid-form phantom-category check: warn if any line category isn't
  // covered by a CSI code on the GC's bid form.
  const piRes = await fetch(
    `${SUPABASE_URL}/rest/v1/plan_intelligence?opportunity_id=eq.${args.opp}&select=summary&order=generated_at.desc&limit=1`,
    { headers: headers() }
  );
  const [pi] = await piRes.json();
  const bidFormCsi = pi?.summary?.bid_form_csi_codes || [];
  if (bidFormCsi.length > 0) {
    const check = crossCheckTakeoffCategories(
      enrichedLines.map((l) => l.category),
      bidFormCsi
    );
    if (check.phantom.length > 0) {
      console.log('\n⚠  BID-FORM PHANTOM CHECK:');
      console.log(`   Form lists CSI codes: ${check.bid_form_csi_codes.slice(0, 12).join(', ')}${check.bid_form_csi_codes.length > 12 ? '…' : ''}`);
      console.log(`   Allowed categories:   ${check.allowed_categories.join(', ')}`);
      console.log(`   Phantom categories in your takeoff: ${check.phantom.join(', ')}`);
      console.log(`   Action: drop the phantom lines OR confirm with GC whether they should be added to the form.`);
    } else {
      console.log(`Bid-form check:        ✓ all ${check.in_scope.length} categories covered`);
    }
  }
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
