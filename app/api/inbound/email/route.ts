import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadToStorage, sanitizeFilename } = require('../../../../lib/documents');

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Brevo Inbound Parse webhook.
 *
 * Brevo POSTs JSON payloads that look like:
 *   {
 *     items: [
 *       {
 *         From: { Address: "sender@x.com", Name: "Sender Name" },
 *         To:   [{ Address: "bids-in@quoteautomator.com" }],
 *         Subject: "...",
 *         RawHtmlBody: "...",
 *         RawTextBody: "...",
 *         Attachments: [{ Name, ContentType, ContentBytes (base64), DownloadToken }],
 *         MessageId: "<...>",
 *       }, ...
 *     ]
 *   }
 *
 * We treat each item as a new opportunity. The webhook is auth'd via a
 * shared secret in the Authorization header (configured in Brevo's webhook
 * settings and matched against INBOUND_EMAIL_SECRET env var).
 */

function authorized(req: NextRequest) {
  const header = req.headers.get('authorization') || req.headers.get('x-webhook-secret');
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) return true; // no gate configured — allow (initial setup)
  return header === secret || header === `Bearer ${secret}`;
}

interface BrevoItem {
  From?: { Address?: string; Name?: string };
  Subject?: string;
  RawHtmlBody?: string;
  RawTextBody?: string;
  MessageId?: string;
  SentAtDate?: string;
  Attachments?: Array<{
    Name?: string;
    ContentType?: string;
    ContentBytes?: string;
    DownloadToken?: string;
  }>;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { items?: BrevoItem[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return NextResponse.json({ ok: true, processed: 0 });

  const supabase = createServiceClient();
  let created = 0;
  let skipped = 0;

  for (const item of items) {
    const messageId = item.MessageId || `inbound-${crypto.randomBytes(8).toString('hex')}`;
    // Dedup by message id stored in sam_notice_id
    const { data: existing } = await supabase
      .from('opportunities').select('id').eq('sam_notice_id', messageId).maybeSingle();
    if (existing) { skipped++; continue; }

    const fromAddr = item.From?.Address || '';
    const fromName = item.From?.Name || '';
    const subject = (item.Subject || '(no subject)').slice(0, 300);
    const text = item.RawTextBody || stripHtml(item.RawHtmlBody || '');
    const description = [
      `From: ${fromName} <${fromAddr}>`,
      `Received: ${item.SentAtDate || new Date().toISOString()}`,
      '',
      text,
    ].join('\n').slice(0, 10000);

    const { data: opp, error } = await supabase.from('opportunities').insert({
      title: `[forwarded] ${subject}`,
      description,
      source: 'email-forward',
      source_channel: 'email',
      added_via: 'email-forward',
      status: 'new',
      sam_notice_id: messageId,
      posted_date: new Date().toISOString().split('T')[0],
      raw_data: {
        inbound_email: true,
        from: fromAddr,
        from_name: fromName,
        message_id: messageId,
        subject,
      },
    }).select().single();

    if (error || !opp) {
      console.error('inbound insert error', error);
      continue;
    }

    // Upload any attachments
    const atts = Array.isArray(item.Attachments) ? item.Attachments : [];
    const documents = [];
    for (const a of atts.slice(0, 10)) {
      if (!a.ContentBytes) continue;
      try {
        const buf = Buffer.from(a.ContentBytes, 'base64');
        if (buf.length === 0 || buf.length > 100 * 1024 * 1024) continue;
        const filename = sanitizeFilename(a.Name || 'attachment');
        const tmp = path.join(os.tmpdir(), `inbound-${opp.id}-${filename}`);
        fs.writeFileSync(tmp, buf);
        try {
          await uploadToStorage(tmp, `${opp.id}/${filename}`, a.ContentType || 'application/octet-stream');
          documents.push({
            filename,
            storage_path: `${opp.id}/${filename}`,
            downloaded_at: new Date().toISOString(),
            file_size: buf.length,
            mime_type: a.ContentType || 'application/octet-stream',
            category: 'general',
          });
        } finally {
          try { fs.unlinkSync(tmp); } catch {}
        }
      } catch (e) {
        console.error('attachment upload failed', e);
      }
    }
    if (documents.length > 0) {
      await supabase.from('opportunities').update({ documents }).eq('id', opp.id);
    }
    created++;
  }

  return NextResponse.json({ ok: true, created, skipped, total: items.length });
}

function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
