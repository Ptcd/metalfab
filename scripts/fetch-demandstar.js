#!/usr/bin/env node
/**
 * fetch-demandstar.js - Scrapes bid opportunities from DemandStar
 * Headless Puppeteer, logs in, scrapes bids page, imports to Supabase
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DS_EMAIL = process.env.DEMANDSTAR_EMAIL;
const DS_PASSWORD = process.env.DEMANDSTAR_PASSWORD;
const MAX_PAGES = parseInt(process.env.DEMANDSTAR_MAX_PAGES || '5');
const DEBUG = process.argv.includes('--debug');

if (!DS_EMAIL || !DS_PASSWORD) {
  console.error('Missing DEMANDSTAR_EMAIL or DEMANDSTAR_PASSWORD in .env.local');
  process.exit(1);
}

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
  const path = require('path').join(__dirname, `debug-ds-${name}.png`);
  return page.screenshot({ path });
}

async function scrape() {
  console.log('🚀 Launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    // Login
    console.log('🔑 Logging into DemandStar...');
    await page.goto('https://www.demandstar.com/app/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#userName', { timeout: 10000 });
    await page.type('#userName', DS_EMAIL, { delay: 30 });
    await page.type('#password', DS_PASSWORD, { delay: 30 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    await new Promise(r => setTimeout(r, 3000));

    console.log(`  After login: ${page.url()}`);
    await debugScreenshot(page, 'after-login');

    // Navigate to bids
    console.log('📋 Loading bids page...');
    await page.goto('https://www.demandstar.com/app/suppliers/bids', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    await debugScreenshot(page, 'bids-page');

    // Extract bids — DemandStar uses card layout, not tables
    let allBids = [];
    let totalImported = 0;
    let totalSkipped = 0;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`📊 Extracting page ${pageNum}...`);

      const bids = await page.evaluate(() => {
        const results = [];
        // Find all bid links: /app/suppliers/bids/{id}/details
        const bidLinks = document.querySelectorAll('a[href*="/bids/"][href*="/details"]');

        bidLinks.forEach(link => {
          const card = link.closest('div') || link.parentElement?.parentElement;
          const text = card?.textContent?.trim() || '';
          const title = link.textContent?.trim();
          const url = link.href;

          // Extract bid ID from URL
          const idMatch = url.match(/\/bids\/(\d+)\//);
          const bidId = idMatch ? idMatch[1] : null;

          // Parse due date: look for "Due: Apr 10, 2026" or similar
          const dateMatch = text.match(/Due[:\s]+(\w+ \d{1,2},?\s*\d{4})/i);
          const dueDate = dateMatch ? dateMatch[1] : null;

          // Parse broadcast date
          const broadcastMatch = text.match(/Broadcast[:\s]+(\w+ \d{1,2},?\s*\d{4})/i);

          // Parse location: "City, County, ST" pattern
          const locMatch = text.match(/,\s*(\w[\w\s]+?),\s*([A-Z]{2})\b/);
          const location = locMatch ? `${locMatch[1].trim()}, ${locMatch[2]}` : null;
          const state = locMatch ? locMatch[2] : null;

          // Parse agency
          const agencyMatch = text.match(/Active\s+(.*?)(?:,\s*\w+,\s*\w+\s*County)/i);
          const agency = agencyMatch ? agencyMatch[1].trim() : null;

          // Parse bid ID/identifier
          const bidIdMatch = text.match(/ID:\s*([^\n]+)/);
          const bidIdentifier = bidIdMatch ? bidIdMatch[1].trim() : null;

          if (title && title.length > 5 && bidId) {
            results.push({
              title,
              url,
              bidId,
              dueDate,
              broadcastDate: broadcastMatch ? broadcastMatch[1] : null,
              location,
              state,
              agency: agency || text.match(/Active\s+(.*?)ID:/s)?.[1]?.trim() || null,
              bidIdentifier,
              rawText: text.substring(0, 500)
            });
          }
        });

        return results;
      });

      console.log(`  Found ${bids.length} bids on page ${pageNum}`);
      if (bids.length === 0) break;

      // Process and import
      let pageImported = 0;
      let pageSkipped = 0;

      for (const bid of bids) {
        // Parse due date to ISO format
        let dueDate = null;
        if (bid.dueDate) {
          try {
            const d = new Date(bid.dueDate);
            if (!isNaN(d)) dueDate = d.toISOString().split('T')[0];
          } catch (e) {}
        }

        let postedDate = null;
        if (bid.broadcastDate) {
          try {
            const d = new Date(bid.broadcastDate);
            if (!isNaN(d)) postedDate = d.toISOString().split('T')[0];
          } catch (e) {}
        }

        const noticeId = `DSTAR-${bid.bidId}`;

        try {
          await supabaseRequest('POST', 'opportunities', {
            sam_notice_id: noticeId,
            title: bid.title,
            source: 'demandstar',
            status: 'new',
            source_url: bid.url,
            agency: bid.agency || 'DemandStar',
            response_deadline: dueDate,
            posted_date: postedDate,
            place_of_performance: bid.location || bid.state,
            raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
          });
          pageImported++;
        } catch (e) {
          if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
            pageSkipped++;
          } else {
            console.error(`  Error: "${bid.title}": ${e.message}`);
          }
        }
      }

      totalImported += pageImported;
      totalSkipped += pageSkipped;
      allBids = allBids.concat(bids);
      console.log(`  Page ${pageNum}: imported ${pageImported}, skipped ${pageSkipped}`);

      // Scroll down to load more (DemandStar may use infinite scroll)
      const prevCount = allBids.length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 3000));

      // Check if new content loaded
      const newBidCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/bids/"][href*="/details"]').length;
      });

      if (newBidCount <= prevCount) {
        // Try clicking a "next" or "load more" button
        const hasMore = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const nextBtn = btns.find(b => {
            const t = b.textContent?.trim().toLowerCase();
            return t === 'next' || t === 'load more' || t === '>' || t === '›';
          });
          if (nextBtn) { nextBtn.click(); return true; }
          return false;
        });

        if (!hasMore) {
          console.log('  No more pages.');
          break;
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    console.log(`\n💾 Total: imported ${totalImported}, skipped ${totalSkipped} from ${allBids.length} bids`);

    // Output summary
    const summary = {
      source: 'demandstar',
      timestamp: new Date().toISOString(),
      bidsFound: allBids.length,
      imported: totalImported,
      skipped: totalSkipped,
      bids: allBids.map(b => ({
        title: b.title, url: b.url, dueDate: b.dueDate,
        location: b.location, state: b.state
      }))
    };

    console.log('\n__DEMANDSTAR_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__DEMANDSTAR_JSON_END__');

    await browser.close();
    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ DemandStar fetch complete. Found ${result.bidsFound} opportunities (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
