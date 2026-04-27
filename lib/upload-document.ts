/**
 * lib/upload-document.ts — client-side bid document upload.
 *
 * Vercel functions cap request bodies at 4.5 MB, which means the legacy
 * multipart upload path silently 413s on full project manuals and large
 * drawing sets. This helper requests a Supabase Storage signed upload
 * URL, uploads directly to Storage (bypassing Vercel), then registers
 * the document via a small JSON POST.
 *
 * Exported as a single function so the dashboard modal and the
 * opportunity detail page share one path.
 */

import type { BidDocument } from '@/types/opportunity';

export type BidDocumentRecord = BidDocument;

interface UploadOpts {
  category?: string;
  description?: string;
  /** Called after sign-upload succeeds and direct PUT begins (for progress UI). */
  onPutStart?: () => void;
}

const SIZE_THRESHOLD_FOR_DIRECT = 4 * 1024 * 1024; // 4 MB; anything bigger 413s on Vercel

export async function uploadOneFile(
  oppId: string,
  file: File,
  categoryOrOpts?: string | UploadOpts,
): Promise<BidDocumentRecord | null> {
  const opts: UploadOpts =
    typeof categoryOrOpts === 'string'
      ? { category: categoryOrOpts }
      : categoryOrOpts || {};
  const category = opts.category || 'general';

  // Small files: keep the legacy multipart path so we don't hit the
  // signed-URL flow's two-round-trip cost on every tiny upload.
  if (file.size < SIZE_THRESHOLD_FOR_DIRECT) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('category', category);
    if (opts.description) fd.append('description', opts.description);
    const res = await fetch(`/api/opportunities/${oppId}/documents`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Upload failed (${file.name}): ${body.error || res.status}`);
      return null;
    }
    const { data } = await res.json();
    return data as BidDocumentRecord;
  }

  // Large files: signed direct upload to Supabase Storage.
  const signRes = await fetch(`/api/opportunities/${oppId}/documents/sign-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name }),
  });
  if (!signRes.ok) {
    const body = await signRes.json().catch(() => ({}));
    alert(`Upload sign failed (${file.name}): ${body.error || signRes.status}`);
    return null;
  }
  const { signed_url, storage_path, filename } = await signRes.json();

  opts.onPutStart?.();
  const putRes = await fetch(signed_url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!putRes.ok) {
    alert(`Upload failed (${file.name}): storage PUT ${putRes.status}`);
    return null;
  }

  const finalizeRes = await fetch(`/api/opportunities/${oppId}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      storage_path,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      category,
      description: opts.description,
    }),
  });
  if (!finalizeRes.ok) {
    const body = await finalizeRes.json().catch(() => ({}));
    alert(`Upload register failed (${file.name}): ${body.error || finalizeRes.status}`);
    return null;
  }
  const { data } = await finalizeRes.json();
  return data as BidDocumentRecord;
}
