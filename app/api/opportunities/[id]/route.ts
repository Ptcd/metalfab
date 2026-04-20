import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purgeOpportunityDocuments } = require('../../../../lib/documents');

export const dynamic = 'force-dynamic';

const STATUSES_THAT_PURGE_ON_ENTRY = new Set(['passed', 'qa_rejected']);

// GET /api/opportunities/[id]
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// PATCH /api/opportunities/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Get current values for event logging
  const { data: current } = await supabase
    .from('opportunities')
    .select('status, notes')
    .eq('id', params.id)
    .single();

  if (!current) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Build update object (only allowed fields)
  const allowed = ['status', 'notes', 'title', 'description', 'agency', 'dollar_min', 'dollar_max', 'response_deadline'];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('opportunities')
    .update(update)
    .eq('id', params.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Log events
  if (body.status && body.status !== current.status) {
    await supabase.from('pipeline_events').insert({
      opportunity_id: params.id,
      event_type: 'status_change',
      old_value: current.status,
      new_value: body.status,
    });

    // Purge documents immediately when the opp moves into a terminal reject state.
    if (STATUSES_THAT_PURGE_ON_ENTRY.has(body.status)) {
      try {
        await purgeOpportunityDocuments(params.id);
      } catch (e) {
        console.error('purge after status change failed:', e);
      }
    }
  }

  if (body.notes && body.notes !== current.notes) {
    await supabase.from('pipeline_events').insert({
      opportunity_id: params.id,
      event_type: 'note_added',
      new_value: body.notes,
    });
  }

  return NextResponse.json({ data });
}
