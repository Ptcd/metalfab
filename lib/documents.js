/**
 * lib/documents.js — shared document-download helpers for scrapers.
 *
 * Responsibilities:
 *  - Categorize filenames (specification > drawing > addendum > general > form)
 *  - Prioritize + cap a download list (10 files or 100 MB total)
 *  - Download a URL to a temp path (curl, public URLs only)
 *  - Upload a local file into Supabase Storage under bid-docs/{opp_id}/{filename}
 *  - Update opportunities.documents jsonb and write a pipeline_event
 *
 * This module is CommonJS so existing scripts can `require` it directly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'bid-docs';

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ---- filename → category --------------------------------------------------

const CATEGORY_PRIORITY = {
  specification: 1,
  drawing: 2,
  addendum: 3,
  general: 4,
  form: 5,
};

function categorizeFilename(name) {
  const n = (name || '').toLowerCase();
  if (/(spec|specification|specs\b|scope\s*of\s*work|sow\b)/.test(n)) return 'specification';
  if (/(drawing|plan|blueprint|sheet|civil|arch|structural|detail|rfp)/.test(n)) return 'drawing';
  if (/(addendum|amendment|revision|rev\b)/.test(n)) return 'addendum';
  if (/(form|checklist|affidavit|certification|bid\s*form|submittal)/.test(n)) return 'form';
  return 'general';
}

function sanitizeFilename(name) {
  // strip path chars, collapse whitespace, cap at 200 chars
  const base = path.basename(name || 'file');
  const cleaned = base.replace(/[^A-Za-z0-9._\-]+/g, '_').slice(0, 200);
  return cleaned || 'file';
}

/**
 * Given a list of {url, filename} candidates, return the subset that should be
 * downloaded (category preference order, cap at maxFiles).
 * Byte cap is enforced during download since we don't know sizes up front.
 */
function prioritizeCandidates(candidates, maxFiles = DEFAULT_MAX_FILES) {
  return (candidates || [])
    .filter((c) => c && c.url)
    .map((c) => ({
      url: c.url,
      filename: sanitizeFilename(c.filename || c.url.split('/').pop() || 'file'),
      category: c.category || categorizeFilename(c.filename || c.url),
    }))
    .sort((a, b) => CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category])
    .slice(0, maxFiles);
}

// ---- Supabase Storage upload ---------------------------------------------

function _supabaseHeaders() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
}

async function uploadToStorage(localPath, storagePath, mimeType) {
  const buf = fs.readFileSync(localPath);
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ..._supabaseHeaders(),
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload ${res.status}: ${text.slice(0, 200)}`);
  }
  return { size: buf.length };
}

async function deleteFromStorage(storagePaths) {
  if (!Array.isArray(storagePaths) || storagePaths.length === 0) return 0;
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ..._supabaseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: storagePaths }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage delete ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => []);
  return Array.isArray(json) ? json.length : storagePaths.length;
}

async function listOpportunityFiles(opportunityId) {
  const url = `${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ..._supabaseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: opportunityId, limit: 1000 }),
  });
  if (!res.ok) return [];
  const items = await res.json();
  return (items || []).map((it) => `${opportunityId}/${it.name}`);
}

async function downloadStorageFile(storagePath, localPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`;
  const res = await fetch(url, { headers: _supabaseHeaders() });
  if (!res.ok) {
    throw new Error(`Storage download ${res.status} for ${storagePath}`);
  }
  const ab = await res.arrayBuffer();
  fs.writeFileSync(localPath, Buffer.from(ab));
  return Buffer.byteLength(Buffer.from(ab));
}

// ---- HTTP download (curl) -------------------------------------------------

function curlDownload(url, localPath, cookiesFile = null) {
  const args = [
    '-s', '-L',
    '--connect-timeout', '15',
    '--max-time', String(Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)),
    '-A', '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"',
    '-o', `"${localPath}"`,
    '-w', '"%{http_code} %{content_type}"',
  ];
  if (cookiesFile) args.push('-b', `"${cookiesFile}"`);
  args.push(`"${url}"`);
  const cmd = `curl ${args.join(' ')}`;
  const out = execSync(cmd, {
    encoding: 'utf8',
    timeout: DOWNLOAD_TIMEOUT_MS + 5000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  const [code, ...ct] = out.split(' ');
  return {
    statusCode: parseInt(code, 10) || 0,
    contentType: ct.join(' ').trim() || 'application/octet-stream',
  };
}

// ---- main entry: downloadAndStore ----------------------------------------

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `bid-docs-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Download a list of candidate docs for an opportunity, upload to Storage,
 * write back the `documents` array, and log a pipeline_event.
 *
 * @param {Object} args
 * @param {string} args.opportunityId - UUID from opportunities.id
 * @param {Array}  args.candidates    - [{url, filename, category?}]
 * @param {string=} args.cookiesFile  - optional Netscape cookie file for auth'd portals
 * @param {number=} args.maxFiles     - cap on files per opp
 * @param {number=} args.maxBytes     - cap on total bytes per opp
 * @returns {Promise<{downloaded:number, skipped:number, bytes:number, documents:Array, errors:Array}>}
 */
async function downloadAndStore({
  opportunityId,
  candidates,
  cookiesFile = null,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  if (!opportunityId) throw new Error('opportunityId required');
  const queue = prioritizeCandidates(candidates, maxFiles);

  const tempDir = makeTempDir();
  const documents = [];
  const errors = [];
  let totalBytes = 0;
  let skipped = 0;

  for (const c of queue) {
    if (totalBytes >= maxBytes) {
      skipped++;
      continue;
    }
    const localPath = path.join(tempDir, c.filename);
    try {
      const { statusCode, contentType } = curlDownload(c.url, localPath, cookiesFile);
      if (statusCode !== 200) {
        errors.push(`${c.filename}: HTTP ${statusCode}`);
        continue;
      }
      const stat = fs.statSync(localPath);
      if (stat.size === 0) {
        errors.push(`${c.filename}: empty download`);
        continue;
      }
      if (totalBytes + stat.size > maxBytes) {
        skipped++;
        continue;
      }
      const storagePath = `${opportunityId}/${c.filename}`;
      await uploadToStorage(localPath, storagePath, contentType);
      totalBytes += stat.size;
      documents.push({
        filename: c.filename,
        storage_path: storagePath,
        downloaded_at: new Date().toISOString(),
        file_size: stat.size,
        mime_type: contentType,
        category: c.category,
      });
    } catch (e) {
      errors.push(`${c.filename}: ${e.message.slice(0, 120)}`);
    } finally {
      try { fs.unlinkSync(localPath); } catch {}
    }
  }

  try { fs.rmdirSync(tempDir, { recursive: true }); } catch {}

  if (documents.length > 0) {
    await _patchOpportunityDocuments(opportunityId, documents);
    await _writeEvent(opportunityId, 'docs_downloaded', null, String(documents.length));
  }

  return { downloaded: documents.length, skipped, bytes: totalBytes, documents, errors };
}

async function _patchOpportunityDocuments(opportunityId, documents) {
  const url = `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opportunityId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ..._supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ documents, docs_purged_at: null }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Patch documents ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function _writeEvent(opportunityId, event_type, old_value, new_value) {
  const url = `${SUPABASE_URL}/rest/v1/pipeline_events`;
  await fetch(url, {
    method: 'POST',
    headers: { ..._supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ opportunity_id: opportunityId, event_type, old_value, new_value }),
  }).catch(() => {});
}

/**
 * Delete all documents for an opportunity from Storage, clear the array,
 * set docs_purged_at, and write a pipeline_event.
 */
async function purgeOpportunityDocuments(opportunityId) {
  const listed = await listOpportunityFiles(opportunityId);
  let purged = 0;
  if (listed.length > 0) {
    purged = await deleteFromStorage(listed);
  }
  const url = `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opportunityId}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      ..._supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      documents: [],
      docs_purged_at: new Date().toISOString(),
    }),
  });
  if (purged > 0) {
    await _writeEvent(opportunityId, 'docs_purged', null, String(purged));
  }
  return purged;
}

// ---- flagging auth_required without crashing -----------------------------

async function flagAuthRequired(opportunityId, raw_data) {
  const next = { ...(raw_data || {}), download_status: 'auth_required' };
  const url = `${SUPABASE_URL}/rest/v1/opportunities?id=eq.${opportunityId}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      ..._supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ raw_data: next }),
  });
}

module.exports = {
  BUCKET,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_BYTES,
  categorizeFilename,
  sanitizeFilename,
  prioritizeCandidates,
  uploadToStorage,
  deleteFromStorage,
  listOpportunityFiles,
  downloadStorageFile,
  downloadAndStore,
  purgeOpportunityDocuments,
  flagAuthRequired,
};
