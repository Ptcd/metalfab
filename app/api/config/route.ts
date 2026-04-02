import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/config — read scoring config
export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('scoring_config')
    .select('*')
    .limit(1)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Config not found' }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// PUT /api/config — update scoring config
export async function PUT(request: NextRequest) {
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

  // Get existing config ID
  const { data: existing } = await supabase
    .from('scoring_config')
    .select('id')
    .limit(1)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Config not found' }, { status: 404 });
  }

  const allowed = [
    'keyword_primary',
    'keyword_secondary',
    'keyword_disqualify',
    'naics_codes',
    'dollar_min',
    'dollar_max',
    'score_green',
    'score_yellow',
  ];

  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('scoring_config')
    .update(update)
    .eq('id', existing.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
