#!/usr/bin/env node
/**
 * fetch-bonfire.js - Scrapes open opportunities from Bonfire procurement portals
 * Bonfire is a React SPA used by multiple municipalities. No login needed to view listings.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEBUG = process.argv.includes('--debug');

const PROVIDERS = [
  { name: 'Waukesha County', slug: 'waukesha-county', url: 'https://waukeshacounty.bonfirehub.com/portal/?tab=openOpportunities' },
  { name: 'West Allis',      slug: 'west-allis',      url: 'https://westalliswi.bonfirehub.com/portal/?tab=openOpportunities' },
];

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
  const path = require('path').join(__dirname, `debug-bonfire-${name}.png`);
  console.log(`  📸 Debug screenshot: ${path}`);
  return page.screenshot({ path, fullPage: true });
}

async function scrapeProvider(browser, provider) {
  console.log(`\n🏛️  Scraping ${provider.name}: ${provider.url}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto(provider.url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Bonfire is a React SPA — give it extra time to render
    await new Promise(r => setTimeout(r, 5000));

    await debugScreenshot(page, `${provider.slug}-loaded`);

    // Log page title and URL for debugging
    const pageTitle = await page.title();
    console.log(`  Page title: ${pageTitle}`);
    console.log(`  Final URL: ${page.url()}`);

    // Strategy 1: Look for opportunity cards/rows in the rendered DOM
    // Bonfire portals typically render a list of opportunity cards with titles, dates, and links
    let opportunities = await page.evaluate((providerUrl) => {
      const results = [];
      const baseUrl = new URL(providerUrl).origin;

      // Bonfire renders opportunity listings as links/cards
      // Look for links that point to opportunity detail pages
      const allLinks = Array.from(document.querySelectorAll('a[href*="/opportunities/"], a[href*="/portal/"]'));

      // Also try broader selectors for card-like elements
      const cards = document.querySelectorAll('[class*="opportunity"], [class*="Opportunity"], [class*="card"], [class*="Card"], [class*="listing"], [class*="Listing"]');

      // Try to find opportunity links - Bonfire URLs typically have /opportunities/SLUG pattern
      const opportunityLinks = Array.from(document.querySelectorAll('a'))
        .filter(a => a.href && a.href.includes('/opportunities/'));

      for (const link of opportunityLinks) {
        const title = link.textContent?.trim();
        if (!title || title.length < 5) continue;

        // Look for closing date near the link (in parent/sibling elements)
        let closingDate = null;
        const parentCard = link.closest('[class*="card"], [class*="Card"], [class*="opportunity"], [class*="Opportunity"], tr, li, [class*="row"], [class*="Row"], [class*="item"], [class*="Item"]') || link.parentElement?.parentElement;

        if (parentCard) {
          const cardText = parentCard.textContent || '';
          // Look for date patterns: "Mar 15, 2026", "2026-03-15", "03/15/2026", "Closing: ..."
          const datePatterns = [
            /(?:clos(?:e|ing|es)|deadline|due|end)\s*(?:date)?[:\s]*(\w+\s+\d{1,2},?\s*\d{4})/i,
            /(\w+\s+\d{1,2},?\s*\d{4})/,
            /(\d{2}\/\d{2}\/\d{4})/,
            /(\d{4}-\d{2}-\d{2})/,
          ];
          for (const pattern of datePatterns) {
            const match = cardText.match(pattern);
            if (match) {
              closingDate = match[1];
              break;
            }
          }
        }

        const href = link.href.startsWith('http') ? link.href : baseUrl + link.getAttribute('href');

        // Avoid duplicates
        if (!results.find(r => r.url === href)) {
          results.push({
            title,
            url: href,
            closingDate,
            rawText: parentCard?.textContent?.trim().substring(0, 500) || title
          });
        }
      }

      return results;
    }, provider.url);

    // Strategy 2: If no opportunities found via links, try extracting from any table-like structure
    if (opportunities.length === 0) {
      console.log('  No opportunity links found, trying table/list extraction...');
      await debugScreenshot(page, `${provider.slug}-no-links`);

      // Dump page structure for debugging
      const pageInfo = await page.evaluate(() => {
        const body = document.body;
        return {
          text: body?.textContent?.substring(0, 2000),
          linkCount: document.querySelectorAll('a').length,
          tableCount: document.querySelectorAll('table').length,
          divCount: document.querySelectorAll('div').length,
          h1: document.querySelector('h1')?.textContent,
          h2s: Array.from(document.querySelectorAll('h2')).map(h => h.textContent?.trim()).slice(0, 5),
          classNames: Array.from(new Set(
            Array.from(document.querySelectorAll('[class]'))
              .map(el => el.className)
              .filter(c => typeof c === 'string' && (
                c.toLowerCase().includes('opportunit') ||
                c.toLowerCase().includes('card') ||
                c.toLowerCase().includes('list') ||
                c.toLowerCase().includes('bid') ||
                c.toLowerCase().includes('portal')
              ))
          )).slice(0, 20),
          allHrefs: Array.from(document.querySelectorAll('a'))
            .map(a => ({ href: a.href, text: a.textContent?.trim().substring(0, 80) }))
            .filter(a => a.href && !a.href.includes('javascript:'))
            .slice(0, 30)
        };
      });

      console.log(`  Page info: ${pageInfo.linkCount} links, ${pageInfo.tableCount} tables`);
      console.log(`  H1: ${pageInfo.h1}`);
      console.log(`  H2s: ${JSON.stringify(pageInfo.h2s)}`);
      if (pageInfo.classNames.length) console.log(`  Relevant classes: ${JSON.stringify(pageInfo.classNames)}`);
      console.log(`  Links:`);
      pageInfo.allHrefs.forEach(l => console.log(`    ${l.text} → ${l.href}`));
      console.log(`  Body preview: ${pageInfo.text?.substring(0, 500)}`);
    }

    // Strategy 3: Try intercepting API calls - Bonfire may load data via XHR
    if (opportunities.length === 0) {
      console.log('  Trying API intercept approach...');

      // Check for any JSON data embedded in the page or loaded via scripts
      const apiData = await page.evaluate(() => {
        // Check window.__NEXT_DATA__ or similar React data stores
        const nextData = window.__NEXT_DATA__;
        const initialState = window.__INITIAL_STATE__;
        const appState = window.__APP_STATE__;

        return {
          hasNextData: !!nextData,
          hasInitialState: !!initialState,
          hasAppState: !!appState,
          nextDataKeys: nextData ? Object.keys(nextData) : [],
          // Check for data in script tags
          scriptData: Array.from(document.querySelectorAll('script[type="application/json"], script[id*="data"]'))
            .map(s => s.textContent?.substring(0, 200))
            .slice(0, 5)
        };
      });
      console.log(`  API data check: ${JSON.stringify(apiData)}`);
    }

    console.log(`  Found ${opportunities.length} opportunities from ${provider.name}`);

    // Log each opportunity
    for (const opp of opportunities) {
      console.log(`    • ${opp.title} (closes: ${opp.closingDate || 'unknown'})`);
    }

    await page.close();
    return opportunities;

  } catch (err) {
    console.error(`  ❌ Error scraping ${provider.name}: ${err.message}`);
    await debugScreenshot(page, `${provider.slug}-error`);
    await page.close();
    return [];
  }
}

function parseDate(dateStr) {
  if (!dateStr) return null;

  // Try "Month Day, Year" format: "Mar 15, 2026" or "March 15, 2026"
  const monthDayYear = dateStr.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (monthDayYear) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                     jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
                     january: '01', february: '02', march: '03', april: '04', june: '06',
                     july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    const m = months[monthDayYear[1].toLowerCase()];
    if (m) {
      const d = monthDayYear[2].padStart(2, '0');
      return `${monthDayYear[3]}-${m}-${d}`;
    }
  }

  // Try MM/DD/YYYY
  const slashDate = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slashDate) return `${slashDate[3]}-${slashDate[1]}-${slashDate[2]}`;

  // Try YYYY-MM-DD (already correct format)
  const isoDate = dateStr.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];

  return null;
}

async function importToSupabase(opportunities, provider) {
  let imported = 0;
  let skipped = 0;

  for (const opp of opportunities) {
    // Build a slug from the URL or title for the notice ID
    const urlSlug = opp.url.match(/\/opportunities\/([^/?#]+)/)?.[1]
      || opp.title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 60).replace(/-+$/, '');
    const noticeId = `BONFIRE-${provider.slug}-${urlSlug}`;
    const dueDate = parseDate(opp.closingDate);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: opp.title,
        source: 'bonfire',
        status: 'new',
        source_url: opp.url,
        agency: provider.name,
        response_deadline: dueDate || null,
        place_of_performance: `${provider.name}, WI`,
        description: opp.closingDate ? `Closing: ${opp.closingDate}` : null,
        raw_data: JSON.stringify({ ...opp, provider: provider.name, scraped_at: new Date().toISOString() }),
        posted_date: new Date().toISOString().split('T')[0]
      });
      imported++;
    } catch (e) {
      if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('409') || e.message.includes('23505')) {
        skipped++;
      } else {
        console.error(`  Error importing "${opp.title}": ${e.message}`);
      }
    }
  }

  return { imported, skipped };
}

async function scrape() {
  console.log('🚀 Launching headless browser for Bonfire portals...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let totalImported = 0;
  let totalSkipped = 0;
  let allOpportunities = [];

  try {
    for (const provider of PROVIDERS) {
      const opportunities = await scrapeProvider(browser, provider);
      allOpportunities = allOpportunities.concat(
        opportunities.map(o => ({ ...o, provider: provider.name }))
      );

      if (opportunities.length > 0 && SUPABASE_URL && SUPABASE_KEY) {
        const result = await importToSupabase(opportunities, provider);
        totalImported += result.imported;
        totalSkipped += result.skipped;
        console.log(`  💾 ${provider.name}: imported ${result.imported}, skipped ${result.skipped}`);
      } else if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.log(`  ⚠️  Supabase not configured — skipping import for ${provider.name}`);
      }
    }

    await browser.close();

    // Summary
    const summary = {
      source: 'bonfire',
      timestamp: new Date().toISOString(),
      providers: PROVIDERS.map(p => p.name),
      opportunitiesFound: allOpportunities.length,
      imported: totalImported,
      skipped: totalSkipped,
      opportunities: allOpportunities.map(o => ({
        title: o.title,
        url: o.url,
        closingDate: o.closingDate,
        provider: o.provider
      }))
    };

    console.log('\n__BONFIRE_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__BONFIRE_JSON_END__');

    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ Bonfire fetch complete. Found ${result.opportunitiesFound} opportunities (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
