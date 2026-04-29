import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { updateLine, deleteLine } from '@/lib/takeoff/persist';

export const dynamic = 'force-dynamic';

async function verifyLineBelongs(
  supabase: ReturnType<typeof createServiceClient>,
  oppId: string,
  lineId: string,
) {
  const { data: line } = await supabase
    .from('takeoff_lines')
    .select('id, takeoff_run_id, takeoff_runs:takeoff_run_id(opportunity_id, status)')
    .eq('id', lineId)
    .single();
  if (!line) return { ok: false, code: 404, error: 'line not found' };
  const run = line.takeoff_runs as unknown as { opportunity_id: string; status: string } | null;
  if (run?.opportunity_id !== oppId) return { ok: false, code: 404, error: 'line not found' };
  if (run?.status === 'submitted') return { ok: false, code: 400, error: 'cannot edit submitted takeoff' };
  return { ok: true as const };
}

// PATCH /api/opportunities/[id]/takeoff/lines/[lineId]
// Body: any subset of editable fields. Server re-prices the line and
// recomputes the run roll-up; returns the updated line + run + all lines.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; lineId: string } },
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let patch: Record<string, unknown>;
  try { patch = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const v = await verifyLineBelongs(supabase, params.id, params.lineId);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.code });

  try {
    const { line, run, lines } = await updateLine(supabase, params.lineId, patch, user.id);
    return NextResponse.json({ data: { line, run, lines } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'update failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/opportunities/[id]/takeoff/lines/[lineId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; lineId: string } },
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const v = await verifyLineBelongs(supabase, params.id, params.lineId);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.code });

  try {
    const { run, lines } = await deleteLine(supabase, params.lineId, user.id);
    return NextResponse.json({ data: { run, lines } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
