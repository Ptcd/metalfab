/**
 * lib/takeoff/price-line.ts — server-side line pricing (mirrors the
 * scripts/takeoff-commit.js logic, ported to TS so the editable grid's
 * PATCH route can recompute on every save).
 *
 * Same math: total_weight_lbs (with waste factor) × rates → material,
 * labor, finish, line total. Pure function, no DB calls.
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

export interface LineInput {
  quantity: number;
  quantity_unit: string;
  unit_weight: number | null;
  unit_weight_unit: string | null;
  total_weight_lbs: number | null;
  material_grade: string | null;
  fab_hrs: number | null;
  det_hrs: number | null;
  foreman_hrs: number | null;
  ironworker_hrs: number | null;
  finish: string | null;
  finish_surface_sf: number | null;
}

export interface LineCosts {
  total_weight_lbs: number | null;
  material_cost_usd: number | null;
  labor_cost_usd: number | null;
  finish_cost_usd: number | null;
  line_total_usd: number | null;
}

export function priceLine(line: LineInput, rate: RateCard): LineCosts {
  // Total weight: prefer recomputing from quantity × unit weight + waste.
  // If neither is present, carry whatever the caller already had.
  let totalWeight: number | null = null;
  const qty = Number(line.quantity);
  const uw = line.unit_weight != null ? Number(line.unit_weight) : null;
  const waste = 1 + Number(rate.waste_factor || 0);

  if (uw != null && Number.isFinite(qty)) {
    if (line.unit_weight_unit === 'lb/ft' && (line.quantity_unit === 'LF' || line.quantity_unit === 'FT')) {
      totalWeight = qty * uw * waste;
    } else if (line.unit_weight_unit === 'lb/ea' && line.quantity_unit === 'EA') {
      totalWeight = qty * uw * waste;
    } else if (line.quantity_unit === 'LBS') {
      totalWeight = qty;
    } else {
      totalWeight = qty * uw * waste;
    }
  } else if (line.total_weight_lbs != null) {
    totalWeight = Number(line.total_weight_lbs);
  }

  const matRate =
    line.material_grade && /STAINLESS|316|304/i.test(line.material_grade)
      ? Number(rate.stainless_per_lb)
      : Number(rate.steel_per_lb);
  const material = totalWeight != null ? totalWeight * matRate : null;

  const labor =
    Number(line.fab_hrs || 0) * Number(rate.fab_per_hr) +
    Number(line.det_hrs || 0) * Number(rate.det_per_hr) +
    Number(line.foreman_hrs || 0) * Number(rate.foreman_per_hr) +
    Number(line.ironworker_hrs || 0) * Number(rate.ironworker_per_hr);

  let finish = 0;
  if (line.finish === 'galvanized' && totalWeight != null) {
    finish = totalWeight * Number(rate.galv_per_lb);
  } else if ((line.finish === 'shop_primer' || line.finish === 'powder_coat') && material != null) {
    finish = material * Number(rate.paint_factor);
  }

  const lineTotal = (material || 0) + (labor || 0) + (finish || 0);

  return {
    total_weight_lbs: totalWeight,
    material_cost_usd: material,
    labor_cost_usd: labor || null,
    finish_cost_usd: finish || null,
    line_total_usd: lineTotal || null,
  };
}

export interface RunLine {
  total_weight_lbs: number | null;
  material_cost_usd: number | null;
  labor_cost_usd: number | null;
  finish_cost_usd: number | null;
  fab_hrs: number | null;
  det_hrs: number | null;
  foreman_hrs: number | null;
  ironworker_hrs: number | null;
  flagged_for_review: boolean | null;
  confidence: number;
}

export interface RunRollup {
  total_weight_lbs: number;
  total_fab_hrs: number;
  total_det_hrs: number;
  total_foreman_hrs: number;
  total_ironworker_hrs: number;
  material_subtotal_usd: number;
  labor_subtotal_usd: number;
  finish_subtotal_usd: number;
  fixed_costs_usd: number;
  subtotal_usd: number;
  overhead_usd: number;
  profit_usd: number;
  bid_total_usd: number;
  confidence_avg: number;
  flagged_lines_count: number;
}

export function rollup(lines: RunLine[], rate: RateCard): RunRollup {
  const sum = (k: keyof RunLine) =>
    lines.reduce((a, l) => a + Number((l as unknown as Record<string, unknown>)[k] || 0), 0);
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
  const tax = subBeforeRollup * Number(rate.sales_tax || 0);
  const subtotal = subBeforeRollup + tax;
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
