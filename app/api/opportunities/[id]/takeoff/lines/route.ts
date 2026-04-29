import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { addLine } from '@/lib/takeoff/persist';

export const dynamic = 'force-dynamic';

// POST /api/opportunities/[id]/takeoff/lines
// Body: full line shape (server fills in defaults + computes derived costs).
//       Must include `run_id` to attach to a specific takeoff_run.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { run_id?: string } & Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.run_id) return NextResponse.json({ error: 'run_id required' }, { status: 400 });

  const supabase = createServiceClient();

  // Verify run belongs to this opportunity
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('id, opportunity_id, status')
    .eq('id', body.run_id)
    .single();
  if (!run || run.opportunity_id !== params.id) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  if (run.status === 'submitted') {
    return NextResponse.json({ error: 'cannot edit submitted takeoff' }, { status: 400 });
  }

  try {
    const { line, run: runRow, lines } = await addLine(supabase, body.run_id, body, user.id);
    return NextResponse.json({ data: { line, run: runRow, lines } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'add failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
