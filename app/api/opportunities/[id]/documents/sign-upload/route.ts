import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sanitizeFilename } = require('../../../../../../lib/documents');

export const dynamic = 'force-dynamic';

// POST /api/opportunities/[id]/documents/sign-upload
// Body: { filename: string }
// Returns: { signed_url, token, storage_path, filename }
//
// The client uploads the file directly to Supabase Storage via the signed
// URL, bypassing Vercel's 4.5 MB request body limit. Once the upload
// completes, the client calls POST /documents (JSON body) with the
// returned storage_path to register the file in the opportunity.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { filename?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });

  const supabase = createServiceClient();
  const { data: opp, error: loadErr } = await supabase
    .from('opportunities').select('id').eq('id', params.id).single();
  if (loadErr || !opp) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const filename = sanitizeFilename(body.filename);
  const storagePath = `${params.id}/${filename}`;

  const { data, error } = await supabase
    .storage.from('bid-docs')
    .createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'sign failed' }, { status: 500 });
  }

  return NextResponse.json({
    signed_url: data.signedUrl,
    token: data.token,
    storage_path: storagePath,
    filename,
  });
}
