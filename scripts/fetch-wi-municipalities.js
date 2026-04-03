#!/usr/bin/env node
/**
 * fetch-wi-municipalities.js - Scrapes public bids from multiple WI municipalities
 * All public pages, no login needed. Uses curl + cheerio.
 *
 * Covers: City of Waukesha, Walworth County, Ozaukee County, City of Burlington,
 *         Village of Mount Pleasant, City of South Milwaukee, Village of Pleasant Prairie,
 *         Village of Sturtevant
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const cheerio = require('cheerio');
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function curlFetch(url) {
  try {
    return execSync(
      `curl -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`,
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 20000 }
    );
  } catch (e) {
    return null;
  }
}

async function importBid(bid) {
  const noticeId = `${bid.sourcePrefix}-${(bid.bidNum || bid.title).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;

  try {
    await supabaseRequest('POST', 'opportunities', {
      sam_notice_id: noticeId,
      title: bid.title,
      source: bid.source,
      status: 'new',
      source_url: bid.url,
      agency: bid.agency,
      response_deadline: bid.closeDate,
      posted_date: bid.openDate || null,
      place_of_performance: bid.location,
      point_of_contact: bid.contact || null,
      raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
    });
    return 'imported';
  } catch (e) {
    if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
      return 'skipped';
    }
    console.error(`     Error: ${e.message.slice(0, 100)}`);
    return 'error';
  }
}

function parseDate(str) {
  if (!str) return null;
  try {
    const cleaned = str.replace(/,?\s*at\s+\d+.*$/i, '').replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '');
    const d = new Date(cleaned);
    return isNaN(d) ? null : d.toISOString().split('T')[0];
  } catch (e) { return null; }
}

// ============================================================
// SCRAPERS
// ============================================================

async function scrapeWaukesha() {
  const html = curlFetch('https://www.waukesha-wi.gov/government/departments/current-official-notices.php');
  if (!html) return [];

  const $ = cheerio.load(html);
  const bids = [];

  $('table').first().find('tr').each((i, r) => {
    const cells = $(r).find('td');
    if (cells.length < 2) return;
    const title = $(cells[0]).text().trim();
    const dateStr = $(cells[1]).text().trim();
    const link = $(r).find('a').first().attr('href');

    if (!title || title.toLowerCase().includes('official notice') && title.length < 20) return;

    // Clean doubled text (CMS bug)
    const cleanTitle = title.replace(/(.{20,})\1/, '$1').trim();

    bids.push({
      title: `[Waukesha] ${cleanTitle}`,
      bidNum: cleanTitle.slice(0, 30),
      closeDate: parseDate(dateStr),
      url: link ? (link.startsWith('http') ? link : `https://www.waukesha-wi.gov/${link}`) : 'https://www.waukesha-wi.gov/bids',
      agency: 'City of Waukesha',
      location: 'Waukesha, WI',
      source: 'waukesha',
      sourcePrefix: 'WAUKESHA',
    });
  });

  return bids;
}

async function scrapeCivicEngage(name, url, prefix) {
  const html = curlFetch(url);
  if (!html) return [];

  const $ = cheerio.load(html);
  const bids = [];
  const seen = new Set();

  // Check for "no bids" message first
  const bodyText = $('body').text().toLowerCase();
  if (bodyText.includes('no open bid') || bodyText.includes('no bid posting') || bodyText.includes('there are no open')) {
    console.log(`  (no open bids)`);
    return [];
  }

  // CivicEngage Bids.aspx has bid titles as links within bid listing divs
  // Look for actual bid title links (they link to /bids/BidID/...)
  $('a').each((i, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr('href') || '';

    // Skip UI elements, navigation, filters
    if (text.length < 10) return;
    if (/show me|open bids|closed bids|all department|status:|closes:/i.test(text)) return;
    if (/^\d+ Bid/.test(text)) return; // "1 Bid" counter
    if (text.includes('Department\n')) return;

    // Skip obvious navigation/footer links
    if (/create a website|download adobe|employee wellness|workforce|facebook|twitter|linkedin|agendas? & minutes|birth.*death|land info|aging.*disability|facilities rental|lasata|citizen engagement|calendar|how do i|pay online|report a concern|maps|register to vote|tax bill|traffic acciden|street light|building permit|copyright|contact us|home page|site map|accessibility|privacy policy|terms of use|government websites|powered by|civicplus|email notifications|notify me|rss|subscribe|log ?in|sign ?in|my account|career|job opening|employment|volunteer|parks? ?&? ?rec|library|public health|human service|sheriff|clerk|treasurer|zoning|planning|board.*meeting|committee|commission|ordinance|resolution|election|recycl|compost|yard waste|pet licen|dog licen|camping|boat launch|pool|aquatic|museum|historical|genealogy|vital record/i.test(text)) return;

    // Skip links to common CMS sections (not bids)
    if (/\/(Faq|FAQ|Calendar|Alerts|Notify|Archive|News|Directory|Departments|Services|Government|Residents|Visitors|Business|Community|About)\//i.test(href)) return;

    // Must look like a real bid title — strongly prefer /Bids/ links or PDFs
    if (href.includes('/Bids/') || href.includes('/bids/') || href.includes('.pdf') ||
        (text.length > 20 && !href.includes('#') && !href.includes('javascript') && !href.includes('CivicAlerts') && !href.includes('FAQ') && !href.includes('/Departments/') && !href.includes('/Services/'))) {

      // Clean up multiline text artifacts
      const cleanText = text.replace(/\s+/g, ' ').replace(/View Full.*$/, '').trim();
      if (cleanText.length < 10) return;
      if (seen.has(cleanText)) return;
      seen.add(cleanText);

      // Try to find closing date near this link
      const parent = $(a).closest('div, tr, li');
      const parentText = parent.text();
      const dateMatch = parentText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);

      bids.push({
        title: `[${name}] ${cleanText}`,
        bidNum: cleanText.slice(0, 30),
        closeDate: dateMatch ? parseDate(dateMatch[1]) : null,
        url: href.startsWith('http') ? href : new URL(href, url).href,
        agency: name,
        location: `${name}, WI`,
        source: prefix.toLowerCase(),
        sourcePrefix: prefix,
      });
    }
  });

  return bids;
}

async function scrapeSouthMilwaukee() {
  const html = curlFetch('https://www.southmilwaukee.gov/555/Requests-for-Proposals');
  if (!html) return [];

  const $ = cheerio.load(html);
  const bids = [];

  $('a').each((i, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr('href') || '';
    if (text.length > 10 && (href.includes('DocumentCenter') || href.includes('.pdf'))) {
      // Skip old/closed items
      if (/2024|2023|2022|closed|awarded/i.test(text)) return;

      bids.push({
        title: `[South Milwaukee] ${text}`,
        bidNum: text.slice(0, 30),
        closeDate: null,
        url: href.startsWith('http') ? href : `https://www.southmilwaukee.gov${href}`,
        agency: 'City of South Milwaukee',
        location: 'South Milwaukee, WI',
        source: 'south-milwaukee',
        sourcePrefix: 'SMILW',
      });
    }
  });

  return bids;
}

async function scrapeMtPleasant() {
  const html = curlFetch('https://www.mtpleasantwi.gov/bids');
  if (!html) return [];

  const $ = cheerio.load(html);
  const bids = [];

  // CivicPlus format with document widgets
  $('a').each((i, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr('href') || '';
    if (text.length > 10 && href.includes('.pdf') && !/closed|archive/i.test(text)) {
      bids.push({
        title: `[Mt Pleasant] ${text}`,
        bidNum: text.slice(0, 30),
        closeDate: null,
        url: href.startsWith('http') ? href : `https://www.mtpleasantwi.gov${href}`,
        agency: 'Village of Mount Pleasant',
        location: 'Mount Pleasant, WI',
        source: 'mt-pleasant',
        sourcePrefix: 'MTPL',
      });
    }
  });

  return bids;
}

async function scrapePleasantPrairie() {
  const html = curlFetch('https://www.pleasantprairiewi.gov/services/information/meetings_and_notices/public_notices');
  if (!html) return [];

  const $ = cheerio.load(html);
  const bids = [];

  $('a').each((i, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr('href') || '';
    // Look for bid/RFP related links
    if (text.length > 10 && (/bid|rfp|rfq|solicitation|proposal/i.test(text)) && !(/archive|past|2024|2023/i.test(text))) {
      bids.push({
        title: `[Pleasant Prairie] ${text}`,
        bidNum: text.slice(0, 30),
        closeDate: null,
        url: href.startsWith('http') ? href : `https://www.pleasantprairiewi.gov${href}`,
        agency: 'Village of Pleasant Prairie',
        location: 'Pleasant Prairie, WI',
        source: 'pleasant-prairie',
        sourcePrefix: 'PPWI',
      });
    }
  });

  return bids;
}

// ============================================================
// MAIN
// ============================================================

async function scrape() {
  console.log('🏘️  Fetching bids from WI municipalities...\n');

  const scrapers = [
    { name: 'City of Waukesha',        fn: scrapeWaukesha },
    { name: 'Walworth County',          fn: () => scrapeCivicEngage('Walworth County', 'https://www.co.walworth.wi.us/Bids.aspx', 'WALWORTH') },
    { name: 'Ozaukee County',           fn: () => scrapeCivicEngage('Ozaukee County', 'https://www.ozaukeecounty.gov/Bids.aspx', 'OZAUKEE') },
    { name: 'City of Burlington',       fn: () => scrapeCivicEngage('City of Burlington', 'https://www.burlington-wi.gov/Bids.aspx', 'BURLINGTON') },
    { name: 'South Milwaukee',          fn: scrapeSouthMilwaukee },
    { name: 'Mount Pleasant',           fn: scrapeMtPleasant },
    { name: 'Pleasant Prairie',         fn: scrapePleasantPrairie },
  ];

  let totalImported = 0;
  let totalSkipped = 0;
  let totalBids = 0;

  for (const scraper of scrapers) {
    console.log(`📋 ${scraper.name}...`);
    try {
      const bids = await scraper.fn();
      let imported = 0, skipped = 0;

      for (const bid of bids) {
        const result = await importBid(bid);
        if (result === 'imported') imported++;
        else if (result === 'skipped') skipped++;
      }

      console.log(`  Found ${bids.length} bids (${imported} new, ${skipped} dupes)`);
      bids.forEach(b => console.log(`  📌 ${b.title.slice(0, 75)}`));

      totalImported += imported;
      totalSkipped += skipped;
      totalBids += bids.length;
    } catch (e) {
      console.error(`  ❌ Error: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`\n💾 Total: imported ${totalImported}, skipped ${totalSkipped} from ${totalBids} bids across ${scrapers.length} municipalities`);

  return {
    source: 'wi-municipalities',
    timestamp: new Date().toISOString(),
    bidsFound: totalBids,
    imported: totalImported,
    skipped: totalSkipped,
  };
}

scrape().then(result => {
  console.log(`\n✅ WI municipalities fetch complete. ${result.bidsFound} total bids.`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
