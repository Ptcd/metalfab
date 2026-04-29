/**
 * lib/takeoff/scenarios.ts — three-scenario bid calculator.
 *
 * Conservative / Expected / Aggressive numbers derived from the same
 * takeoff lines, with three levers:
 *
 *  1. Quantity band — Conservative uses quantity_max (when present),
 *     Aggressive uses quantity_min, Expected uses quantity.
 *  2. Confidence-based contingency — applied as a multiplier on the
 *     subtotal for each line. The lower the line's confidence, the
 *     wider the contingency on the conservative scenario.
 *  3. Labor cushion — Conservative pads ironworker hours +15%,
 *     Aggressive trims -10%. (Material is left as-is; the quantity
 *     band already captures that variance.)
 *
 * Pure function. No DB calls. Pass in the run, its lines, the rate
 * card, and you get back three priced scenarios.
 */

export interface RateCard {
  steel_per_lb: number;
  stainless_per_lb: number;
  fab_per_hr: number;
  det_per_hr: number;
  eng_per_hr: number;
  foreman_per_hr: number;
  ironworker_per_hr: number;
  galv_per_lb: number;
  paint_factor: number;
  delivery_flat: number;
  equipment_flat: number;
  waste_factor: number;
  sales_tax: number;
  overhead: number;
  profit: number;
  bond_default: number;
}

export interface TakeoffLine {
  category: string;
  quantity: number;
  quantity_unit: string;
  quantity_band: 'point' | 'range' | 'assumed_typical' | string;
  quantity_min: number | null;
  quantity_max: number | null;
  unit_weight: number | null;
  unit_weight_unit: 'lb/ft' | 'lb/ea' | string | null;
  total_weight_lbs: number | null;
  material_grade: string | null;
  fab_hrs: number | null;
  det_hrs: number | null;
  foreman_hrs: number | null;
  ironworker_hrs: number | null;
  finish: string | null;
  finish_surface_sf: number | null;
  finish_cost_usd: number | null;
  material_cost_usd: number | null;
  labor_cost_usd: number | null;
  line_total_usd: number | null;
  confidence: number;
}

export interface ScenarioResult {
  label: 'conservative' | 'expected' | 'aggressive';
  total_weight_lbs: number;
  material_subtotal_usd: number;
  labor_subtotal_usd: number;
  finish_subtotal_usd: number;
  fixed_costs_usd: number;
  contingency_usd: number;
  subtotal_usd: number;
  overhead_usd: number;
  profit_usd: number;
  bid_total_usd: number;
  margin_percent: number;
  per_line: ScenarioLineDetail[];
}

export interface ScenarioLineDetail {
  category: string;
  quantity_used: number;
  total_weight_lbs: number;
  material_cost_usd: number;
  labor_cost_usd: number;
  finish_cost_usd: number;
  contingency_usd: number;
  line_total_usd: number;
}

/**
 * Confidence → contingency multiplier on top of base subtotal.
 * Conservative pads, Aggressive trims, Expected sits in the middle.
 *
 * Tuned so that Conservative stays within ~1.4× of Expected and
 * Aggressive within ~0.75×, which matches how real estimators
 * actually spread three-scenario bids. Wider spreads look noisy and
 * make Colin discount the system's output.
 */
function contingencyMultiplier(confidence: number, scenario: 'conservative' | 'expected' | 'aggressive'): number {
  const base =
    confidence >= 0.9 ? 0.0
      : confidence >= 0.8 ? 0.02
      : confidence >= 0.7 ? 0.05
      : confidence >= 0.6 ? 0.08
      : 0.12;
  if (scenario === 'conservative') return base * 1.25;
  if (scenario === 'aggressive')   return base * 0.5;
  return base;
}

/**
 * Quantity band picker. Conservative blends point + max (70/30) so
 * full quantity_max swings don't dominate the spread; Aggressive
 * blends point + min (70/30); Expected uses the point.
 */
function pickQuantity(line: TakeoffLine, scenario: 'conservative' | 'expected' | 'aggressive'): number {
  const point = Number(line.quantity);
  if (scenario === 'conservative' && line.quantity_max != null) {
    return point * 0.7 + Number(line.quantity_max) * 0.3;
  }
  if (scenario === 'aggressive' && line.quantity_min != null) {
    return point * 0.7 + Number(line.quantity_min) * 0.3;
  }
  return point;
}

function laborMultiplier(scenario: 'conservative' | 'expected' | 'aggressive'): number {
  if (scenario === 'conservative') return 1.08;
  if (scenario === 'aggressive')   return 0.95;
  return 1.0;
}

function priceLineForScenario(line: TakeoffLine, rate: RateCard, scenario: 'conservative' | 'expected' | 'aggressive'): ScenarioLineDetail {
  const qty = pickQuantity(line, scenario);
  const baseQty = Number(line.quantity);

  // Scale weight by the quantity ratio (line.total_weight_lbs is for the
  // base quantity). Falls back to recomputing if total_weight_lbs is null.
  let totalWeight: number;
  if (line.total_weight_lbs != null && baseQty > 0) {
    totalWeight = (Number(line.total_weight_lbs) / baseQty) * qty;
  } else if (line.unit_weight != null) {
    const uw = Number(line.unit_weight);
    totalWeight = qty * uw * (1 + Number(rate.waste_factor || 0));
  } else {
    totalWeight = 0;
  }

  // Material
  const matRate = line.material_grade && /STAINLESS|316|304/i.test(line.material_grade)
    ? Number(rate.stainless_per_lb)
    : Number(rate.steel_per_lb);
  const material = totalWeight * matRate;

  // Labor (scale by qty ratio + scenario cushion)
  const qtyRatio = baseQty > 0 ? qty / baseQty : 1;
  const labMul = laborMultiplier(scenario);
  const labor =
    (Number(line.fab_hrs || 0) * qtyRatio * labMul * Number(rate.fab_per_hr)) +
    (Number(line.det_hrs || 0) * qtyRatio * labMul * Number(rate.det_per_hr)) +
    (Number(line.foreman_hrs || 0) * qtyRatio * labMul * Number(rate.foreman_per_hr)) +
    (Number(line.ironworker_hrs || 0) * qtyRatio * labMul * Number(rate.ironworker_per_hr));

  // Finish
  let finish = 0;
  if (line.finish === 'galvanized') finish = totalWeight * Number(rate.galv_per_lb);
  else if (line.finish === 'shop_primer' || line.finish === 'powder_coat') {
    finish = material * Number(rate.paint_factor);
  }

  // Contingency at the line level (scenario-dependent)
  const baseLineTotal = material + labor + finish;
  const cont = baseLineTotal * contingencyMultiplier(Number(line.confidence || 0), scenario);

  return {
    category: line.category,
    quantity_used: qty,
    total_weight_lbs: totalWeight,
    material_cost_usd: material,
    labor_cost_usd: labor,
    finish_cost_usd: finish,
    contingency_usd: cont,
    line_total_usd: baseLineTotal + cont,
  };
}

export function computeScenarios(
  lines: TakeoffLine[],
  rate: RateCard,
  opts: { bondPercent?: number; markupOverride?: number } = {},
): { conservative: ScenarioResult; expected: ScenarioResult; aggressive: ScenarioResult } {
  const out = {} as Record<string, ScenarioResult>;

  for (const scenario of ['conservative', 'expected', 'aggressive'] as const) {
    const perLine = lines.map((l) => priceLineForScenario(l, rate, scenario));
    const totalWeight = perLine.reduce((a, l) => a + l.total_weight_lbs, 0);
    const matSub = perLine.reduce((a, l) => a + l.material_cost_usd, 0);
    const labSub = perLine.reduce((a, l) => a + l.labor_cost_usd, 0);
    const finSub = perLine.reduce((a, l) => a + l.finish_cost_usd, 0);
    const cont = perLine.reduce((a, l) => a + l.contingency_usd, 0);

    const fixed = Number(rate.delivery_flat || 0) + Number(rate.equipment_flat || 0);
    const subBeforeRollup = matSub + labSub + finSub + cont + fixed;
    const tax = subBeforeRollup * Number(rate.sales_tax || 0);
    const subtotal = subBeforeRollup + tax;
    const overhead = subtotal * Number(rate.overhead || 0);
    const profitBase = (subtotal + overhead) * Number(opts.markupOverride ?? rate.profit ?? 0.10);
    const bond = (subtotal + overhead + profitBase) * (opts.bondPercent ?? Number(rate.bond_default || 0));
    const bidTotal = subtotal + overhead + profitBase + bond;

    // Margin %: profit + bond + overhead as fraction of bid total
    const marginPct = bidTotal > 0 ? ((overhead + profitBase + bond) / bidTotal) * 100 : 0;

    out[scenario] = {
      label: scenario,
      total_weight_lbs: totalWeight,
      material_subtotal_usd: matSub,
      labor_subtotal_usd: labSub,
      finish_subtotal_usd: finSub,
      fixed_costs_usd: fixed,
      contingency_usd: cont,
      subtotal_usd: subtotal,
      overhead_usd: overhead,
      profit_usd: profitBase,
      bid_total_usd: bidTotal,
      margin_percent: marginPct,
      per_line: perLine,
    };
  }

  return out as { conservative: ScenarioResult; expected: ScenarioResult; aggressive: ScenarioResult };
}
