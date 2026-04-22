#!/usr/bin/env node
/**
 * fetch-email.js — IMAP poller over the AOL INBOX.
 *
 * For every UNSEEN message, classify as:
 *   - 'bid'     → create opportunity + save attachments + mark \Seen
 *   - 'spam'    → move to Trash (AOL's trash folder)
 *   - 'unclear' → just mark \Seen (safe middle ground, keeps noise out of CRM)
 *
 * The classifier is rule-based: known bid-portal senders and construction
 * keywords promote to 'bid'; known newsletter/promo senders and unsubscribe-
 * only content demote to 'spam'; everything else stays 'unclear' so we never
 * auto-trash something we shouldn't.
 *
 * Env:
 *   AOL_USER, AOL_APP_PASSWORD, AOL_INBOX_FOLDER (default INBOX),
 *   AOL_TRASH_FOLDER (default "Trash"), AOL_SPAM_AGGRESSIVE (default false)
 *
 * Usage:
 *   node scripts/fetch-email.js
 *   node scripts/fetch-email.js --dry-run            (classify + print, no changes)
 *   node scripts/fetch-email.js --folder=Bulk --limit=50
 *   node scripts/fetch-email.js --no-trash           (create bids, mark seen, never trash)
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
const DEFAULT_FOLDER = process.env.AOL_INBOX_FOLDER || 'INBOX';
const TRASH_FOLDER = process.env.AOL_TRASH_FOLDER || 'Trash';

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ---- classification -----------------------------------------------------

// Known bid-portal sender patterns. A match on any of these is a hard 'bid'.
const SENDER_PATTERNS = [
  { re: /bidnetdirect|bidnet|sovra\.com/i, source: 'email-bidnet', agency: 'BidNet Direct' },
  { re: /demandstar/i, source: 'email-demandstar', agency: 'DemandStar' },
  { re: /buildingconnected|autodesk/i, source: 'email-buildingconnected', agency: 'BuildingConnected' },
  { re: /panteratools|cullenbids|cullen/i, source: 'email-cullen', agency: 'JP Cullen' },
  { re: /cdsmith|reproconnect/i, source: 'email-cdsmith', agency: 'CD Smith / ReproConnect' },
  { re: /stenstrom/i, source: 'email-stenstrom', agency: 'Stenstrom' },
  { re: /scherrer/i, source: 'email-scherrer', agency: 'Scherrer' },
  { re: /stevens/i, source: 'email-stevens', agency: 'Stevens Construction' },
  { re: /questcdn/i, source: 'email-questcdn', agency: 'QuestCDN' },
  { re: /bonfirehub|gobonfire|bonfire/i, source: 'email-bonfire', agency: 'Bonfire' },
  { re: /sam\.gov|gsa|sam-noreply/i, source: 'email-samgov', agency: 'SAM.gov' },
  { re: /milwaukee\.gov|cityofmilwaukee/i, source: 'email-milwaukee', agency: 'City of Milwaukee' },
  { re: /racinecounty|racine\.gov/i, source: 'email-racine', agency: 'Racine County' },
  { re: /procore/i, source: 'email-procore', agency: 'Procore' },
  { re: /isqft|constructconnect/i, source: 'email-constructconnect', agency: 'ConstructConnect' },
  { re: /smartbidnet/i, source: 'email-smartbidnet', agency: 'SmartBidNet' },
  { re: /plan\.?room|planswift|blueprintbox/i, source: 'email-planroom', agency: 'Plan Room' },
  { re: /onvia|govwin/i, source: 'email-govwin', agency: 'GovWin' },
  { re: /kraemerbrothers/i, source: 'email-kraemer', agency: 'Kraemer Brothers' },
  { re: /copperrockconstruction/i, source: 'email-copperrock', agency: 'Copper Rock Construction' },
];

// Senders we should trash outright — promotions, newsletters, account-only mail
// that can never be a bid opportunity. Keep this list tight; false positives
// cost us real leads.
const SPAM_SENDER_PATTERNS = [
  /@aol\.com$/i,                           // AOL system emails (tips, deals)
  /constantcontact|mailchimp|sendgrid\.net|sendgrid\.com|aweber|substack/i,
  /newsletters?@|marketing@|promo@|promotions@|deals@|offers@/i,
  /linkedin\.com|facebook(mail|)?\.com|instagram\.com|twitter\.com|x\.com/i,
  /googleads|google\.com\/ads|adwords/i,
  /survey|surveymonkey|typeform/i,
  /homeadvisor|angi\.com|thumbtack/i,      // consumer leads, not commercial bids
  /yelp\.com/i,
  /groupon|livingsocial/i,
  /amazon\.com.*shipment|order@amazon|auto-confirm@amazon/i,
  /ebay\.com|paypal\.com.*receipt/i,
  /dropbox\.com|docusign\.(?!.*bid)/i,     // generic notifications (filtered)
];

// Subject patterns that signal a real bid opportunity.
const BID_SUBJECT_PATTERNS = [
  /invitation\s+to\s+(bid|quote)/i,
  /\brfp\b|\brfq\b|\bitb\b|\brfi\b/i,
  /request\s+for\s+(proposal|quotation|quote|information)/i,
  /solicitation/i,
  /bid\s+(invitation|opportunity|notice|posted|alert)/i,
  /new\s+project\s+posted/i,
  /plan\s+room|planroom/i,
  /addend(um|a)/i,
  /procurement/i,
  /subcontract\s+opportunity/i,
  /tender|prequalif/i,
];

// Subject patterns that are noise regardless of sender.
const SPAM_SUBJECT_PATTERNS = [
  /\boff\s+today\b|\bsave\s+\$?\d+/i,
  /flash\s+sale|limited\s+time|expires\s+(today|tomorrow)/i,
  /unsubscribe|opt\s+out/i,
  /password\s+reset|verify\s+your\s+email|login\s+code|otp|one[-\s]?time\s+password/i,
  /your\s+order|shipping\s+confirmation|shipment\s+arrived|delivered/i,
  /statement\s+available|invoice\s+#\d+/i,
  /newsletter|weekly\s+digest|monthly\s+digest/i,
];

// Construction/metals keywords — if subject or early body mentions these,
// push toward 'bid' even if sender is unknown.
const CONSTRUCTION_KEYWORDS = /\b(bid|proposal|subcontract|construction|steel|metal|fabric|railing|handrail|stair|fence|canopy|weld|shop\s+drawing|takeoff|prequalif|general\s+contractor|\bgc\b)\b/i;

function classifySender(fromAddress) {
  const addr = (fromAddress || '').toLowerCase();
  for (const p of SENDER_PATTERNS) {
    if (p.re.test(addr)) return { source: p.source, agency: p.agency };
  }
  return { source: 'email', agency: null };
}

function classifyEmail(parsed, fromAddr) {
  const subject = parsed.subject || '';
  const bodyHead = (parsed.text || parsed.html || '').slice(0, 2000);
  const haystack = `${subject} ${bodyHead}`;

  // 1. Known bid portal → always bid
  for (const p of SENDER_PATTERNS) {
    if (p.re.test(fromAddr)) {
      return { verdict: 'bid', reason: 'known_portal', matched: p.agency };
    }
  }

  // 2. Known spam senders → always spam
  for (const re of SPAM_SENDER_PATTERNS) {
    if (re.test(fromAddr)) {
      return { verdict: 'spam', reason: 'spam_sender' };
    }
  }

  // 3. Spam subject → spam (no false-positive risk if the user never reads
  //    those subjects as bids)
  for (const re of SPAM_SUBJECT_PATTERNS) {
    if (re.test(subject)) {
      return { verdict: 'spam', reason: 'spam_subject' };
    }
  }

  // 4. Subject explicitly mentions a bid term → bid
  for (const re of BID_SUBJECT_PATTERNS) {
    if (re.test(haystack)) {
      return { verdict: 'bid', reason: 'bid_keyword' };
    }
  }

  // 5. Construction/metals keyword in subject or head → bid (looser signal)
  if (CONSTRUCTION_KEYWORDS.test(subject)) {
    return { verdict: 'bid', reason: 'construction_subject' };
  }

  // 6. Attachment-heavy from a gov/edu/contractor-shaped domain → bid
  const atts = (parsed.attachments || []).filter((a) => (a.size || 0) > 1000);
  const domain = (fromAddr.split('@')[1] || '').toLowerCase();
  if (atts.length >= 2 && /(\.gov|\.us|\.edu|construction|builders|contracting|engineers?|architects?)/i.test(domain)) {
    return { verdict: 'bid', reason: 'attachments_from_industry_domain' };
  }

  // 7. Everything else — leave it alone
  return { verdict: 'unclear', reason: 'no_signal' };
}

// ---- arg parsing --------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, folder: null, limit: null, noTrash: false };
  for (const a of args) {
    if (a === '--dry-run') out.dryRun = true;
    if (a === '--no-trash') out.noTrash = true;
    const m = a.match(/^--(folder|limit)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'folder') out.folder = m[2];
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
  }
  return out;
}

// ---- Supabase helpers ---------------------------------------------------

async function opportunityExists(messageId) {
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

// ---- per-email processing ----------------------------------------------

async function createBidOpportunity(parsed, uid) {
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

  const opp = {
    sam_notice_id: messageId,
    title: `[email] ${subject}`,
    source,
    source_channel: 'email',
    added_via: 'email-ingest',
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

  const documents = [];
  const atts = parsed.attachments || [];
  const tmpDir = path.join(os.tmpdir(), `email-${uid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const a of atts.slice(0, 10)) {
    if (!a.content || a.content.length === 0) continue;
    if (a.contentType?.startsWith('image/') && a.content.length < 10_000) continue;
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

// ---- main ---------------------------------------------------------------

async function run() {
  if (!AOL_USER || !AOL_PASS) {
    console.error('AOL_USER or AOL_APP_PASSWORD not set — aborting.');
    return { ok: false, error: 'missing credentials' };
  }

  const args = parseArgs();
  const folder = args.folder || DEFAULT_FOLDER;
  const runRow = await startRun('scrape', `fetch-email:${folder}`);

  const client = new ImapFlow({
    host: AOL_HOST,
    port: AOL_PORT,
    secure: true,
    auth: { user: AOL_USER, pass: AOL_PASS },
    logger: false,
    connectTimeout: 15000,
    socketTimeout: 60000,
  });
  // AOL drops the connection occasionally on long sessions. Swallow the
  // error event so it doesn't crash the whole run — the loop below handles
  // per-email failures on its own.
  client.on('error', (err) => {
    console.log(`   (imap warning: ${err.message?.slice(0, 80)})`);
  });

  const totals = { processed: 0, created: 0, trashed: 0, unclear: 0, dupes: 0, errors: 0 };

  try {
    await client.connect();
    let mailbox;
    try {
      mailbox = await client.mailboxOpen(folder);
    } catch {
      console.log(`Folder "${folder}" not found, falling back to INBOX.`);
      mailbox = await client.mailboxOpen('INBOX');
    }
    console.log(`Connected. ${mailbox.exists} messages in ${mailbox.path}.`);

    const uids = await client.search({ seen: false }, { uid: true });
    if (uids.length === 0) {
      console.log('No unseen emails — done.');
      await finishRun(runRow, { status: 'success', opportunities_processed: 0 });
      return { ok: true, ...totals };
    }
    const toProcess = args.limit ? uids.slice(-args.limit) : uids;
    console.log(`Processing ${toProcess.length} of ${uids.length} unseen.\n`);

    for (const uid of toProcess) {
      totals.processed++;
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
        const subject = (parsed.subject || '(no subject)').slice(0, 80);
        const { verdict, reason } = classifyEmail(parsed, fromAddr);

        console.log(`  [${uid}] ${verdict.padEnd(7)} ← ${fromAddr.slice(0, 32).padEnd(32)} | ${subject}`);

        if (args.dryRun) {
          console.log(`         reason=${reason}`);
          continue;
        }

        if (verdict === 'bid') {
          const result = await createBidOpportunity(parsed, uid);
          if (result.skipped) {
            totals.dupes++;
            console.log(`         ↳ dup, marking seen`);
          } else {
            totals.created++;
            console.log(`         ↳ opp ${result.oppId.slice(0, 8)} (${result.attachments} atts)`);
          }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } else if (verdict === 'spam') {
          if (args.noTrash) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          } else {
            try {
              await client.messageMove(uid, TRASH_FOLDER, { uid: true });
              totals.trashed++;
              console.log(`         ↳ moved to ${TRASH_FOLDER} (${reason})`);
            } catch (e) {
              // If move fails (folder name mismatch), fall back to marking seen
              console.log(`         ⚠️  move to trash failed: ${e.message.slice(0, 80)}`);
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            }
          }
        } else {
          // unclear — leave in inbox but mark seen so we don't reprocess
          totals.unclear++;
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      } catch (e) {
        totals.errors++;
        console.log(`         ❌ ${e.message.slice(0, 140)}`);
        await addError(runRow, 'process', `uid=${uid}: ${e.message}`);
      }
    }

    await client.logout();
  } catch (e) {
    console.error('Fatal IMAP error:', e.message);
    await addError(runRow, 'imap', e.message);
    await finishRun(runRow, { status: 'failed' });
    return { ok: false, error: e.message };
  }

  await addStep(runRow, 'email-poll-done', totals);
  await finishRun(runRow, {
    status: totals.errors === 0 ? 'success' : 'partial',
    opportunities_processed: totals.created,
    notes: `inbox sweep: ${totals.created} bids, ${totals.trashed} trashed, ${totals.unclear} unclear, ${totals.dupes} dupes`,
  });

  console.log(
    `\n✅ ${totals.processed} scanned — ${totals.created} opps created, ` +
    `${totals.trashed} trashed, ${totals.unclear} left as-is, ${totals.dupes} dupes, ${totals.errors} errors`
  );
  return { ok: true, ...totals };
}

module.exports = { runFetchEmail: run };

if (require.main === module) {
  run().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
