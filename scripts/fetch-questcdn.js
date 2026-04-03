#!/usr/bin/env node
/**
 * fetch-questcdn.js - Generic QuestCDN scraper
 * Pulls bids from QuestCDN JSON API for multiple municipalities
 * No login needed — public API endpoint
 *
 * Covers: Oak Creek, Cudahy, West Allis, City of Franklin, and any future QuestCDN providers
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// All QuestCDN providers we want to scrape
// Add new ones here: { name, provider, group }
const PROVIDERS = [
  { name: 'Oak Creek',   provider: '5688540', group: '5688540' },
  { name: 'Cudahy',      provider: '8017945', group: '8017945' },
  { name: 'West Allis',  provider: '455448',  group: '455448' },
  { name: 'Franklin',    provider: '7116773', group: '7116773' },
];

const API_BASE = 'https://qcpi.questcdn.com/cdn/browse_posting/';

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

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

async function fetchProvider(prov) {
  console.log(`\n📋 ${prov.name} (provider ${prov.provider})...`);

  const url = `${API_BASE}?posting_type=1&group=${prov.group}&provider=${prov.provider}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Requested-With': 'XMLHttpRequest',
    }
  });

  if (!res.ok) {
    console.error(`  HTTP ${res.status}`);
    return { imported: 0, skipped: 0, bids: [] };
  }

  const json = await res.json();
  const bids = json.data || [];
  console.log(`  Found ${bids.length} postings`);

  let imported = 0;
  let skipped = 0;
  const parsed = [];

  for (const bid of bids) {
    const projectId = bid.project_id || stripHtml(bid.render_project_id);
    const name = stripHtml(bid.render_name);
    const bidDate = bid.bid_date_str || '';
    const city = stripHtml(bid.render_city);
    const county = stripHtml(bid.render_county);
    const state = bid.state_code || 'WI';
    const owner = stripHtml(bid.render_owner);
    const solicitor = stripHtml(bid.render_solicitor);
    const postDate = bid.render_post_date || '';
    const categories = stripHtml(bid.render_category_search_string);
    const postingType = bid.posting_type || '';

    const noticeId = `QUEST-${projectId}`;
    const sourceUrl = `https://qcpi.questcdn.com/cdn/posting/?projType=all&provider=${prov.provider}&group=${prov.group}`;

    // Parse bid closing date
    let closeDate = null;
    if (bidDate) {
      try {
        const d = new Date(bidDate);
        if (!isNaN(d)) closeDate = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    let postedDate = null;
    if (postDate) {
      try {
        const d = new Date(postDate);
        if (!isNaN(d)) postedDate = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    const location = [city, county ? county + ' County' : '', state].filter(Boolean).join(', ');

    console.log(`  📌 ${name.slice(0, 70)}`);
    console.log(`     Quest #${projectId} | Closes: ${bidDate || 'N/A'} | ${location}`);

    const bidData = {
      projectId, name, bidDate, city, county, state, owner, solicitor,
      postDate, categories, postingType, providerName: prov.name,
    };
    parsed.push(bidData);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[${prov.name}] ${name}`,
        source: 'questcdn',
        status: 'new',
        source_url: sourceUrl,
        agency: owner || solicitor || prov.name,
        response_deadline: closeDate,
        posted_date: postedDate,
        place_of_performance: location,
        raw_data: JSON.stringify({ ...bidData, scraped_at: new Date().toISOString() }),
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

  return { imported, skipped, bids: parsed };
}

async function scrape() {
  console.log('🔧 Fetching QuestCDN bids for all providers...');

  let totalImported = 0;
  let totalSkipped = 0;
  let totalBids = 0;
  const allBids = [];

  for (const prov of PROVIDERS) {
    const result = await fetchProvider(prov);
    totalImported += result.imported;
    totalSkipped += result.skipped;
    totalBids += result.bids.length;
    allBids.push(...result.bids);
  }

  const summary = {
    source: 'questcdn',
    timestamp: new Date().toISOString(),
    providers: PROVIDERS.map(p => p.name),
    bidsFound: totalBids,
    imported: totalImported,
    skipped: totalSkipped,
  };

  console.log(`\n💾 Total across ${PROVIDERS.length} providers: imported ${totalImported}, skipped ${totalSkipped} from ${totalBids} bids`);

  console.log('\n__QUESTCDN_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__QUESTCDN_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ QuestCDN fetch complete. ${result.bidsFound} bids from ${result.providers.length} providers.`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
