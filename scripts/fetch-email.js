#!/usr/bin/env node
/**
 * fetch-email.js — IMAP poller that turns inbound bid emails into opportunities.
 *
 * Connects to tcbmetalworks@aol.com via IMAP, pulls UNSEEN messages from the
 * configured folder (default "Bids", falling back to INBOX), parses each,
 * saves attachments into Supabase Storage, creates an opportunity record,
 * marks the email as \Seen, then disconnects.
 *
 * Env required:
 *   AOL_USER                (e.g. tcbmetalworks@aol.com)
 *   AOL_APP_PASSWORD        (AOL app-specific password, no spaces)
 *   AOL_INBOX_FOLDER        (optional, default "Bids")
 *   SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
 *
 * Usage:
 *   node scripts/fetch-email.js
 *   node scripts/fetch-email.js --dry-run
 *   node scripts/fetch-email.js --folder=INBOX
 *   node scripts/fetch-email.js --limit=5
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { sanitizeFilename, uploadToStorage } = require('../lib/documents');
const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AOL_USER = process.env.AOL_USER;
const AOL_PASS = (process.env.AOL_APP_PASSWORD || '').replace(/\s+/g, '');
const AOL_HOST = process.env.AOL_IMAP_HOST || 'imap.aol.com';
const AOL_PORT = parseInt(process.env.AOL_IMAP_PORT || '993', 10);
const DEFAULT_FOLDER = process.env.AOL_INBOX_FOLDER || 'Bids';

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Known bid-portal sender patterns. When a sender doesn't match, the opp
// still gets created with source='email' but without a recognized portal.
const SENDER_PATTERNS = [
  { re: /bidnetdirect|bidnet/i, source: 'email-bidnet', agency: 'BidNet Direct' },
  { re: /demandstar/i, source: 'email-demandstar', agency: 'DemandStar' },
  { re: /buildingconnected|autodesk/i, source: 'email-buildingconnected', agency: 'BuildingConnected' },
  { re: /panteratools|cullenbids|cullen/i, source: 'email-cullen', agency: 'JP Cullen' },
  { re: /cdsmith/i, source: 'email-cdsmith', agency: 'CD Smith' },
  { re: /stenstrom/i, source: 'email-stenstrom', agency: 'Stenstrom' },
  { re: /scherrer/i, source: 'email-scherrer', agency: 'Scherrer' },
  { re: /stevens/i, source: 'email-stevens', agency: 'Stevens Construction' },
  { re: /questcdn/i, source: 'email-questcdn', agency: 'QuestCDN' },
  { re: /bonfirehub|gobonfire|bonfire/i, source: 'email-bonfire', agency: 'Bonfire' },
  { re: /sam\.gov|gsa|sam-noreply/i, source: 'email-samgov', agency: 'SAM.gov' },
  { re: /milwaukee\.gov|cityofmilwaukee/i, source: 'email-milwaukee', agency: 'City of Milwaukee' },
  { re: /racinecounty|racine\.gov/i, source: 'email-racine', agency: 'Racine County' },
];

function classifySender(fromAddress) {
  const addr = (fromAddress || '').toLowerCase();
  for (const p of SENDER_PATTERNS) {
    if (p.re.test(addr)) return { source: p.source, agency: p.agency };
  }
  return { source: 'email', agency: null };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, folder: null, limit: null };
  for (const a of args) {
    if (a === '--dry-run') out.dryRun = true;
    const m = a.match(/^--(folder|limit)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'folder') out.folder = m[2];
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
  }
  return out;
}

async function opportunityExists(messageId) {
  // Use messageId as sam_notice_id for email opps so the unique constraint dedupes.
  const url = `${SUPABASE_URL}/rest/v1/opportunities?sam_notice_id=eq.${encodeURIComponent(messageId)}&select=id`;
  const res = await fetch(url, { headers: headers() });
  const arr = await res.json();
  return Array.isArray(arr) && arr.length > 0;
}

async function insertOpportunity(opp) {
  const url = `${SUPABASE_URL}/rest/v1/opportunities`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(opp),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`insert: ${res.status} ${text.slice(0, 200)}`);
  }
  const arr = await res.json();
  return arr[0];
}

/**
 * Guess a response deadline from the email body. Very dumb heuristic —
 * looks for phrases like "due" / "bid date" / "response deadline" followed by a date.
 */
function guessDeadline(text) {
  if (!text) return null;
  const snippet = text.slice(0, 4000);
  const patterns = [
    /(?:due|bid date|response deadline|closes?|close date)[^\n]{0,40}?(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:due|bid date|response deadline|closes?|close date)[^\n]{0,40}?(\d{4}-\d{2}-\d{2})/i,
    /(?:due|bid date|response deadline|closes?|close date)[^\n]{0,40}?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const re of patterns) {
    const m = snippet.match(re);
    if (!m) continue;
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

async function processEmail(parsed, uid, { dryRun }) {
  const messageId = parsed.messageId || `email-${uid}`;
  if (await opportunityExists(messageId)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const fromAddr = parsed.from?.value?.[0]?.address || '';
  const fromName = parsed.from?.value?.[0]?.name || '';
  const { source, agency } = classifySender(fromAddr);

  const subject = (parsed.subject || '(no subject)').slice(0, 300);
  const bodyText = parsed.text || '';
  const bodyHtml = parsed.html || '';
  const description = [
    `From: ${fromName} <${fromAddr}>`,
    `Received: ${parsed.date?.toISOString() || '—'}`,
    '',
    bodyText || bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
  ].join('\n').slice(0, 10000);

  const deadline = guessDeadline(bodyText || bodyHtml);

  if (dryRun) {
    return { dryRun: true, subject, source, fromAddr, deadline, attachments: parsed.attachments?.length || 0 };
  }

  const opp = {
    sam_notice_id: messageId,
    title: `[email] ${subject}`,
    source,
    status: 'new',
    agency: agency || fromName || null,
    response_deadline: deadline,
    posted_date: (parsed.date || new Date()).toISOString().split('T')[0],
    description,
    source_url: null,
    raw_data: {
      inbound_email: true,
      from: fromAddr,
      from_name: fromName,
      message_id: messageId,
      received_at: (parsed.date || new Date()).toISOString(),
      subject,
      uid,
    },
  };

  const inserted = await insertOpportunity(opp);
  const oppId = inserted.id;

  // Handle attachments
  const documents = [];
  const atts = parsed.attachments || [];
  const tmpDir = path.join(os.tmpdir(), `email-${uid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const a of atts.slice(0, 10)) {
    if (!a.content || a.content.length === 0) continue;
    if (a.contentType?.startsWith('image/') && a.content.length < 10_000) {
      // Skip tiny inline images (email signature logos, tracking pixels)
      continue;
    }
    const filename = sanitizeFilename(a.filename || `attachment-${documents.length + 1}`);
    const localPath = path.join(tmpDir, filename);
    fs.writeFileSync(localPath, a.content);
    try {
      const storagePath = `${oppId}/${filename}`;
      await uploadToStorage(localPath, storagePath, a.contentType || 'application/octet-stream');
      documents.push({
        filename,
        storage_path: storagePath,
        downloaded_at: new Date().toISOString(),
        file_size: a.content.length,
        mime_type: a.contentType || 'application/octet-stream',
        category: filename.toLowerCase().match(/spec|drawing|plan|addendum/)?.[0] || 'general',
      });
    } catch (e) {
      console.log(`   ⚠️  attachment upload failed (${filename}): ${e.message.slice(0, 100)}`);
    } finally {
      try { fs.unlinkSync(localPath); } catch {}
    }
  }
  try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}

  if (documents.length > 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}`, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ documents }),
    });
  }

  return { ok: true, oppId, subject, source, attachments: documents.length };
}

async function run() {
  if (!AOL_USER || !AOL_PASS) {
    console.error('AOL_USER or AOL_APP_PASSWORD not set — aborting.');
    return { ok: false, error: 'missing credentials' };
  }

  const args = parseArgs();
  const folder = args.folder || DEFAULT_FOLDER;
  const run = await startRun('scrape', `fetch-email:${folder}`);

  const client = new ImapFlow({
    host: AOL_HOST,
    port: AOL_PORT,
    secure: true,
    auth: { user: AOL_USER, pass: AOL_PASS },
    logger: false,
  });

  let processed = 0;
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    await client.connect();
    // Try the requested folder, fall back to INBOX if it doesn't exist
    let mailbox;
    try {
      mailbox = await client.mailboxOpen(folder);
    } catch {
      console.log(`Folder "${folder}" not found, falling back to INBOX.`);
      mailbox = await client.mailboxOpen('INBOX');
    }
    console.log(`Connected. ${mailbox.exists} messages in ${mailbox.path}, ${mailbox.unseen || 0} unseen.`);

    const uids = await client.search({ seen: false }, { uid: true });
    if (uids.length === 0) {
      console.log('No unseen emails — done.');
      await finishRun(run, { status: 'success', opportunities_processed: 0 });
      return { ok: true, processed: 0 };
    }
    const toProcess = args.limit ? uids.slice(0, args.limit) : uids;
    console.log(`Processing ${toProcess.length} of ${uids.length} unseen email(s)\n`);

    for (const uid of toProcess) {
      processed++;
      try {
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) {
          console.log(`  [${uid}] no source body, skipping`);
          continue;
        }
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address || '';
        const subject = parsed.subject || '(no subject)';
        console.log(`  [${uid}] ${from} — ${subject.slice(0, 80)}`);

        const result = await processEmail(parsed, uid, args);
        if (result.skipped) {
          skipped++;
          console.log(`       ↳ skipped (${result.reason})`);
        } else if (result.dryRun) {
          console.log(`       ↳ [dry-run] source=${result.source} deadline=${result.deadline || '—'} atts=${result.attachments}`);
        } else {
          created++;
          console.log(`       ↳ created opp ${result.oppId.slice(0, 8)} (${result.attachments} attachments)`);
          if (!args.dryRun) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          }
        }
      } catch (e) {
        errors++;
        console.log(`       ❌ error: ${e.message.slice(0, 140)}`);
        await addError(run, 'process', `uid=${uid}: ${e.message}`);
      }
    }

    await client.logout();
  } catch (e) {
    console.error('Fatal IMAP error:', e.message);
    await addError(run, 'imap', e.message);
    await finishRun(run, { status: 'failed' });
    return { ok: false, error: e.message };
  }

  await addStep(run, 'email-poll-done', { processed, created, skipped, errors });
  await finishRun(run, {
    status: errors === 0 ? 'success' : 'partial',
    opportunities_processed: created,
  });

  console.log(`\n✅ ${created} new opps, ${skipped} dupes, ${errors} errors from ${processed} emails`);
  return { ok: true, processed, created, skipped, errors };
}

module.exports = { runFetchEmail: run };

if (require.main === module) {
  run().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
