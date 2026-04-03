#!/usr/bin/env node
/**
 * fetch-bidnet.js - Scrapes matched bid opportunities from BidNet Direct
 * Runs headless Puppeteer with stealth, logs in, finds matched bids, imports to Supabase
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDNET_EMAIL = process.env.BIDNET_EMAIL;
const BIDNET_PASSWORD = process.env.BIDNET_PASSWORD;
const DEBUG = process.argv.includes('--debug');

if (!BIDNET_EMAIL || !BIDNET_PASSWORD) {
  console.error('Missing BIDNET_EMAIL or BIDNET_PASSWORD in .env.local');
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
  const path = require('path').join(__dirname, `debug-${name}.png`);
  console.log(`  📸 Debug screenshot: ${path}`);
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
    // Step 1: Login
    console.log('🔑 Logging into BidNet Direct...');
    await page.goto('https://www.bidnetdirect.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000)); // Let SSO redirect settle

    await debugScreenshot(page, 'login');
    console.log(`  Login page URL: ${page.url()}`);

    // BidNet redirects to SSO with j_username / j_password fields
    await page.waitForSelector('#j_username, input[name="j_username"]', { timeout: 15000 });

    await page.type('#j_username', BIDNET_EMAIL, { delay: 30 });
    await page.type('#j_password', BIDNET_PASSWORD, { delay: 30 });

    // Click login and wait for redirect — use Promise.all to avoid race
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {
        console.log('  Navigation timeout after login click, continuing...');
      }),
      page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const loginBtn = allBtns.find(b => b.textContent?.toLowerCase().includes('login'));
        if (loginBtn) loginBtn.click();
      }),
    ]);

    // BidNet does multiple redirects (SSO → callback → dashboard), wait for final
    await new Promise(r => setTimeout(r, 5000));
    // If still on SSO page, wait for one more redirect
    if (page.url().includes('idp.bidnetdirect.com')) {
      console.log('  Still on SSO, waiting for redirect...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    }

    await debugScreenshot(page, 'after-login');
    console.log(`  After login URL: ${page.url()}`);

    // Check if login succeeded
    const loginFailed = await page.evaluate(() => {
      const body = document.body.textContent?.toLowerCase() || '';
      return body.includes('invalid username') || body.includes('invalid credentials') ||
             body.includes('login failed') || body.includes('authentication failed');
    });
    if (loginFailed) throw new Error('Login failed — check BIDNET_EMAIL and BIDNET_PASSWORD in .env.local');

    // Step 2: Find solicitations
    console.log('📋 Exploring dashboard for bid listings...');

    // First, catalog all navigation links on dashboard
    const navLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.href,
        text: a.textContent?.trim().substring(0, 80)
      })).filter(l =>
        l.href && (
          l.href.includes('solicitation') ||
          l.href.includes('bid') ||
          l.href.includes('matched') ||
          l.href.includes('opportunity') ||
          l.href.includes('search') ||
          l.text?.toLowerCase().includes('solicitation') ||
          l.text?.toLowerCase().includes('bid') ||
          l.text?.toLowerCase().includes('search') ||
          l.text?.toLowerCase().includes('match')
        )
      ).slice(0, 30);
    });
    console.log('  Dashboard links found:');
    navLinks.forEach(l => console.log(`    ${l.text} → ${l.href}`));

    // Go straight to the search/solicitations page (has actual bid listings)
    const uniqueUrls = [
      'https://www.bidnetdirect.com/private/supplier/solicitations/search',
    ];

    let bidsPageUrl = null;
    for (const url of uniqueUrls) {
      try {
        console.log(`  Trying: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        const pageInfo = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          const rows = document.querySelectorAll('tr');
          const links = document.querySelectorAll('a[href*="solicitation"]');
          const body = document.body.textContent?.substring(0, 200);
          return { tables: tables.length, rows: rows.length, solLinks: links.length, bodyPreview: body };
        });
        console.log(`    Tables: ${pageInfo.tables}, Rows: ${pageInfo.rows}, Sol links: ${pageInfo.solLinks}`);

        if (pageInfo.rows > 3 || pageInfo.solLinks > 2) {
          bidsPageUrl = url;
          console.log(`  ✅ Found bid listings at: ${url}`);
          break;
        }
      } catch (e) {
        console.log(`    ❌ ${e.message.substring(0, 80)}`);
      }
    }

    await debugScreenshot(page, 'bids-page');

    // Step 3: Extract bid data with pagination
    // Table structure: 3 cells per row — [icons, title, closing date + location]
    const MAX_PAGES = parseInt(process.env.BIDNET_MAX_PAGES || '10');
    let totalImported = 0;
    let totalSkipped = 0;
    let allProcessedBids = [];

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`📊 Extracting page ${pageNum}...`);

      const bids = await page.evaluate(() => {
        const results = [];
        const rows = document.querySelectorAll('table tbody tr');

        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) return;

          const link = row.querySelector('a[href*="notice"], a[href*="solicitation"]');
          if (!link) return;

          const title = link.textContent?.trim();
          const url = link.href;

          // Third cell contains closing date and location
          const infoCell = cells[cells.length - 1]?.textContent || '';

          // Parse closing date: "05/29/2026 01:00 PM CDT"
          const dateMatch = infoCell.match(/(\d{2}\/\d{2}\/\d{4})/);
          const closingDate = dateMatch ? dateMatch[1] : null;

          // Parse location: text after "Location" label(s)
          // HTML has "LocationLocation\n\t\t\t\t\t\tIllinois"
          const locMatch = infoCell.match(/Location[\s\n]*Location[\s\n]*([A-Za-z\s]+?)[\s]*$/m)
            || infoCell.match(/Location[\s\n]+([A-Z][a-z]+[\w\s,]*?)[\s]*$/m);
          const location = locMatch ? locMatch[1].trim() : null;

          // Extract BidNet ID from URL
          const idMatch = url.match(/\/(\d+)$/);
          const bidnetId = idMatch ? idMatch[1] : null;

          if (title && title.length > 5) {
            results.push({ title, url, bidnetId, closingDate, location, rawText: row.textContent?.trim().substring(0, 500) });
          }
        });

        return results;
      });

      console.log(`  Found ${bids.length} bids on page ${pageNum}`);
      if (bids.length === 0) break;

      // Process bids
      const processedBids = bids.map(bid => {
        let dueDate = null;
        if (bid.closingDate) {
          const parts = bid.closingDate.split('/');
          if (parts.length === 3) dueDate = `${parts[2]}-${parts[0]}-${parts[1]}`;
        }
        const noticeId = bid.bidnetId ? `BIDNET-${bid.bidnetId}` : `BIDNET-${bid.title.replace(/[^a-zA-Z0-9]/g, '').substring(0, 40)}`;
        return { notice_id: noticeId, title: bid.title, url: bid.url, agency: 'BidNet Direct', dueDate, location: bid.location, rawText: bid.rawText };
      }).filter(bid => bid.title && bid.title.length > 5);

      // Import to Supabase
      let pageImported = 0;
      let pageSkipped = 0;
      for (const bid of processedBids) {
        try {
          await supabaseRequest('POST', 'opportunities', {
            sam_notice_id: bid.notice_id,
            title: bid.title,
            source: 'bidnet',
            status: 'new',
            source_url: bid.url,
            agency: bid.agency,
            response_deadline: bid.dueDate || null,
            description: bid.location ? `Location: ${bid.location}` : null,
            raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
            posted_date: new Date().toISOString().split('T')[0]
          });
          pageImported++;
        } catch (e) {
          if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('409') || e.message.includes('23505')) {
            pageSkipped++;
          } else {
            console.error(`  Error importing "${bid.title}": ${e.message}`);
          }
        }
      }

      totalImported += pageImported;
      totalSkipped += pageSkipped;
      allProcessedBids = allProcessedBids.concat(processedBids);
      console.log(`  Page ${pageNum}: imported ${pageImported}, skipped ${pageSkipped}`);

      // Try to go to next page
      const hasNext = await page.evaluate(() => {
        // Look for "Next" link or ">" button in pagination
        const nextLinks = Array.from(document.querySelectorAll('a, button'));
        const nextBtn = nextLinks.find(el => {
          const text = el.textContent?.trim().toLowerCase();
          const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
          return text === 'next' || text === '>' || text === '›' || text === '>>' ||
            ariaLabel.includes('next') || el.className?.includes('next');
        });
        if (nextBtn && !nextBtn.disabled && !nextBtn.classList?.contains('disabled')) {
          nextBtn.click();
          return true;
        }
        return false;
      });

      if (!hasNext) {
        console.log('  No more pages.');
        break;
      }

      // Wait for page to load after clicking next
      await new Promise(r => setTimeout(r, 3000));
      await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n💾 Total: imported ${totalImported}, skipped ${totalSkipped} across ${allProcessedBids.length} bids`);

    // Output summary
    const summary = {
      source: 'bidnet',
      timestamp: new Date().toISOString(),
      bidsFound: allProcessedBids.length,
      imported: totalImported,
      skipped: totalSkipped,
      bids: allProcessedBids.map(b => ({ title: b.title, url: b.url, dueDate: b.dueDate, location: b.location }))
    };

    console.log('\n__BIDNET_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__BIDNET_JSON_END__');

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
  console.log(`\n✅ BidNet fetch complete. Found ${result.bidsFound} opportunities (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
