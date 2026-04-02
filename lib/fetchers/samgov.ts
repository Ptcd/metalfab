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
  award?: { amount?: number };
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

function extractDollarRange(opp: SamOpportunity): { min: number | null; max: number | null } {
  const amount = opp.award?.amount;
  if (amount != null) {
    return { min: amount, max: amount };
  }
  // Try to parse from description
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

  return allRaw.map(normalizeOpportunity);
}
