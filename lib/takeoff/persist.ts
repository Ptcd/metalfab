/**
 * lib/takeoff/persist.ts — server-only helper that updates / adds /
 * deletes a takeoff_line, re-prices it from the run's rate card,
 * recomputes the run roll-up, and writes a takeoff_line_edits row.
 *
 * Returns the latest run + lines snapshot so the API route can ship
 * one round-trip back to the client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { priceLine, rollup, RateCard, RunLine } from './price-line';
import { computeConfidence } from './confidence';

interface LineRow extends Record<string, unknown> {
  id: string;
  takeoff_run_id: string;
  line_no: number;
  category: string;
  description: string;
  in_tcb_scope: boolean | null;
  assembly_type: string | null;
  source_kind: string;
  source_filename: string | null;
  source_section: string | null;
  source_page: number | null;
  source_evidence: string;
  quantity: number;
  quantity_unit: string;
  quantity_band: string;
  quantity_min: number | null;
  quantity_max: number | null;
  steel_shape_id: string | null;
  steel_shape_designation: string | null;
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
  finish_cost_usd: number | null;
  material_cost_usd: number | null;
  labor_cost_usd: number | null;
  line_total_usd: number | null;
  confidence: number;
  flagged_for_review: boolean | null;
  assumptions: string | null;
  notes: string | null;
}

async function loadRateCard(supabase: SupabaseClient, runId: string): Promise<RateCard> {
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('rate_card_version_id')
    .eq('id', runId)
    .single();
  if (run?.rate_card_version_id) {
    const { data: rate } = await supabase
      .from('rate_card_versions')
      .select('*')
      .eq('id', run.rate_card_version_id)
      .single();
    if (rate) return rate as RateCard;
  }
  const { data: rate } = await supabase
    .from('rate_card_versions')
    .select('*')
    .is('effective_to', null)
    .order('effective_from', { ascending: false })
    .limit(1)
    .single();
  return rate as RateCard;
}

async function recomputeRunRollup(
  supabase: SupabaseClient,
  runId: string,
  rate: RateCard,
): Promise<{ run: Record<string, unknown>; lines: LineRow[] }> {
  const { data: lines } = await supabase
    .from('takeoff_lines')
    .select('*')
    .eq('takeoff_run_id', runId)
    .order('line_no', { ascending: true });
  const r = rollup((lines || []) as unknown as RunLine[], rate);
  const { data: run } = await supabase
    .from('takeoff_runs')
    .update({
      total_weight_lbs:        r.total_weight_lbs,
      total_fab_hrs:           r.total_fab_hrs,
      total_det_hrs:           r.total_det_hrs,
      total_foreman_hrs:       r.total_foreman_hrs,
      total_ironworker_hrs:    r.total_ironworker_hrs,
      material_subtotal_usd:   r.material_subtotal_usd,
      labor_subtotal_usd:      r.labor_subtotal_usd,
      finish_subtotal_usd:     r.finish_subtotal_usd,
      fixed_costs_usd:         r.fixed_costs_usd,
      subtotal_usd:            r.subtotal_usd,
      overhead_usd:            r.overhead_usd,
      profit_usd:              r.profit_usd,
      bid_total_usd:           r.bid_total_usd,
      confidence_avg:          r.confidence_avg,
      flagged_lines_count:     r.flagged_lines_count,
    })
    .eq('id', runId)
    .select()
    .single();
  return { run: (run as Record<string, unknown>) || {}, lines: (lines as LineRow[]) || [] };
}

export async function updateLine(
  supabase: SupabaseClient,
  lineId: string,
  patch: Record<string, unknown>,
  userId: string | null,
) {
  // Load existing line
  const { data: before, error: beforeErr } = await supabase
    .from('takeoff_lines')
    .select('*')
    .eq('id', lineId)
    .single();
  if (beforeErr || !before) throw new Error(`line ${lineId} not found`);

  // Whitelist fields the client may patch (server will recompute the
  // derived fields, so don't accept them from the client).
  const ALLOWED = new Set([
    'category', 'description', 'in_tcb_scope', 'assembly_type',
    'quantity', 'quantity_unit', 'quantity_band', 'quantity_min', 'quantity_max',
    'steel_shape_designation', 'unit_weight', 'unit_weight_unit', 'material_grade',
    'fab_hrs', 'det_hrs', 'foreman_hrs', 'ironworker_hrs',
    'finish', 'finish_surface_sf',
    'confidence', 'flagged_for_review', 'assumptions', 'notes',
  ]);
  const safePatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED.has(k)) safePatch[k] = v;
  }
  if (Object.keys(safePatch).length === 0) {
    throw new Error('no editable fields in patch');
  }

  const merged = { ...(before as LineRow), ...safePatch };
  // Only recompute weight when a weight-affecting field changed. Otherwise
  // some takeoff rows where unit_weight_unit and quantity_unit don't pair
  // cleanly (e.g. lintels stored as quantity_unit='EA' but unit_weight_unit
  // ='lb/ft' because each EA is N linear ft) get clobbered when an
  // unrelated field like fab_hrs is edited.
  const WEIGHT_FIELDS = new Set(['quantity', 'quantity_unit', 'unit_weight', 'unit_weight_unit', 'total_weight_lbs']);
  const weightFieldChanged = Object.keys(safePatch).some((k) => WEIGHT_FIELDS.has(k));
  const carryWeight = !weightFieldChanged ? (before as LineRow).total_weight_lbs : (merged.total_weight_lbs as number | null);

  const rate = await loadRateCard(supabase, (before as LineRow).takeoff_run_id);
  const priced = priceLine(
    {
      quantity: Number(merged.quantity),
      quantity_unit: String(merged.quantity_unit),
      unit_weight: merged.unit_weight as number | null,
      unit_weight_unit: merged.unit_weight_unit as string | null,
      total_weight_lbs: carryWeight,
      material_grade: merged.material_grade as string | null,
      fab_hrs: merged.fab_hrs as number | null,
      det_hrs: merged.det_hrs as number | null,
      foreman_hrs: merged.foreman_hrs as number | null,
      ironworker_hrs: merged.ironworker_hrs as number | null,
      finish: merged.finish as string | null,
      finish_surface_sf: merged.finish_surface_sf as number | null,
    },
    rate,
  );

  // Preserve the carried-forward weight if no weight field changed
  // (priceLine() always recomputes from qty × unit_weight, which can
  // diverge from the LLM-supplied total_weight_lbs when unit pairings
  // don't match the formula's expected combos). Recompute downstream
  // costs against the carried weight.
  if (!weightFieldChanged && carryWeight != null) {
    priced.total_weight_lbs = carryWeight;
    const matRate =
      merged.material_grade && /STAINLESS|316|304/i.test(String(merged.material_grade))
        ? Number(rate.stainless_per_lb)
        : Number(rate.steel_per_lb);
    priced.material_cost_usd = carryWeight * matRate;
    if (merged.finish === 'galvanized') {
      priced.finish_cost_usd = carryWeight * Number(rate.galv_per_lb);
    } else if (merged.finish === 'shop_primer' || merged.finish === 'powder_coat') {
      priced.finish_cost_usd = (priced.material_cost_usd || 0) * Number(rate.paint_factor);
    } else {
      priced.finish_cost_usd = 0;
    }
    priced.line_total_usd =
      (priced.material_cost_usd || 0) + (priced.labor_cost_usd || 0) + (priced.finish_cost_usd || 0);
  }

  // Recompute deterministic confidence from the post-patch line state.
  // Replaces whatever confidence the LLM (or a previous edit) supplied
  // unless the patch itself explicitly set confidence — in which case
  // honor the human override (Thomas can lock a value he's sure of).
  const explicitlyOverrode = Object.prototype.hasOwnProperty.call(safePatch, 'confidence');
  const computedConfidence = explicitlyOverrode
    ? Number(safePatch.confidence)
    : computeConfidence({
        source_kind: merged.source_kind as string | null,
        source_section: merged.source_section as string | null,
        source_page: merged.source_page as number | null,
        source_evidence: merged.source_evidence as string | null,
        quantity_band: merged.quantity_band as string | null,
        quantity_min: merged.quantity_min as number | null,
        quantity_max: merged.quantity_max as number | null,
        quantity: merged.quantity as number,
        steel_shape_designation: merged.steel_shape_designation as string | null,
        unit_weight: merged.unit_weight as number | null,
      });

  const { data: updated, error: updErr } = await supabase
    .from('takeoff_lines')
    .update({ ...safePatch, ...priced, confidence: computedConfidence })
    .eq('id', lineId)
    .select()
    .single();
  if (updErr) throw new Error(updErr.message);

  // Audit each changed field
  const editRows: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(safePatch)) {
    if ((before as Record<string, unknown>)[k] !== v) {
      editRows.push({
        takeoff_line_id: lineId,
        takeoff_run_id:  (before as LineRow).takeoff_run_id,
        edit_type:       'field_change',
        field_name:      k,
        before_value:    (before as Record<string, unknown>)[k] ?? null,
        after_value:     v ?? null,
        edited_by:       userId,
      });
    }
  }
  if (editRows.length) {
    await supabase.from('takeoff_line_edits').insert(editRows);
  }

  const snapshot = await recomputeRunRollup(supabase, (before as LineRow).takeoff_run_id, rate);
  return { line: updated as LineRow, run: snapshot.run, lines: snapshot.lines };
}

export async function addLine(
  supabase: SupabaseClient,
  runId: string,
  body: Record<string, unknown>,
  userId: string | null,
) {
  // Find next line_no
  const { data: maxRow } = await supabase
    .from('takeoff_lines')
    .select('line_no')
    .eq('takeoff_run_id', runId)
    .order('line_no', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNo = ((maxRow?.line_no as number) || 0) + 1;

  const rate = await loadRateCard(supabase, runId);
  const priced = priceLine(
    {
      quantity: Number(body.quantity ?? 1),
      quantity_unit: String(body.quantity_unit || 'EA'),
      unit_weight: (body.unit_weight as number | null) ?? null,
      unit_weight_unit: (body.unit_weight_unit as string | null) ?? null,
      total_weight_lbs: (body.total_weight_lbs as number | null) ?? null,
      material_grade: (body.material_grade as string | null) ?? null,
      fab_hrs: (body.fab_hrs as number | null) ?? null,
      det_hrs: (body.det_hrs as number | null) ?? null,
      foreman_hrs: (body.foreman_hrs as number | null) ?? null,
      ironworker_hrs: (body.ironworker_hrs as number | null) ?? null,
      finish: (body.finish as string | null) ?? null,
      finish_surface_sf: (body.finish_surface_sf as number | null) ?? null,
    },
    rate,
  );

  // Compute deterministic confidence unless the caller explicitly set one
  const explicitConfidence = body.confidence;
  const computedConfidence = explicitConfidence !== undefined && explicitConfidence !== null
    ? Number(explicitConfidence)
    : computeConfidence({
        source_kind: (body.source_kind as string) || 'manual',
        source_section: (body.source_section as string) || null,
        source_page: (body.source_page as number) ?? null,
        source_evidence: (body.source_evidence as string) || null,
        quantity_band: (body.quantity_band as string) || 'point',
        quantity_min: (body.quantity_min as number) ?? null,
        quantity_max: (body.quantity_max as number) ?? null,
        quantity: Number(body.quantity ?? 1),
        steel_shape_designation: (body.steel_shape_designation as string) || null,
        unit_weight: (body.unit_weight as number) ?? null,
      });

  const insertRow = {
    takeoff_run_id: runId,
    line_no: nextNo,
    category: body.category || 'misc_metal',
    description: body.description || 'New line',
    in_tcb_scope: body.in_tcb_scope !== false,
    assembly_type: body.assembly_type || null,
    source_kind: body.source_kind || 'assumption',
    source_filename: body.source_filename || null,
    source_section: body.source_section || null,
    source_page: body.source_page ?? null,
    source_evidence: body.source_evidence || 'Manually added by estimator',
    quantity: Number(body.quantity ?? 1),
    quantity_unit: body.quantity_unit || 'EA',
    quantity_band: body.quantity_band || 'point',
    quantity_min: body.quantity_min ?? null,
    quantity_max: body.quantity_max ?? null,
    steel_shape_designation: body.steel_shape_designation || null,
    unit_weight: body.unit_weight ?? null,
    unit_weight_unit: body.unit_weight_unit ?? null,
    total_weight_lbs: priced.total_weight_lbs,
    material_grade: body.material_grade || null,
    fab_hrs: body.fab_hrs ?? null,
    det_hrs: body.det_hrs ?? null,
    foreman_hrs: body.foreman_hrs ?? null,
    ironworker_hrs: body.ironworker_hrs ?? null,
    finish: body.finish || null,
    finish_surface_sf: body.finish_surface_sf ?? null,
    finish_cost_usd: priced.finish_cost_usd,
    material_cost_usd: priced.material_cost_usd,
    labor_cost_usd: priced.labor_cost_usd,
    line_total_usd: priced.line_total_usd,
    confidence: computedConfidence,
    flagged_for_review: body.flagged_for_review ?? false,
    assumptions: body.assumptions || null,
    notes: body.notes || null,
  };

  const { data: inserted, error: insErr } = await supabase
    .from('takeoff_lines')
    .insert(insertRow)
    .select()
    .single();
  if (insErr) throw new Error(insErr.message);

  await supabase.from('takeoff_line_edits').insert({
    takeoff_line_id: (inserted as LineRow).id,
    takeoff_run_id:  runId,
    edit_type:       'add',
    field_name:      null,
    before_value:    null,
    after_value:     inserted,
    edited_by:       userId,
  });

  const snapshot = await recomputeRunRollup(supabase, runId, rate);
  return { line: inserted as LineRow, run: snapshot.run, lines: snapshot.lines };
}

export async function deleteLine(
  supabase: SupabaseClient,
  lineId: string,
  userId: string | null,
) {
  const { data: before } = await supabase
    .from('takeoff_lines')
    .select('*')
    .eq('id', lineId)
    .single();
  if (!before) throw new Error('line not found');

  await supabase.from('takeoff_line_edits').insert({
    takeoff_line_id: lineId,
    takeoff_run_id:  (before as LineRow).takeoff_run_id,
    edit_type:       'delete',
    field_name:      null,
    before_value:    before,
    after_value:     null,
    edited_by:       userId,
  });

  const { error: delErr } = await supabase.from('takeoff_lines').delete().eq('id', lineId);
  if (delErr) throw new Error(delErr.message);

  const rate = await loadRateCard(supabase, (before as LineRow).takeoff_run_id);
  const snapshot = await recomputeRunRollup(supabase, (before as LineRow).takeoff_run_id, rate);
  return { run: snapshot.run, lines: snapshot.lines };
}
