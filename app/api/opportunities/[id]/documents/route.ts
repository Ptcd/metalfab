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
//
// Two modes:
//   1) multipart/form-data (small files, ≤4 MB on Vercel)
//      fields: file, category, description?
//   2) application/json (registration after direct-to-Supabase upload)
//      body: { filename, storage_path, file_size, mime_type, category, description? }
//      Used after the client uploads via the sign-upload signed URL — the
//      bytes never traverse Vercel, so files of any size work.
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

  const contentType = request.headers.get('content-type') || '';
  let newDoc: {
    filename: string;
    storage_path: string;
    downloaded_at: string;
    file_size: number;
    mime_type: string;
    category: string;
    uploaded_by: string | null;
    description: string | null;
  };

  if (contentType.includes('application/json')) {
    // Registration mode — file is already in Storage via signed URL
    let body: {
      filename?: string;
      storage_path?: string;
      file_size?: number;
      mime_type?: string;
      category?: string;
      description?: string;
      uploaded_by?: string;
    };
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body.filename || !body.storage_path) {
      return NextResponse.json({ error: 'filename and storage_path required' }, { status: 400 });
    }
    if (!body.storage_path.startsWith(`${params.id}/`)) {
      return NextResponse.json({ error: 'storage_path must be under this opportunity' }, { status: 400 });
    }
    if (typeof body.file_size === 'number' && body.file_size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'file too large (100MB max)' }, { status: 413 });
    }
    // Verify the object actually exists — guards against clients claiming
    // they uploaded when they didn't.
    const { data: head, error: headErr } = await supabase
      .storage.from('bid-docs')
      .list(params.id, { search: body.filename, limit: 1 });
    if (headErr || !head?.some((o) => o.name === body.filename)) {
      return NextResponse.json({ error: 'object not found in storage' }, { status: 400 });
    }

    const rawCategory = body.category || 'general';
    const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'general';
    newDoc = {
      filename: sanitizeFilename(body.filename),
      storage_path: body.storage_path,
      downloaded_at: new Date().toISOString(),
      file_size: body.file_size || 0,
      mime_type: body.mime_type || 'application/octet-stream',
      category,
      uploaded_by: body.uploaded_by || user.id || null,
      description: body.description || null,
    };
  } else {
    // Multipart mode (legacy / small-file fallback)
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

    newDoc = {
      filename,
      storage_path: storagePath,
      downloaded_at: new Date().toISOString(),
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      category,
      uploaded_by: uploadedBy,
      description,
    };
  }

  // Append to the opportunity's documents array, dedup by storage_path
  const existing = Array.isArray(opp.documents) ? opp.documents : [];
  const next = [...existing.filter((d: { storage_path: string }) => d.storage_path !== newDoc.storage_path), newDoc];

  const { error: patchErr } = await supabase
    .from('opportunities')
    .update({ documents: next, docs_purged_at: null })
    .eq('id', params.id);
  if (patchErr) return NextResponse.json({ error: patchErr.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'doc_uploaded',
    new_value: `${newDoc.category}:${newDoc.filename}`,
  });

  return NextResponse.json({ data: newDoc });
}
