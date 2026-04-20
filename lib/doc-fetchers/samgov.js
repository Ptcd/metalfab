/**
 * SAM.gov doc fetcher.
 *
 * Uses SAM.gov's public resources endpoint:
 *   GET /api/prod/opps/v3/opportunities/<UUID>/resources
 *
 * The UUID lives in the opportunity URL (e.g.
 * sam.gov/opp/f9b90594.../view), NOT in sam_notice_id. We also check
 * raw_data.resourceLinks first for records that already carry them.
 *
 * Only attachments flagged public are downloadable anonymously; controlled
 * ones require a signed-in SAM.gov account and are skipped.
 */

const { categorizeFilename, sanitizeFilename } = require('../documents');

async function findCandidates(opp) {
  const raw = _asObject(opp.raw_data);

  // Some records inline the links
  let inlineLinks = Array.isArray(raw.resourceLinks) ? raw.resourceLinks : [];
  if (inlineLinks.length === 0 && Array.isArray(raw.attachments)) {
    inlineLinks = raw.attachments.map((a) => ({
      url: a.url || a.link,
      name: a.name || a.fileName,
    })).filter((a) => a.url);
  }
  if (inlineLinks.length > 0) {
    return { candidates: _toCandidates(inlineLinks) };
  }

  // Derive the UUID from source_url
  const uuid = _extractUuid(opp.source_url);
  if (!uuid) return { candidates: [], reason: 'no_uuid_in_source_url' };

  const items = await _fetchResources(uuid).catch(() => []);
  if (items.length === 0) {
    return { candidates: [], reason: 'no_public_attachments' };
  }
  return { candidates: _toCandidates(items) };
}

function _asObject(x) {
  if (!x) return {};
  if (typeof x === 'string') { try { return JSON.parse(x); } catch { return {}; } }
  return x;
}

function _extractUuid(url) {
  if (!url) return null;
  const m = url.match(/sam\.gov\/(?:opp|workspace\/contract\/opp)\/([0-9a-f]{32})/i);
  return m ? m[1] : null;
}

async function _fetchResources(uuid) {
  const url = `https://sam.gov/api/prod/opps/v3/opportunities/${uuid}/resources?excludeDeleted=true`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/hal+json',
    },
  });
  if (!res.ok) return [];
  const body = await res.json();
  const lists = body?._embedded?.opportunityAttachmentList || [];
  const all = [];
  for (const list of lists) {
    for (const a of list.attachments || []) {
      if (a.deletedFlag === '1') continue;
      if (a.fileExists !== '1') continue;
      // Only download public attachments — controlled ones need a logged-in
      // SAM.gov account and would 403 anonymously
      const isPublic = a.accessStatus === 'public' || a.accessLevel === 'public';
      if (!isPublic) continue;
      all.push({
        url: `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${a.resourceId}/download`,
        name: a.name || a.title || `${a.resourceId}.pdf`,
      });
    }
  }
  return all;
}

function _toCandidates(items) {
  return items.map((entry) => {
    const url = typeof entry === 'string' ? entry : entry.url || entry.link || '';
    const name = typeof entry === 'object' ? entry.name || entry.fileName : null;
    const filename = sanitizeFilename(name || url.split('/').pop() || 'document.pdf');
    return { url, filename, category: categorizeFilename(filename) };
  }).filter((c) => c.url);
}

module.exports = { findCandidates };
