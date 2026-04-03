#!/usr/bin/env node
/**
 * fetch-demandstar.js - Scrapes bid opportunities from DemandStar/OpenBids
 * Headless Puppeteer, logs in, paginates through numbered pages,
 * extracts state from location text, filters to upper midwest, imports to Supabase.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DS_EMAIL = process.env.DEMANDSTAR_EMAIL;
const DS_PASSWORD = process.env.DEMANDSTAR_PASSWORD;
const MAX_PAGES = parseInt(process.env.DEMANDSTAR_MAX_PAGES || '50');
const DEBUG = process.argv.includes('--debug');

// Upper midwest states to keep
const ALLOWED_STATES = new Set(['WI', 'IL', 'IN', 'MI', 'MN', 'IA']);

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
  console.log(`  [DEBUG] Screenshot: ${path}`);
  return page.screenshot({ path, fullPage: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Extract bids from the current page.
 * Each bid card on DemandStar/OpenBids shows:
 *   Title (link to /bids/{id}/details)
 *   Agency Name, City, County, ST - DemandStar Extended Network
 *   ID: XXX
 *   Broadcast: date   Due: date   Planholders: N   Watchers: N
 *
 * We use page.evaluate to get structured data from each card.
 */
async function extractBidsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const bidLinks = document.querySelectorAll('a[href*="/bids/"][href*="/details"]');

    bidLinks.forEach(link => {
      const url = link.href;
      const title = link.textContent?.trim();

      const idMatch = url.match(/\/bids\/(\d+)\//);
      const bidId = idMatch ? idMatch[1] : null;
      if (!title || title.length <= 5 || !bidId) return;

      // Find the card container: walk up parents but stop before we
      // reach a container that holds multiple bid cards.
      let card = link.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!card || !card.parentElement) break;
        const parent = card.parentElement;
        const linksInParent = parent.querySelectorAll('a[href*="/bids/"][href*="/details"]');
        if (linksInParent.length > 1) break;
        card = parent;
      }

      // Get the card's inner text (includes agency, location, dates)
      const text = card?.innerText?.trim() || '';

      // Extract the location line specifically. It typically contains:
      // "Agency, City, County, ST - DemandStar Extended Network"
      // or just "Agency - DemandStar Extended Network"
      // The state code is right before " - DemandStar" or "- Demand"
      let state = null;
      let location = null;

      // Look for ", ST - " pattern (state before dash)
      const stateBeforeDash = text.match(/,\s*([A-Z]{2})\s+-\s/);
      if (stateBeforeDash && stateBeforeDash[1] !== 'ID') {
        state = stateBeforeDash[1];
      }

      // If that didn't work, try "County, ST" pattern
      if (!state) {
        const countyState = text.match(/County,\s*([A-Z]{2})\b/);
        if (countyState && countyState[1] !== 'ID') {
          state = countyState[1];
        }
      }

      // Extract location: "City, County, ST" (on a single line)
      // Split by lines first to avoid matching across line breaks
      const textLines = text.split('\n');
      for (const line of textLines) {
        const locMatch = line.match(/([\w\s.'-]+County),\s*([A-Z]{2})\b/);
        if (locMatch && locMatch[2] !== 'ID') {
          location = `${locMatch[1].trim()}, ${locMatch[2]}`;
          break;
        }
      }

      // Extract dates
      let dueDate = null;
      const dueMatch = text.match(/Due[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
      if (dueMatch) dueDate = dueMatch[1];

      let broadcastDate = null;
      const bcastMatch = text.match(/Broadcast[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
      if (bcastMatch) broadcastDate = bcastMatch[1];

      // Extract agency: typically the first text line after the title
      // It's often the line containing the organization name before location details
      let agency = null;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        if (line === title) continue;
        if (line.startsWith('ID:') || line.startsWith('Broadcast') || line.startsWith('Due')) continue;
        if (/^\d+$/.test(line)) continue;
        if (line.length > 5) {
          // This is likely the agency/location line
          agency = line.split(' - ')[0].trim(); // Remove "- DemandStar Extended Network"
          if (agency.length > 200) agency = agency.substring(0, 200);
          break;
        }
      }

      results.push({
        title, url, bidId, state, location, dueDate, broadcastDate, agency,
        rawText: text.substring(0, 1200)
      });
    });

    return results;
  });
}

/**
 * Click to go to the next page using numbered pagination.
 * The pagination shows: 1, 2, 3, 4, 5, 6, 7, ...
 */
async function clickPageNumber(page, targetNum) {
  // Use the approach from the working version: find all clickable elements
  // and match by text content + pagination context
  return page.evaluate((num) => {
    const numStr = String(num);

    // Strategy 1: Find pagination links/buttons by number
    const allClickable = Array.from(document.querySelectorAll('a, button'));
    for (const el of allClickable) {
      if (el.textContent.trim() === numStr) {
        // Verify it's in a pagination context by checking siblings
        const parent = el.parentElement;
        if (!parent) continue;
        const siblings = Array.from(parent.parentElement?.children || parent.children || []);
        const numberSiblings = siblings.filter(s => {
          const t = s.textContent.trim();
          return /^\d+$/.test(t) || t === '>' || t === '<' || t === '>>' || t === '<<'
              || t === '\u203A' || t === '\u2039' || t === '\u00BB' || t === '\u00AB';
        });
        if (numberSiblings.length >= 3) {
          el.click();
          return true;
        }
      }
    }

    // Strategy 2: Find list items with the page number
    const listItems = Array.from(document.querySelectorAll('li'));
    for (const li of listItems) {
      if (li.textContent.trim() === numStr) {
        const link = li.querySelector('a, button') || li;
        const ul = li.parentElement;
        if (ul) {
          const siblingNums = Array.from(ul.children).filter(c => /^\d+$/.test(c.textContent.trim()));
          if (siblingNums.length >= 3) {
            link.click();
            return true;
          }
        }
      }
    }

    return false;
  }, targetNum);
}

async function scrape() {
  console.log('Launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    // Login
    console.log('Logging into DemandStar...');
    await page.goto('https://www.demandstar.com/app/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#userName', { timeout: 10000 });
    await page.type('#userName', DS_EMAIL, { delay: 30 });
    await page.type('#password', DS_PASSWORD, { delay: 30 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    await sleep(3000);
    console.log(`  After login: ${page.url()}`);
    await debugScreenshot(page, 'after-login');

    // Navigate to bids
    console.log('Loading bids page...');
    await page.goto('https://www.demandstar.com/app/suppliers/bids', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);
    await debugScreenshot(page, 'bids-page');

    // Get total count
    const totalText = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/(\d+)\s*-\s*\d+\s+of\s+(\d+)/);
      return m ? { showing: m[0], total: parseInt(m[2]) } : null;
    });
    if (totalText) {
      console.log(`  ${totalText.showing} (${totalText.total} total bids)`);
    }

    // Paginate through all pages extracting bids
    const allBids = new Map();
    let pageNum = 1;
    let noNewCount = 0;

    while (pageNum <= MAX_PAGES) {
      const bids = await extractBidsFromPage(page);
      let newOnPage = 0;

      for (const bid of bids) {
        if (!allBids.has(bid.bidId)) {
          allBids.set(bid.bidId, bid);
          newOnPage++;
        }
      }

      console.log(`  Page ${pageNum}: ${bids.length} bids (${newOnPage} new), total unique: ${allBids.size}`);

      if (bids.length === 0) break;
      if (newOnPage === 0) {
        noNewCount++;
        if (noNewCount >= 2) {
          console.log('  No new bids for 2 consecutive pages, stopping.');
          break;
        }
      } else {
        noNewCount = 0;
      }

      // Click next page
      pageNum++;
      const clicked = await clickPageNumber(page, pageNum);
      if (!clicked) {
        // Try "Next" or ">" button as fallback
        const nextClicked = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('a, button'));
          const next = els.find(e => {
            const t = e.textContent.trim();
            const aria = e.getAttribute('aria-label') || '';
            return t === '>' || t === '>>' || t === '\u203A' || t === '\u00BB'
                || t === 'Next' || aria.toLowerCase().includes('next');
          });
          if (next && !next.disabled) {
            next.click();
            return true;
          }
          return false;
        });
        if (!nextClicked) {
          console.log('  No more pages available.');
          break;
        }
      }

      await sleep(3000);
    }

    await debugScreenshot(page, 'final');
    console.log(`\nTotal unique bids extracted: ${allBids.size}`);

    // Filter to target states and import
    let totalImported = 0;
    let totalSkipped = 0;
    let totalFiltered = 0;
    const importedBids = [];

    for (const [bidId, bid] of allBids) {
      const state = bid.state;

      // Filter by state
      if (!state || !ALLOWED_STATES.has(state)) {
        totalFiltered++;
        if (DEBUG && state) console.log(`  [FILTERED] "${bid.title}" - ${state}`);
        else if (DEBUG) console.log(`  [FILTERED-NO-STATE] "${bid.title}"`);
        continue;
      }

      // Parse dates to ISO
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

      const noticeId = `DSTAR-${bidId}`;

      try {
        await supabaseRequest('POST', 'opportunities', {
          sam_notice_id: noticeId,
          title: bid.title,
          source: 'demandstar',
          status: 'new',
          source_url: bid.url,
          agency: (bid.agency && !bid.agency.includes('Dashboard') && !bid.agency.includes('\n') && bid.agency.length < 100) ? bid.agency : 'DemandStar',
          response_deadline: dueDate,
          posted_date: postedDate,
          place_of_performance: bid.location || state,
          raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
        });
        totalImported++;
        importedBids.push({ title: bid.title, state, location: bid.location, dueDate });
        console.log(`  [IMPORTED] ${noticeId}: "${bid.title}" (${state}, ${bid.location || ''})`);
      } catch (e) {
        if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
          totalSkipped++;
        } else {
          console.error(`  [ERROR] "${bid.title}": ${e.message}`);
        }
      }
    }

    console.log(`\nResults: ${allBids.size} found, ${totalFiltered} filtered (wrong/no state), ${totalImported} imported, ${totalSkipped} dupes`);

    const summary = {
      source: 'demandstar',
      timestamp: new Date().toISOString(),
      bidsFound: allBids.size,
      bidsFiltered: totalFiltered,
      imported: totalImported,
      skipped: totalSkipped,
      bids: importedBids
    };

    console.log('\n__DEMANDSTAR_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__DEMANDSTAR_JSON_END__');

    await browser.close();
    return summary;

  } catch (err) {
    console.error('Error:', err.message);
    if (DEBUG) console.error(err.stack);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\nDemandStar fetch complete. Found ${result.bidsFound} opportunities, filtered ${result.bidsFiltered}, ${result.imported} new, ${result.skipped} dupes.`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
