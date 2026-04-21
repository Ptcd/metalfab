import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Stream a bid document from the private Supabase Storage bucket.
 *
 * Path format:  /api/documents/<opportunity_id>/<filename>
 * Gated by the site access cookie (getAuthUser).
 *
 * By default returns Content-Disposition: inline so PDFs open in-browser;
 * pass ?download=1 to force a download instead.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parts = params.path || [];
  if (parts.length < 2) {
    return NextResponse.json({ error: 'Bad path' }, { status: 400 });
  }
  const storagePath = parts.join('/');
  const filename = parts[parts.length - 1];

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const url = `${supaUrl}/storage/v1/object/bid-docs/${encodeURI(storagePath)}`;

  const res = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Storage ${res.status}` },
      { status: res.status }
    );
  }

  let mimeType = res.headers.get('content-type') || 'application/octet-stream';

  // Override octet-stream to the real type when we can tell from the filename.
  if (mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
    const ext = filename.toLowerCase().split('.').pop();
    const extMap: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      txt: 'text/plain',
      html: 'text/html',
      htm: 'text/html',
    };
    if (ext && extMap[ext]) mimeType = extMap[ext];
  }

  const wantDownload = new URL(request.url).searchParams.get('download') === '1';

  // Inline for browser-native types; attachment for the rest
  const inlineFriendly = /^(application\/pdf|image\/|text\/)/i.test(mimeType);
  const disposition =
    wantDownload || !inlineFriendly
      ? `attachment; filename="${encodeURIComponent(filename)}"`
      : `inline; filename="${encodeURIComponent(filename)}"`;

  return new NextResponse(res.body, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
