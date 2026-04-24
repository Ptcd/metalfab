import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/email/send
 * Body: {
 *   to: string | string[],
 *   subject: string,
 *   body_text: string,
 *   customer_id?: string,
 *   opportunity_id?: string,
 *   template_key?: 'intro' | 'followup_7d' | 'rebid' | 'custom',
 * }
 *
 * Sends via Brevo transactional API. Tags every outbound with an
 * X-Site-Thread-Id header so the inbound IMAP poller can link replies
 * back to the conversation. Logs the send into email_threads and (if
 * customer_id) updates last_contact + appends to customer notes.
 */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) {
    return NextResponse.json({ error: 'BREVO_API_KEY not set' }, { status: 500 });
  }

  let body: {
    to?: string | string[];
    subject?: string;
    body_text?: string;
    customer_id?: string;
    opportunity_id?: string;
    template_key?: string;
  };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const recipients = Array.isArray(body.to) ? body.to : body.to ? [body.to] : [];
  if (recipients.length === 0) return NextResponse.json({ error: 'to required' }, { status: 400 });
  if (!body.subject) return NextResponse.json({ error: 'subject required' }, { status: 400 });
  if (!body.body_text) return NextResponse.json({ error: 'body_text required' }, { status: 400 });

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'bids@quoteautomator.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'TCB Metalworks';

  // Generate a stable message ID so we can match replies
  const threadId = crypto.randomBytes(12).toString('hex');
  const messageId = `<${threadId}@quoteautomator.com>`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;white-space:pre-wrap;">${escapeHtml(body.body_text)}</div>`;

  const brevoRes = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': brevoKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: recipients.map((email) => ({ email })),
      subject: body.subject,
      htmlContent: html,
      textContent: body.body_text,
      messageVersions: [],
      headers: {
        'X-TCB-Thread-Id': threadId,
        'Message-Id': messageId,
      },
    }),
  });

  if (!brevoRes.ok) {
    const text = await brevoRes.text();
    return NextResponse.json(
      { error: `Brevo ${brevoRes.status}: ${text.slice(0, 200)}` },
      { status: 500 }
    );
  }
  const brevoBody = await brevoRes.json();

  const supabase = createServiceClient();

  // Log to email_threads
  await supabase.from('email_threads').insert({
    customer_id: body.customer_id || null,
    opportunity_id: body.opportunity_id || null,
    direction: 'outbound',
    message_id: messageId,
    subject: body.subject,
    from_address: senderEmail,
    to_addresses: recipients,
    body_text: body.body_text,
    template_key: body.template_key || 'custom',
  });

  // If linked to a customer, update last_contact + note
  if (body.customer_id) {
    const today = localYmd();
    const { data: cust } = await supabase
      .from('customers')
      .select('notes')
      .eq('id', body.customer_id)
      .single();
    const tag = body.template_key ? `[${body.template_key}]` : '[email]';
    const newNote = `${today} — email: ${tag} ${body.subject}`;
    const mergedNotes = [newNote, cust?.notes || ''].filter(Boolean).join('\n\n');
    await supabase
      .from('customers')
      .update({ notes: mergedNotes, last_contact: today })
      .eq('id', body.customer_id);
  }

  // Pipeline event on the opportunity, if linked
  if (body.opportunity_id) {
    await supabase.from('pipeline_events').insert({
      opportunity_id: body.opportunity_id,
      event_type: 'email_sent',
      new_value: `${recipients.join(', ')}: ${body.subject}`,
    });
  }

  return NextResponse.json({
    ok: true,
    message_id: messageId,
    brevo_message_id: brevoBody.messageId,
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

function localYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
