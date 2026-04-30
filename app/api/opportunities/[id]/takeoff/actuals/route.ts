import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/opportunities/[id]/takeoff/actuals
// Returns all bid_actuals rows for the latest takeoff_run on this opp.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('id')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return NextResponse.json({ data: [] });

  const { data: actuals } = await supabase
    .from('bid_actuals')
    .select('*')
    .eq('takeoff_run_id', run.id)
    .order('recorded_at', { ascending: false });

  return NextResponse.json({ data: actuals || [] });
}

// POST /api/opportunities/[id]/takeoff/actuals
// Body: { line_id, actual_total_weight_lbs?, actual_fab_hrs?,
//         actual_det_hrs?, actual_foreman_hrs?, actual_ironworker_hrs?,
//         actual_material_cost_usd?, actual_labor_cost_usd?,
//         actual_finish_cost_usd?, actual_total_cost_usd?, notes? }
//
// Upserts a bid_actuals row for the given line. Snapshots predicted
// values from takeoff_lines at insert time so we have the calibration
// pair even if the line is later edited.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const lineId = body.line_id as string | undefined;
  if (!lineId) return NextResponse.json({ error: 'line_id required' }, { status: 400 });

  const supabase = createServiceClient();
  const { data: line } = await supabase
    .from('takeoff_lines')
    .select('id, takeoff_run_id, quantity, quantity_unit, total_weight_lbs, fab_hrs, det_hrs, foreman_hrs, ironworker_hrs, line_total_usd, takeoff_runs:takeoff_run_id(opportunity_id)')
    .eq('id', lineId)
    .single();
  if (!line) return NextResponse.json({ error: 'line not found' }, { status: 404 });
  const opp = line.takeoff_runs as unknown as { opportunity_id: string } | null;
  if (opp?.opportunity_id !== params.id) {
    return NextResponse.json({ error: 'line does not belong to opp' }, { status: 400 });
  }

  // Build the actuals row. Compute deltas where actuals are present.
  const predicted_total_weight_lbs = Number(line.total_weight_lbs ?? 0);
  const predicted_ironworker_hrs   = Number(line.ironworker_hrs ?? 0);
  const predicted_line_total_usd   = Number(line.line_total_usd ?? 0);
  const actual_total_weight_lbs    = body.actual_total_weight_lbs != null ? Number(body.actual_total_weight_lbs) : null;
  const actual_ironworker_hrs      = body.actual_ironworker_hrs   != null ? Number(body.actual_ironworker_hrs)   : null;
  const actual_total_cost_usd      = body.actual_total_cost_usd   != null ? Number(body.actual_total_cost_usd)   : null;

  const pct = (a: number | null, p: number) => (a == null || p === 0) ? null : (a - p) / p;

  const row = {
    takeoff_run_id:           line.takeoff_run_id,
    takeoff_line_id:          line.id,
    opportunity_id:           params.id,
    predicted_quantity:       Number(line.quantity ?? 0),
    predicted_quantity_unit:  line.quantity_unit,
    predicted_total_weight_lbs,
    predicted_fab_hrs:        Number(line.fab_hrs ?? 0),
    predicted_det_hrs:        Number(line.det_hrs ?? 0),
    predicted_foreman_hrs:    Number(line.foreman_hrs ?? 0),
    predicted_ironworker_hrs,
    predicted_line_total_usd,
    actual_quantity:          body.actual_quantity ?? null,
    actual_total_weight_lbs,
    actual_fab_hrs:           body.actual_fab_hrs ?? null,
    actual_det_hrs:           body.actual_det_hrs ?? null,
    actual_foreman_hrs:       body.actual_foreman_hrs ?? null,
    actual_ironworker_hrs,
    actual_material_cost_usd: body.actual_material_cost_usd ?? null,
    actual_labor_cost_usd:    body.actual_labor_cost_usd ?? null,
    actual_finish_cost_usd:   body.actual_finish_cost_usd ?? null,
    actual_total_cost_usd,
    weight_delta_pct:         pct(actual_total_weight_lbs, predicted_total_weight_lbs),
    ironworker_delta_pct:     pct(actual_ironworker_hrs,   predicted_ironworker_hrs),
    total_delta_pct:          pct(actual_total_cost_usd,   predicted_line_total_usd),
    notes:                    body.notes ?? null,
    recorded_by:              user.id,
  };

  const { data, error } = await supabase
    .from('bid_actuals')
    .upsert([row], { onConflict: 'takeoff_line_id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}
