#!/usr/bin/env node
/**
 * fetch-cullen.js - Scrapes bidding projects from JP Cullen Plan Room
 *
 * JP Cullen (jpcullen.com) is a major Wisconsin GC. Their plan room at
 * cullenbids.com lists projects open for subcontractor bidding.
 *
 * The plan room is powered by Pantera Tools (Hubexo). Two data paths:
 *   1. Public XML endpoint (no auth) — project name, date, city, state
 *   2. Authenticated Pantera API — full scope descriptions, contacts, coordinates
 *
 * We use Puppeteer to login and hit the authenticated API for richer data,
 * falling back to the public XML if login fails.
 *
 * The authenticated API returns project notes with full scope of work,
 * e.g. "structural steel, steel joists and deck, rough carpentry..."
 * which is critical for scoring metalfab relevance.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Cullen Plan Room
const BASE_URL = 'https://www.cullenbids.com';
const API_URL = 'https://api.tm.panteratools.com';
const CULLEN_USER = process.env.CULLEN_USER || 'tcbmetalworks@aol.com';
const CULLEN_PASS = process.env.CULLEN_PASS || 'Steelbid123!';

async function supabaseRequest(method, endpoint, body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

function curlFetch(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const html = execSync(
        `curl -s -L --connect-timeout 15 --max-time 30 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept: text/xml, text/html, */*" "${url}"`,
        { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 45000 }
      );
      if (html && html.length > 100) return html;
      console.log(`  Attempt ${attempt}: short response (${html?.length || 0} chars) — retrying...`);
    } catch (e) {
      console.log(`  Attempt ${attempt} failed: ${e.message.slice(0, 80)}`);
    }
    if (attempt < retries) {
      execSync(`ping -n ${attempt * 2} 127.0.0.1 > nul`, { encoding: 'utf8', timeout: 10000 });
    }
  }
  return null;
}

// ─── Strategy 1: Authenticated API via Puppeteer ────────────────────────

async function scrapeAuthenticated() {
  console.log('  🔑 Attempting authenticated scrape via Pantera API...');

  try {
    // Step 1: Get token via Pantera auth endpoint
    // POST https://api-v2.panteratools.com/token?username=...&password=...
    const encodedUser = encodeURIComponent(CULLEN_USER);
    const encodedPass = encodeURIComponent(CULLEN_PASS);
    const tokenUrl = `https://api-v2.panteratools.com/token?username=${encodedUser}&password=${encodedPass}`;

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!tokenRes.ok) {
      console.log(`  ⚠️  Token request failed: ${tokenRes.status}`);
      return null;
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.accessToken || tokenData.access_token || tokenData.token;
    const refreshToken = tokenData.refreshToken || tokenData.refresh_token;

    if (!accessToken) {
      console.log('  ⚠️  No access token in response');
      console.log(`  Token response keys: ${Object.keys(tokenData).join(', ')}`);
      return null;
    }

    console.log('  ✅ Got access token from api-v2');

    // Step 2: Exchange token with api.tm — call /token/signin to activate session
    const signinRes = await fetch(`${API_URL}/token/signin`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    let signinToken = accessToken;
    let signinCookie = null;
    if (signinRes.ok) {
      try {
        const signinData = await signinRes.json();
        signinToken = signinData.token || signinData.accessToken || accessToken;
        signinCookie = signinData.cookie || null;
        console.log(`  ✅ Session activated (has cookie: ${!!signinCookie}, has token: ${!!signinData.token})`);
      } catch (e) {
        console.log('  ✅ Session activated (no JSON body)');
      }
    } else {
      console.log(`  ⚠️  /token/signin returned ${signinRes.status}`);
    }

    // Also grab Set-Cookie headers from signin response
    const setCookies = signinRes.headers.get('set-cookie') || '';

    // Step 3: Fetch projects — try multiple auth approaches
    const authHeaders = [
      // Try 1: Bearer with signin token
      { 'Authorization': `Bearer ${signinToken}` },
      // Try 2: Bearer with original token + cookie header
      { 'Authorization': `Bearer ${accessToken}`, 'Cookie': signinCookie || '' },
      // Try 3: Cookie only
      { 'Cookie': signinCookie || setCookies },
    ];

    let projRes = null;
    for (const headers of authHeaders) {
      if (!headers.Cookie && !headers.Authorization) continue;
      projRes = await fetch(`${API_URL}/projects?isBidding=true`, { headers });
      if (projRes.ok) break;
    }

    if (!projRes || !projRes.ok) {
      console.log(`  ⚠️  Projects API failed with all auth methods (likely needs browser cookies)`);
      console.log('  Falling back to public XML...');
      return null;
    }

    const projects = await projRes.json();
    if (!Array.isArray(projects)) {
      console.log('  ⚠️  Projects response is not an array');
      return null;
    }

    console.log(`  📊 Authenticated API returned ${projects.length} projects`);

    // Transform to our format
    return projects.map(p => {
      const projNumMatch = (p.projectName || '').match(/^(\d{4,6}[-]?\d{0,4})\s+/);
      return {
        rowId: String(p.projectId),
        projectKey: null,
        projectNum: projNumMatch ? projNumMatch[1].trim() : null,
        title: (p.projectName || '').trim(),
        description: (p.notes || '').trim(),
        bidDate: p.rDueText || null,
        bidDateISO: p.bidsDue ? p.bidsDue.split('T')[0] : null,
        division: null,
        city: p.city || '',
        state: p.state || '',
        zip: p.zip || '',
        url: `${BASE_URL}/#biddingprojects`,
        // Rich data from authenticated API
        contactName: p.user?.displayName || null,
        contactName2: p.user2?.displayName || null,
        latitude: p.latitude,
        longitude: p.longitude,
        status: p.status,
      };
    });

  } catch (err) {
    console.log(`  ⚠️  Authenticated scrape failed: ${err.message}`);
    return null;
  }
}

// ─── Strategy 2: Public XML endpoint (fallback) ────────────────────────

function parseXmlGrid(xml) {
  const projects = [];
  const rowRegex = /<row\s+id="(\d+)">([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowId = rowMatch[1];
    const rowContent = rowMatch[2];

    const keyMatch = rowContent.match(/<userdata name="ProjectKey">(.*?)<\/userdata>/);
    const projectKey = keyMatch ? keyMatch[1] : null;

    const descMatch = rowContent.match(/<userdata name="Description"><!\[CDATA\[(.*?)\]\]><\/userdata>/);
    const descriptionXml = descMatch ? descMatch[1].trim() : null;

    const cellRegex = /<cell><!\[CDATA\[(.*?)\]\]><\/cell>/g;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      cells.push(cellMatch[1].trim());
    }

    if (cells.length >= 5) {
      const bidDate = cells[0];
      const project = cells[1];
      const division = cells[2];
      const city = cells[3];
      const state = cells[4];

      const projNumMatch = project.match(/^(\d{4,6}[-]?\d{0,4})\s+/);
      const projectNum = projNumMatch ? projNumMatch[1].trim() : null;

      let bidDateISO = null;
      if (bidDate) {
        const dateMatch = bidDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dateMatch) bidDateISO = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`;
      }

      const projectUrl = projectKey
        ? `${BASE_URL}/#biddingprojects/${projectKey}`
        : `${BASE_URL}/#biddingprojects`;

      projects.push({
        rowId, projectKey, projectNum,
        title: project,
        description: descriptionXml || '',
        bidDate, bidDateISO, division, city, state,
        url: projectUrl,
      });
    }
  }
  return projects;
}

async function scrapePublic() {
  console.log('  📡 Using public XML endpoint (no auth)...');

  // Get session ID from home page
  const homeHtml = curlFetch(`${BASE_URL}/`);
  if (!homeHtml) throw new Error('Could not fetch Cullen home page');

  const match = homeHtml.match(/bbSessionId\s*=\s*'([^']+)'/) || homeHtml.match(/pjqSessionId\s*=\s*'([^']+)'/);
  if (!match) throw new Error('Could not extract session ID');

  const sessionId = match[1];
  console.log(`  Session: ${sessionId.substring(0, 8)}...`);

  const ts = Date.now();
  const gridUrl = `${BASE_URL}/DesktopModules/PJQPublicProjects/GetGrid.aspx?sessionid=${sessionId}&searchfor=&state=&zip=&radius=0&x=${ts}`;

  const xml = curlFetch(gridUrl);
  if (!xml || !xml.includes('<rows>')) throw new Error('Failed to fetch project grid XML');

  return parseXmlGrid(xml);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function scrape() {
  console.log('🏗️  Fetching JP Cullen Plan Room (cullenbids.com)...');

  // Try authenticated first (richer data with full scope descriptions)
  // Note: Pantera API auth requires browser-level cookies from Token.ashx redirect flow.
  // Direct REST auth gets a token but projects endpoint needs session cookies.
  // TODO: Revisit with Puppeteer cookie extraction if richer data is needed.
  let projects = null; // await scrapeAuthenticated(); // disabled — see note above
  let authMode = 'authenticated';

  // Fallback to public XML
  if (!projects || projects.length === 0) {
    authMode = 'public';
    projects = await scrapePublic();
  }

  console.log(`  Found ${projects.length} bidding projects via ${authMode} API\n`);

  if (projects.length === 0) {
    console.log('ℹ️  No bidding projects found. JP Cullen may have no open bids right now.');
    return { source: 'cullen', projectsFound: 0, imported: 0, skipped: 0, projects: [] };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const proj of projects) {
    console.log(`  📌 [${proj.projectNum || proj.rowId}] ${proj.title}`);
    console.log(`     Bid Date: ${proj.bidDate || 'unknown'} | City: ${proj.city}, ${proj.state}`);
    if (proj.description && proj.description.length > 50) {
      console.log(`     Scope: ${proj.description.substring(0, 120)}...`);
    }

    const noticeId = `CULLEN-${proj.rowId}`;

    // Build description: prefer rich notes from authenticated API
    let descText = `GC: JP Cullen & Sons`;
    if (proj.division) descText += ` | Division: ${proj.division}`;
    if (proj.bidDate) descText += ` | Bid Date: ${proj.bidDate}`;
    if (proj.contactName) descText += ` | Contact: ${proj.contactName}`;
    if (proj.description && proj.description.length > 20) {
      descText += `\n\n${proj.description}`;
    }

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[Cullen] ${proj.title}`,
        source: 'cullen',
        status: 'new',
        source_url: proj.url,
        agency: 'JP Cullen & Sons',
        response_deadline: proj.bidDateISO,
        place_of_performance: `${proj.city}, ${proj.state}`,
        description: descText,
        raw_data: JSON.stringify({
          ...proj,
          gc: 'JP Cullen & Sons',
          source_type: 'private_gc',
          auth_mode: authMode,
          scraped_at: new Date().toISOString(),
        }),
        posted_date: new Date().toISOString().split('T')[0],
      });
      imported++;
    } catch (e) {
      if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
        skipped++;
        console.log(`     (already in DB)`);
      } else {
        console.error(`     Error: ${e.message}`);
      }
    }
  }

  const summary = {
    source: 'cullen',
    timestamp: new Date().toISOString(),
    authMode,
    projectsFound: projects.length,
    imported,
    skipped,
    projects: projects.map(p => ({
      projectNum: p.projectNum,
      title: p.title,
      bidDate: p.bidDate,
      city: p.city,
      state: p.state,
      url: p.url,
      hasDescription: (p.description || '').length > 50,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${projects.length} projects`);

  console.log('\n__CULLEN_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__CULLEN_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ JP Cullen fetch complete (${result.authMode}). Found ${result.projectsFound} projects (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
