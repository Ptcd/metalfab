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

/**
 * POST /api/opportunities/[id]/bid-submissions
 *
 * Records that TCB sent a bid. multipart/form-data fields:
 *   amount_usd       — required (number, USD)
 *   submitted_by     — required (colin | gohar | other)
 *   method           — email | portal | phone | other
 *   gc_contact_email — optional
 *   notes            — optional
 *   proposal         — optional File (the PDF we sent)
 *
 * Side effects:
 *   - Upserts a bid_submissions row.
 *   - Flips the opportunity status to `bidding` if not already.
 *   - Creates 3-day and 10-day follow-up reminders against the bid's
 *     deadline (or submission date if no deadline).
 *   - Writes a pipeline_event.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: opp } = await supabase
    .from('opportunities')
    .select('id, title, status, customer_id, response_deadline')
    .eq('id', params.id)
    .single();
  if (!opp) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let form: FormData;
  try { form = await request.formData(); } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const amountRaw = form.get('amount_usd');
  const amount = amountRaw ? Number(amountRaw) : null;
  if (amount == null || isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: 'amount_usd required (positive number)' }, { status: 400 });
  }
  const submittedBy = (form.get('submitted_by') as string) || 'other';
  const method = (form.get('method') as string) || 'email';
  const gcContactEmail = (form.get('gc_contact_email') as string) || null;
  const notes = (form.get('notes') as string) || null;

  // Handle proposal upload if present
  let proposalStoragePath: string | null = null;
  let proposalFilename: string | null = null;

  const proposalFile = form.get('proposal');
  if (proposalFile instanceof File && proposalFile.size > 0) {
    if (proposalFile.size > 100 * 1024 * 1024) {
      return NextResponse.json({ error: 'proposal file too large (100MB max)' }, { status: 413 });
    }
    const filename = sanitizeFilename(proposalFile.name || `proposal-${Date.now()}.pdf`);
    const tmp = path.join(os.tmpdir(), `bid-${crypto.randomBytes(6).toString('hex')}-${filename}`);
    try {
      fs.writeFileSync(tmp, Buffer.from(await proposalFile.arrayBuffer()));
      const storagePath = `${params.id}/${filename}`;
      await uploadToStorage(tmp, storagePath, proposalFile.type || 'application/pdf');
      proposalStoragePath = storagePath;
      proposalFilename = filename;

      // Also add it to the opportunity's documents array as a `proposal` category
      const { data: oppWithDocs } = await supabase
        .from('opportunities')
        .select('documents')
        .eq('id', params.id)
        .single();
      const existingDocs = Array.isArray(oppWithDocs?.documents) ? oppWithDocs.documents : [];
      const newDoc = {
        filename,
        storage_path: storagePath,
        downloaded_at: new Date().toISOString(),
        file_size: proposalFile.size,
        mime_type: proposalFile.type || 'application/pdf',
        category: 'proposal' as const,
        uploaded_by: submittedBy,
      };
      await supabase
        .from('opportunities')
        .update({
          documents: [...existingDocs.filter((d: { storage_path: string }) => d.storage_path !== storagePath), newDoc],
        })
        .eq('id', params.id);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  // Insert the bid submission
  const { data: submission, error: insertErr } = await supabase
    .from('bid_submissions')
    .insert({
      opportunity_id: params.id,
      customer_id: opp.customer_id,
      submitted_by: submittedBy,
      amount_usd: amount,
      proposal_storage_path: proposalStoragePath,
      proposal_filename: proposalFilename,
      method,
      gc_contact_email: gcContactEmail,
      notes,
    })
    .select()
    .single();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // Flip status to bidding if not already
  if (opp.status !== 'bidding') {
    await supabase
      .from('opportunities')
      .update({ status: 'bidding', estimated_value: amount })
      .eq('id', params.id);
    await supabase.from('pipeline_events').insert({
      opportunity_id: params.id,
      event_type: 'status_change',
      old_value: opp.status,
      new_value: 'bidding',
    });
  }

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: 'bid_submitted',
    new_value: `$${amount.toLocaleString()} via ${method}`,
  });

  // Create follow-up reminders
  // Use the overall project deadline as the anchor if we have one, else use
  // the submission date. 3 days and 10 days out, both business-day approx.
  const anchor = opp.response_deadline ? new Date(opp.response_deadline) : new Date();
  const d3 = new Date(anchor);
  d3.setDate(d3.getDate() + 3);
  const d10 = new Date(anchor);
  d10.setDate(d10.getDate() + 10);

  const reminders = [
    {
      opportunity_id: params.id,
      reminder_type: 'bid_followup_3d' as const,
      due_at: d3.toISOString(),
      subject: `3-day follow-up on ${opp.title.slice(0, 80)}`,
      body: `You submitted a bid ${amount ? `for $${amount.toLocaleString()}` : ""} on ${new Date().toLocaleDateString()}. Time to check in with the GC.`,
    },
    {
      opportunity_id: params.id,
      reminder_type: 'bid_followup_10d' as const,
      due_at: d10.toISOString(),
      subject: `10-day follow-up on ${opp.title.slice(0, 80)}`,
      body: `Second follow-up if still no response.`,
    },
    {
      opportunity_id: params.id,
      reminder_type: 'rebid_check_award' as const,
      due_at: d10.toISOString(),
      subject: `Check award status for ${opp.title.slice(0, 80)}`,
      body: `If our GC lost, identify the winning GC and send a re-bid email.`,
    },
  ];
  await supabase.from('reminders').insert(reminders);

  return NextResponse.json({ ok: true, submission, reminders_created: reminders.length });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('bid_submissions')
    .select('*')
    .eq('opportunity_id', params.id)
    .order('submitted_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
