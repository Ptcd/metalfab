import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// POST /api/opportunities/[id]/takeoff/approve
//
// Body: { run_id: string, scenario: 'conservative'|'expected'|'aggressive', bid_total_usd: number }
//
// Marks the takeoff_run as approved, snapshots the chosen scenario's
// bid total into bid_total_usd, and writes a pipeline event so the
// approval is auditable. Does NOT submit the bid — that's still
// Colin clicking Submit on the proposal.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { run_id?: string; scenario?: string; bid_total_usd?: number };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.run_id || !body.scenario || typeof body.bid_total_usd !== 'number') {
    return NextResponse.json({ error: 'run_id, scenario, bid_total_usd required' }, { status: 400 });
  }
  if (!['conservative', 'expected', 'aggressive'].includes(body.scenario)) {
    return NextResponse.json({ error: 'invalid scenario' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const update: Record<string, unknown> = {
    status: 'approved',
    bid_total_usd: body.bid_total_usd,
  };
  if (body.scenario === 'conservative') update.conservative_bid_usd = body.bid_total_usd;
  if (body.scenario === 'expected')     update.expected_bid_usd     = body.bid_total_usd;
  if (body.scenario === 'aggressive')   update.aggressive_bid_usd   = body.bid_total_usd;

  const { error: updErr } = await supabase
    .from('takeoff_runs')
    .update(update)
    .eq('id', body.run_id)
    .eq('opportunity_id', params.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'takeoff_approved',
    new_value: `${body.scenario}:$${body.bid_total_usd.toFixed(0)}`,
  });

  return NextResponse.json({ data: { ok: true } });
}
