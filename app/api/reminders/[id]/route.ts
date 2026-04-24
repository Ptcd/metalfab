import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// PATCH /api/reminders/[id] — mark complete, snooze, or edit
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const allowed = ['completed_at', 'snoozed_until', 'subject', 'body', 'due_at'];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }
  // shortcut: { complete: true } → completed_at = now
  if (body.complete === true) patch.completed_at = new Date().toISOString();
  // shortcut: { snooze_days: N } → snoozed_until = now + N days
  if (typeof body.snooze_days === 'number') {
    const d = new Date();
    d.setDate(d.getDate() + body.snooze_days);
    patch.snoozed_until = d.toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('reminders').update(patch).eq('id', params.id)
    .select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (patch.completed_at && data?.opportunity_id) {
    await supabase.from('pipeline_events').insert({
      opportunity_id: data.opportunity_id,
      event_type: 'reminder_completed',
      new_value: data.reminder_type,
    });
  }
  return NextResponse.json({ data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { error } = await supabase.from('reminders').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
