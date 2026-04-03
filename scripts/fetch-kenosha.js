#!/usr/bin/env node
/**
 * fetch-kenosha.js - Scrapes public bids from City of Kenosha
 * No login needed — public page with PDF links to bid documents
 * Bids are numbered XX-YY where YY is the 2-digit year (e.g., 01-26 = first bid of 2026)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const cheerio = require('cheerio');
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDS_URL = 'https://www.kenosha.org/departments/finance/bid_solicitations.php';
const BASE_URL = 'https://www.kenosha.org/departments/finance';

// Current 2-digit year for filtering
const CURRENT_YEAR_2D = new Date().getFullYear().toString().slice(-2); // "26"

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

async function scrape() {
  console.log('🏙️  Fetching City of Kenosha bids page...');

  let html;
  try {
    html = execSync(
      `curl -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${BIDS_URL}"`,
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 30000 }
    );
  } catch (e) {
    throw new Error(`Failed to fetch ${BIDS_URL}: ${e.message}`);
  }

  if (!html || html.length < 500) {
    throw new Error(`Empty or too-short response from ${BIDS_URL}`);
  }

  const $ = cheerio.load(html);
  console.log('📋 Parsing bid links...');

  const bids = [];
  const seenIds = new Set();

  // Kenosha bids are PDF links numbered XX-YY (e.g., "01-26", "02-26")
  // Filter for current year only, skip addenda and tabulations
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href') || '';

    // Match bid number pattern: XX-YY where YY is current year
    const bidNumMatch = text.match(new RegExp(`^(\\d{2}-${CURRENT_YEAR_2D})\\s+(.+)`, 'i'));
    if (!bidNumMatch) return;

    // Skip addenda, tabulations, response memos
    if (/addendum|tabulation|memo|response|revised/i.test(text)) return;

    const bidNum = bidNumMatch[1]; // e.g., "01-26"
    const description = bidNumMatch[2].trim();

    // Deduplicate by bid number
    if (seenIds.has(bidNum)) return;
    seenIds.add(bidNum);

    // Build PDF URL
    let pdfUrl = href;
    if (pdfUrl && !pdfUrl.startsWith('http')) {
      // Kenosha uses relative paths from the page
      pdfUrl = `${BASE_URL}/${pdfUrl}`;
    }

    // Try to find closing date near this link
    const parent = $(el).closest('td, div, tr');
    const parentText = parent.text();
    const dateMatches = parentText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4})/g);

    let openDate = null;
    let closeDate = null;
    if (dateMatches && dateMatches.length >= 2) {
      openDate = dateMatches[0];
      closeDate = dateMatches[1];
    } else if (dateMatches && dateMatches.length === 1) {
      closeDate = dateMatches[0];
    }

    bids.push({
      bidNum,
      description,
      pdfUrl,
      openDate,
      closeDate,
    });
  });

  // Also scan for bids that might not be PDF links but are in the table
  const bodyText = $('body').text();
  const bidPattern = new RegExp(`(\\d{2}-${CURRENT_YEAR_2D})\\s+([^\\n]{10,150})`, 'gi');
  let match;
  while ((match = bidPattern.exec(bodyText)) !== null) {
    const bidNum = match[1];
    const desc = match[2].trim();
    if (seenIds.has(bidNum)) continue;
    if (/addendum|tabulation|memo|revised/i.test(desc)) continue;
    seenIds.add(bidNum);
    bids.push({
      bidNum,
      description: desc,
      pdfUrl: null,
      openDate: null,
      closeDate: null,
    });
  }

  console.log(`  Found ${bids.length} current-year bids\n`);

  if (bids.length === 0) {
    console.log('ℹ️  No current-year bids found. Kenosha may have no open solicitations right now.');
    return { source: 'kenosha', bidsFound: 0, imported: 0, skipped: 0, bids: [] };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const bid of bids) {
    let closeDateISO = null;
    if (bid.closeDate) {
      try {
        const d = new Date(bid.closeDate);
        if (!isNaN(d)) closeDateISO = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    let openDateISO = null;
    if (bid.openDate) {
      try {
        const d = new Date(bid.openDate);
        if (!isNaN(d)) openDateISO = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    const noticeId = `KENOSHA-${bid.bidNum}`;

    console.log(`  📌 [${bid.bidNum}] ${bid.description.slice(0, 75)}`);
    console.log(`     Opens: ${bid.openDate || 'N/A'} | Closes: ${bid.closeDate || 'N/A'}`);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[Kenosha ${bid.bidNum}] ${bid.description}`,
        source: 'kenosha',
        status: 'new',
        source_url: bid.pdfUrl || BIDS_URL,
        agency: 'City of Kenosha',
        response_deadline: closeDateISO,
        posted_date: openDateISO,
        place_of_performance: 'Kenosha, WI',
        raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString(), page_url: BIDS_URL }),
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
    source: 'kenosha',
    timestamp: new Date().toISOString(),
    bidsFound: bids.length,
    imported,
    skipped,
    bids: bids.map(b => ({
      bidNum: b.bidNum,
      description: b.description,
      closeDate: b.closeDate,
      pdfUrl: b.pdfUrl,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${bids.length} bids`);

  console.log('\n__KENOSHA_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__KENOSHA_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ City of Kenosha fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
