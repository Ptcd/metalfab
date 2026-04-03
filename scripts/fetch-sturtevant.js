#!/usr/bin/env node
/**
 * fetch-sturtevant.js - Scrapes RFPs from Village of Sturtevant, WI
 * Site uses Cloudflare protection — needs Puppeteer with stealth plugin
 * Public page at https://www.sturtevant-wi.gov/rfps
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RFPS_URL = 'https://www.sturtevant-wi.gov/rfps';
const DEBUG = process.argv.includes('--debug');

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

function debugScreenshot(page, name) {
  if (!DEBUG) return Promise.resolve();
  const path = require('path').join(__dirname, `debug-sturtevant-${name}.png`);
  return page.screenshot({ path });
}

async function scrape() {
  console.log('🏛️  Launching browser for Sturtevant RFPs...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log('📋 Loading Sturtevant RFPs page...');

    // Navigate with less strict wait to handle Cloudflare redirects
    try {
      await page.goto(RFPS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      console.log(`  Initial nav: ${navErr.message.slice(0, 80)}`);
    }

    // Wait for Cloudflare challenge to resolve (may take 10-15s)
    await new Promise(r => setTimeout(r, 8000));
    await debugScreenshot(page, 'initial');

    // Check if we hit a Cloudflare challenge page
    let pageTitle = '';
    try { pageTitle = await page.title(); } catch(e) { pageTitle = ''; }
    console.log(`  Page title: "${pageTitle}"`);

    if (pageTitle.toLowerCase().includes('just a moment') || pageTitle.toLowerCase().includes('cloudflare') || !pageTitle) {
      console.log('  Cloudflare challenge detected — waiting longer for resolution...');
      await new Promise(r => setTimeout(r, 15000));
      try { pageTitle = await page.title(); } catch(e) { pageTitle = ''; }
      console.log(`  Page title after wait: "${pageTitle}"`);
      await debugScreenshot(page, 'cloudflare-wait');
    }

    // Extract RFP listings from the page
    let rfps;
    try {
    rfps = await page.evaluate(() => {
      const results = [];

      // Strategy 1: Look for links that point to RFP documents or detail pages
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const rfpLinks = allLinks.filter(a => {
        const href = (a.href || '').toLowerCase();
        const text = (a.textContent || '').trim();
        // Include links to PDFs, docs, or links with meaningful RFP-related text
        return (text.length > 5 && (
          href.includes('.pdf') ||
          href.includes('rfp') ||
          href.includes('rfq') ||
          href.includes('bid') ||
          href.includes('proposal') ||
          text.toLowerCase().includes('rfp') ||
          text.toLowerCase().includes('rfq') ||
          text.toLowerCase().includes('bid') ||
          text.toLowerCase().includes('proposal') ||
          text.toLowerCase().includes('request for')
        ));
      });

      rfpLinks.forEach(a => {
        const title = a.textContent.trim();
        const href = a.href;
        // Try to find a date near this link
        const parent = a.closest('li, tr, div, p, article, section');
        const parentText = parent ? parent.textContent.trim() : '';

        // Look for date patterns in nearby text
        let closingDate = null;
        const dateMatch = parentText.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/);
        if (dateMatch) closingDate = dateMatch[1];

        // Also look for written dates like "January 15, 2026"
        if (!closingDate) {
          const writtenDate = parentText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
          if (writtenDate) closingDate = writtenDate[1];
        }

        results.push({
          title,
          href,
          closingDate,
          context: parentText.substring(0, 300),
        });
      });

      // Strategy 2: Look for list items or content blocks with RFP info
      if (results.length === 0) {
        const contentBlocks = document.querySelectorAll('article, .entry-content, .page-content, .content, main, #content, .post-content');
        contentBlocks.forEach(block => {
          const items = block.querySelectorAll('li, h2, h3, h4, p');
          items.forEach(item => {
            const text = item.textContent.trim();
            if (text.length > 10 && (
              text.toLowerCase().includes('rfp') ||
              text.toLowerCase().includes('rfq') ||
              text.toLowerCase().includes('bid') ||
              text.toLowerCase().includes('request for')
            )) {
              const link = item.querySelector('a[href]');
              const href = link ? link.href : null;

              let closingDate = null;
              const dateMatch = text.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/);
              if (dateMatch) closingDate = dateMatch[1];
              const writtenDate = text.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
              if (!closingDate && writtenDate) closingDate = writtenDate[1];

              results.push({
                title: link ? link.textContent.trim() : text.substring(0, 150),
                href,
                closingDate,
                context: text.substring(0, 300),
              });
            }
          });
        });
      }

      // Get body text for debugging
      const bodyText = document.body ? document.body.textContent.substring(0, 3000) : '';

      return { items: results, bodyText };
    });
    } catch (evalErr) {
      console.log(`  Page evaluate failed (likely Cloudflare block): ${evalErr.message.slice(0, 100)}`);
      rfps = { items: [], bodyText: '' };
    }

    console.log(`  Found ${rfps.items.length} RFP items on page`);

    if (rfps.items.length === 0) {
      console.log('  No active RFPs found on the Sturtevant page.');
      if (DEBUG) {
        console.log('  Page body text preview:');
        console.log(rfps.bodyText.substring(0, 500));
      }
    }

    // Deduplicate by href
    const seen = new Set();
    const uniqueRfps = rfps.items.filter(item => {
      const key = item.href || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  ${uniqueRfps.length} unique RFP items after dedup`);

    // Import to Supabase
    let imported = 0;
    let skipped = 0;
    const allBids = [];

    for (const item of uniqueRfps) {
      const title = item.title;
      if (!title || title.length < 5) continue;

      // Create a slug from the title for the notice ID
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);

      const noticeId = `STURT-${slug}`;

      console.log(`  📌 ${title.slice(0, 80)}`);

      // Parse closing date
      let closeDateISO = null;
      if (item.closingDate) {
        try {
          const d = new Date(item.closingDate);
          if (!isNaN(d)) closeDateISO = d.toISOString().split('T')[0];
        } catch (e) {}
      }

      const bid = {
        title,
        href: item.href,
        closingDate: item.closingDate,
        context: item.context,
      };

      allBids.push(bid);

      try {
        await supabaseRequest('POST', 'opportunities', {
          sam_notice_id: noticeId,
          title,
          source: 'sturtevant',
          status: 'new',
          source_url: item.href || RFPS_URL,
          agency: 'Village of Sturtevant',
          response_deadline: closeDateISO,
          place_of_performance: 'Sturtevant, WI',
          raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
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

    await debugScreenshot(page, 'final');
    await browser.close();

    const summary = {
      source: 'sturtevant',
      timestamp: new Date().toISOString(),
      bidsFound: allBids.length,
      imported,
      skipped,
      bids: allBids.map(b => ({
        title: b.title,
        closingDate: b.closingDate,
        href: b.href,
      }))
    };

    console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${allBids.length} RFPs`);

    console.log('\n__STURTEVANT_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__STURTEVANT_JSON_END__');

    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ Sturtevant fetch complete. Found ${result.bidsFound} RFPs (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
