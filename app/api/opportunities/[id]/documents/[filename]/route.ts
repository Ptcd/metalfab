import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deleteFromStorage } = require('../../../../../../lib/documents');

export const dynamic = 'force-dynamic';

// DELETE /api/opportunities/[id]/documents/[filename]
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; filename: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: opp } = await supabase
    .from('opportunities').select('id, documents').eq('id', params.id).single();
  if (!opp) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const filename = decodeURIComponent(params.filename);
  const storagePath = `${params.id}/${filename}`;
  const docs = Array.isArray(opp.documents) ? opp.documents : [];
  const next = docs.filter((d: { storage_path: string }) => d.storage_path !== storagePath);

  try {
    await deleteFromStorage([storagePath]);
  } catch (e) {
    // Non-fatal — clear the array even if the storage object is already gone
    console.error('storage delete failed:', e);
  }

  await supabase.from('opportunities').update({ documents: next }).eq('id', params.id);
  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'docs_purged',
    new_value: filename,
  });

  return NextResponse.json({ ok: true, remaining: next.length });
}
