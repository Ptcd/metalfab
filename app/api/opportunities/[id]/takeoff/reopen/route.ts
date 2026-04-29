import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// POST /api/opportunities/[id]/takeoff/reopen
// Body: { run_id }
//
// Flips an approved takeoff back to draft so Thomas can edit again.
// 'submitted' takeoffs cannot be reopened — supersede with a new run.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { run_id?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.run_id) return NextResponse.json({ error: 'run_id required' }, { status: 400 });

  const supabase = createServiceClient();
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('id, opportunity_id, status')
    .eq('id', body.run_id)
    .single();
  if (!run || run.opportunity_id !== params.id) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  if (run.status === 'submitted') {
    return NextResponse.json({ error: 'submitted runs cannot be reopened' }, { status: 400 });
  }

  const { error } = await supabase
    .from('takeoff_runs')
    .update({ status: 'draft' })
    .eq('id', body.run_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'takeoff_reopened',
    new_value: body.run_id,
  });

  return NextResponse.json({ data: { ok: true } });
}
