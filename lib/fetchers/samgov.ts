import { OpportunityInsert } from '@/types/opportunity';

const SAM_BASE_URL = 'https://api.sam.gov/opportunities/v2/search';

interface SamGovParams {
  naicsCodes: string[];
  postedFrom: string; // MM/dd/yyyy
  postedTo: string;
  apiKey: string;
}

interface SamOpportunity {
  noticeId: string;
  title: string;
  description?: string;
  fullParentPathName?: string;
  department?: string;
  subTier?: string;
  naicsCode?: string;
  naicsSolicitationDescription?: string;
  award?: { amount?: number | string; floor?: number | string; ceiling?: number | string };
  awardFloor?: number | string;
  awardCeiling?: number | string;
  estimatedTotalValue?: number | string;
  baseAndAllOptionsValue?: number | string;
  placeOfPerformance?: { city?: string; state?: string; country?: string } | Record<string, unknown>;
  pointOfContact?: Array<{ fullName?: string; email?: string }>;
  archiveDate?: string;
  responseDeadLine?: string;
  postedDate?: string;
  uiLink?: string;
  type?: string;
  [key: string]: unknown;
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/** Safely coerce a value to a finite number, or return null. */
function toNumber(val: unknown): number | null {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractDollarRange(opp: SamOpportunity): { min: number | null; max: number | null } {
  // 1. Check award.floor / award.ceiling (most specific range)
  const awardFloor = toNumber(opp.award?.floor);
  const awardCeiling = toNumber(opp.award?.ceiling);
  if (awardFloor != null || awardCeiling != null) {
    return { min: awardFloor, max: awardCeiling ?? awardFloor };
  }

  // 2. Check top-level awardFloor / awardCeiling
  const topFloor = toNumber(opp.awardFloor);
  const topCeiling = toNumber(opp.awardCeiling);
  if (topFloor != null || topCeiling != null) {
    return { min: topFloor, max: topCeiling ?? topFloor };
  }

  // 3. Check award.amount (single dollar figure)
  const amount = toNumber(opp.award?.amount);
  if (amount != null) {
    return { min: amount, max: amount };
  }

  // 4. Check estimatedTotalValue
  const estimated = toNumber(opp.estimatedTotalValue);
  if (estimated != null) {
    return { min: estimated, max: estimated };
  }

  // 5. Check baseAndAllOptionsValue
  const baseAll = toNumber(opp.baseAndAllOptionsValue);
  if (baseAll != null) {
    return { min: baseAll, max: baseAll };
  }

  // 6. Fallback: try to parse dollar amounts from description text
  const text = opp.description ?? '';
  const dollarMatch = text.match(/\$[\d,]+(?:\.\d{2})?/g);
  if (dollarMatch && dollarMatch.length >= 1) {
    const values = dollarMatch.map((m) => parseFloat(m.replace(/[$,]/g, ''))).filter((n) => !isNaN(n));
    if (values.length >= 2) {
      return { min: Math.min(...values), max: Math.max(...values) };
    }
    if (values.length === 1) {
      return { min: values[0], max: values[0] };
    }
  }

  return { min: null, max: null };
}

async function fetchForNaics(naicsCode: string, params: SamGovParams): Promise<SamOpportunity[]> {
  const url = new URL(SAM_BASE_URL);
  url.searchParams.set('api_key', params.apiKey);
  url.searchParams.set('naics', naicsCode);
  url.searchParams.set('postedFrom', params.postedFrom);
  url.searchParams.set('postedTo', params.postedTo);
  url.searchParams.set('limit', '100');
  url.searchParams.set('offset', '0');

  const results: SamOpportunity[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    url.searchParams.set('offset', String(offset));
    const res = await fetch(url.toString());

    if (!res.ok) {
      console.error(`SAM.gov API error for NAICS ${naicsCode}: ${res.status} ${res.statusText}`);
      break;
    }

    const data = await res.json();
    const opps: SamOpportunity[] = data.opportunitiesData ?? [];
    results.push(...opps);

    if (opps.length < 100) {
      hasMore = false;
    } else {
      offset += 100;
    }
  }

  return results;
}

function normalizeOpportunity(raw: SamOpportunity): OpportunityInsert {
  const dollars = extractDollarRange(raw);
  const poc = raw.pointOfContact?.[0];

  return {
    sam_notice_id: raw.noticeId,
    title: raw.title ?? 'Untitled',
    description: raw.description ?? null,
    agency: raw.department ?? raw.fullParentPathName ?? null,
    sub_agency: raw.subTier ?? null,
    naics_code: raw.naicsCode ?? null,
    naics_description: raw.naicsSolicitationDescription ?? null,
    dollar_min: dollars.min,
    dollar_max: dollars.max,
    posted_date: raw.postedDate ?? null,
    response_deadline: raw.responseDeadLine ?? null,
    point_of_contact: poc?.fullName ?? null,
    contact_email: poc?.email ?? null,
    source_url: raw.uiLink ?? null,
    place_of_performance: raw.placeOfPerformance
      ? typeof raw.placeOfPerformance === 'object'
        ? JSON.stringify(raw.placeOfPerformance)
        : String(raw.placeOfPerformance)
      : null,
    source: 'samgov',
    raw_data: raw as Record<string, unknown>,
  };
}

export async function fetchSamGovOpportunities(
  naicsCodes: string[],
  daysBack: number = 1
): Promise<OpportunityInsert[]> {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    throw new Error('SAM_GOV_API_KEY not configured');
  }

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);

  const params: SamGovParams = {
    naicsCodes,
    postedFrom: formatDate(from),
    postedTo: formatDate(now),
    apiKey,
  };

  const allRaw: SamOpportunity[] = [];
  const seenIds = new Set<string>();

  for (const naics of naicsCodes) {
    const opps = await fetchForNaics(naics, params);
    for (const opp of opps) {
      if (opp.noticeId && !seenIds.has(opp.noticeId)) {
        seenIds.add(opp.noticeId);
        allRaw.push(opp);
      }
    }
  }

  // Filter out non-biddable opportunity types before normalizing
  const EXCLUDED_TYPE_PATTERNS = [/award/i, /justification/i, /sole source/i, /presolicitation/i, /sources sought/i, /special notice/i];
  const biddable = allRaw.filter((opp) => {
    const t = opp.type ?? '';
    return !EXCLUDED_TYPE_PATTERNS.some((pattern) => pattern.test(t));
  });

  return biddable.map(normalizeOpportunity);
}
