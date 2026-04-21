import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const [{ data: customer }, { data: opps }] = await Promise.all([
    supabase.from('customers').select('*').eq('id', params.id).single(),
    supabase.from('opportunities').select('id, title, status, score, response_deadline, estimated_value, updated_at')
      .eq('customer_id', params.id)
      .order('updated_at', { ascending: false }),
  ]);

  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ data: customer, opportunities: opps || [] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const allowed = ['name', 'company', 'email', 'phone', 'role', 'notes', 'last_contact'];
  const update: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) update[k] = body[k] || null;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('customers').update(update).eq('id', params.id)
    .select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { error } = await supabase.from('customers').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
