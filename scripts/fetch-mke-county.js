#!/usr/bin/env node
/**
 * fetch-mke-county.js - Scrapes public bids from Milwaukee County
 * No login needed — public page with links to active bids
 * Huge volume: 100+ active bids/RFPs at any time
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const cheerio = require('cheerio');
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDS_URL = 'https://county.milwaukee.gov/EN/Admin-Services/Bids-and-RFPs';
const BASE_URL = 'https://county.milwaukee.gov';

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
  console.log('🏛️  Fetching Milwaukee County bids page...');

  // Node fetch gets 403'd — use curl with retry
  let html;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      html = execSync(
        `curl -s -L --connect-timeout 15 --max-time 30 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept: text/html,application/xhtml+xml" -H "Accept-Language: en-US,en;q=0.9" "${BIDS_URL}"`,
        { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 45000 }
      );
      if (html && html.length > 500) break;
      console.log(`  Attempt ${attempt}: got ${html ? html.length : 0} bytes — retrying...`);
      html = null;
    } catch (e) {
      console.log(`  Attempt ${attempt} failed: ${e.message.slice(0, 80)}`);
      html = null;
    }
    if (attempt < MAX_RETRIES) {
      const delay = attempt * 3000;
      console.log(`  Waiting ${delay/1000}s before retry...`);
      execSync(`ping -n ${Math.ceil(delay/1000)} 127.0.0.1 > nul`, { encoding: 'utf8', timeout: delay + 2000 });
    }
  }
  if (!html || html.length < 500) {
    throw new Error(`Failed to fetch ${BIDS_URL} after ${MAX_RETRIES} attempts`);
  }

  const $ = cheerio.load(html);
  console.log('📋 Parsing bid links...');

  const bids = [];
  const seenUrls = new Set();

  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();

    // Match active bid links — they follow these patterns:
    // /EN/Administrative-Services/Bids-and-RFPs/Active/...
    // /EN/Admin-Services/Bids-and-RFPs/...
    // /files/county/administrative-services/Procurement/Bids-and-RFPs/...  (PDFs)
    const isActiveBid = (
      href.includes('/Bids-and-RFPs/Active/') ||
      (href.includes('/Bids-and-RFPs/') && !href.includes('/Bids-and-RFPs/Active') && href.split('/').length > 5) ||
      (href.includes('/Bids-and-RFPs/') && href.endsWith('.pdf'))
    );

    if (!isActiveBid) return;
    if (text.length < 5) return;

    // Skip navigation/header links that just say "Bids & RFPs"
    if (/^bids?\s*[&and]*\s*rfps?$/i.test(text)) return;
    if (/^bid & contract/i.test(text)) return;

    // Make URL absolute
    let fullUrl = href;
    if (!fullUrl.startsWith('http')) {
      fullUrl = BASE_URL + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
    }

    // Deduplicate by URL path (normalize)
    const urlKey = fullUrl.replace(/https?:\/\/[^/]+/, '').toLowerCase().replace(/[-_]/g, '');
    if (seenUrls.has(urlKey)) return;
    seenUrls.add(urlKey);

    // Determine bid type from title/URL
    let bidType = 'bid';
    if (/^rfp[:\s]/i.test(text) || href.includes('RFP')) bidType = 'rfp';
    if (/^rfq[:\s]/i.test(text) || href.includes('RFQ')) bidType = 'rfq';
    if (/^rfi[:\s]/i.test(text) || href.includes('RFI')) bidType = 'rfi';
    if (/^soq[:\s]/i.test(text) || href.includes('SOQ')) bidType = 'soq';
    if (href.endsWith('.pdf')) bidType = 'pdf';

    // Extract project code from title (e.g., WA0418, WP0320, WT015801)
    const codeMatch = text.match(/\b([A-Z]{1,3}\d{3,8}(?:[-]\d+)?)\b/);
    const projectCode = codeMatch ? codeMatch[1] : null;

    // Clean up title — remove leading "RFP: ", "BID: ", "RFQ: " etc.
    let cleanTitle = text.replace(/^(RFP|RFQ|RFI|SOQ|BID|ARPA)[:\s]+/i, '').trim();

    bids.push({
      title: cleanTitle,
      fullTitle: text,
      url: fullUrl,
      bidType,
      projectCode,
      isPdf: href.endsWith('.pdf'),
    });
  });

  console.log(`  Found ${bids.length} active bids/RFPs\n`);

  if (bids.length === 0) {
    console.log('⚠️  No bids found — page structure may have changed.');
    return { source: 'mke-county', bidsFound: 0, imported: 0, skipped: 0, bids: [] };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const bid of bids) {
    // Create unique ID from project code or URL slug
    const idBase = bid.projectCode || bid.url.split('/').pop().replace(/\.pdf$/, '').slice(0, 40);
    const noticeId = `MKECO-${idBase.replace(/[^a-zA-Z0-9]/g, '')}`;

    console.log(`  📌 [${bid.bidType.toUpperCase()}] ${bid.title.slice(0, 75)}`);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: bid.fullTitle,
        source: 'mke-county',
        status: 'new',
        source_url: bid.url,
        agency: 'Milwaukee County',
        place_of_performance: 'Milwaukee County, WI',
        raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString(), page_url: BIDS_URL }),
      });
      imported++;
    } catch (e) {
      if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
        skipped++;
      } else {
        console.error(`     Error: ${e.message}`);
      }
    }
  }

  const summary = {
    source: 'mke-county',
    timestamp: new Date().toISOString(),
    bidsFound: bids.length,
    imported,
    skipped,
    bids: bids.map(b => ({
      title: b.fullTitle,
      url: b.url,
      bidType: b.bidType,
      projectCode: b.projectCode,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${bids.length} bids`);

  console.log('\n__MKECOUNTY_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__MKECOUNTY_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ Milwaukee County fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
