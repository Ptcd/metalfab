import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadToStorage, sanitizeFilename } = require('../../../../../lib/documents');

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_FILE_BYTES = 100 * 1024 * 1024;

const VALID_CATEGORIES = new Set([
  'specification', 'drawing', 'addendum', 'general', 'form',
  'shop_drawing', 'proposal', 'takeoff', 'estimate',
  'rfi', 'rfi_response', 'submittal', 'photo', 'contract', 'internal',
]);

// POST /api/opportunities/[id]/documents
// multipart/form-data with fields:  file, category, description?
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: opp, error: loadErr } = await supabase
    .from('opportunities').select('id, documents').eq('id', params.id).single();
  if (loadErr || !opp) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let form: FormData;
  try { form = await request.formData(); } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'empty file' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'file too large (100MB max)' }, { status: 413 });

  const rawCategory = (form.get('category') || 'general').toString();
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'general';
  const description = form.get('description')?.toString() || null;
  const uploadedBy = form.get('uploaded_by')?.toString() || user.id || null;

  const filename = sanitizeFilename(file.name);
  const storagePath = `${params.id}/${filename}`;
  const tmp = path.join(os.tmpdir(), `up-${crypto.randomBytes(6).toString('hex')}-${filename}`);

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tmp, buf);
    await uploadToStorage(tmp, storagePath, file.type || 'application/octet-stream');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  const newDoc = {
    filename,
    storage_path: storagePath,
    downloaded_at: new Date().toISOString(),
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
    category,
    uploaded_by: uploadedBy,
    description,
  };

  // Append to the opportunity's documents array, dedup by storage_path
  const existing = Array.isArray(opp.documents) ? opp.documents : [];
  const next = [...existing.filter((d: { storage_path: string }) => d.storage_path !== storagePath), newDoc];

  const { error: patchErr } = await supabase
    .from('opportunities')
    .update({ documents: next, docs_purged_at: null })
    .eq('id', params.id);
  if (patchErr) return NextResponse.json({ error: patchErr.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'doc_uploaded',
    new_value: `${category}:${filename}`,
  });

  return NextResponse.json({ data: newDoc });
}
