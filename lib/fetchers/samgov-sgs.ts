import { OpportunityInsert } from '@/types/opportunity';

const SGS_BASE_URL = 'https://sam.gov/api/prod/sgs/v1/search/';

/** Keyword groups relevant to metal fabrication work */
const KEYWORD_GROUPS = [
  'metal fabrication',
  'structural steel',
  'handrail railing',
  'ornamental metal',
  'steel fabrication',
  'welding fabrication',
  'fencing gate',
  'misc metals',
  'canopy awning',
];

/** Opportunity types that are not biddable — filter these out */
const EXCLUDED_TYPES = new Set([
  'Award Notice',
  'Justification and Approval',
  'Justification',
  'Intent to Bundle Requirements',
  'Fair Opportunity / Limited Sources Justification',
  'Presolicitation',
  'Sources Sought',
  'Special Notice',
]);

/** Delay between API calls to be respectful of the server */
const DELAY_MS = 3000;

interface SGSResult {
  _id: string;
  title: string;
  type?: { code: string; value: string };
  isActive: boolean;
  isCanceled: boolean;
  descriptions?: Array<{ content: string; lastModifiedDate?: string }>;
  solicitationNumber?: string;
  cleanSolicitationNumber?: string;
  publishDate?: string;
  modifiedDate?: string;
  responseDate?: string;
  responseDateActual?: string;
  archiveDate?: string;
  naics?: Array<{ code: string; id: number; value: string }>;
  psc?: Array<{ code: string; id: number | null; value: string | null }>;
  organizationHierarchy?: Array<{
    name: string;
    type: string;
    level: number;
    code?: string;
    address?: {
      city?: string | null;
      state?: string | null;
      country?: string | null;
      zip?: string | null;
      streetAddress?: string | null;
    };
  }>;
  pointOfContacts?: Array<{
    fullName?: string;
    email?: string;
    type?: string;
  }>;
  award?: {
    date?: string | null;
    number?: string | null;
    amount?: number | string | null;
    awardee?: {
      name?: string | null;
      ueiSAM?: string | null;
    };
  };
  solicitation?: {
    setAside?: { code?: string; value?: string } | null;
    originalSetAside?: { code?: string; value?: string } | null;
  };
  placeOfPerformance?: Array<{
    city?: string | null;
    state?: string | null;
    country?: string | null;
    zip?: string | null;
  }>;
  parentNoticeId?: string;
  originalPublishDate?: string;
  [key: string]: unknown;
}

interface SGSResponse {
  _embedded?: { results: SGSResult[] };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
    maxAllowedRecords: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safely coerce a value to a finite number, or return null. */
function toNumber(val: unknown): number | null {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractDollarRange(opp: SGSResult): { min: number | null; max: number | null } {
  // Check award.amount
  const amount = toNumber(opp.award?.amount);
  if (amount != null) {
    return { min: amount, max: amount };
  }

  // Try to parse dollar amounts from description text
  const text = opp.descriptions?.[0]?.content ?? '';
  const dollarMatch = text.match(/\$[\d,]+(?:\.\d{2})?/g);
  if (dollarMatch && dollarMatch.length >= 1) {
    const values = dollarMatch
      .map((m) => parseFloat(m.replace(/[$,]/g, '')))
      .filter((n) => !isNaN(n) && n > 0 && n < 1e12);
    if (values.length >= 2) {
      return { min: Math.min(...values), max: Math.max(...values) };
    }
    if (values.length === 1) {
      return { min: values[0], max: values[0] };
    }
  }

  return { min: null, max: null };
}

function extractAgency(opp: SGSResult): { agency: string | null; subAgency: string | null } {
  const hierarchy = opp.organizationHierarchy;
  if (!hierarchy || hierarchy.length === 0) {
    return { agency: null, subAgency: null };
  }

  // Level 1 = Department, Level 2 = Agency, deeper = sub-agency/office
  const department = hierarchy.find((o) => o.level === 1);
  const agency = hierarchy.find((o) => o.level === 2);
  const subAgency = hierarchy.find((o) => o.level === 3) || hierarchy.find((o) => o.level === 4);

  return {
    agency: department?.name ?? agency?.name ?? null,
    subAgency: subAgency?.name ?? agency?.name ?? null,
  };
}

function extractPlaceOfPerformance(opp: SGSResult): string | null {
  const pop = opp.placeOfPerformance;
  if (!pop || pop.length === 0) return null;

  const loc = pop[0];
  if (!loc) return null;

  const parts = [loc.city, loc.state, loc.country].filter(Boolean);
  if (parts.length === 0) {
    // Try office address from organizationHierarchy as fallback
    const office = opp.organizationHierarchy?.find((o) => o.type === 'OFFICE');
    if (office?.address) {
      const addr = office.address;
      const addrParts = [addr.city, addr.state, addr.country].filter(Boolean);
      return addrParts.length > 0 ? addrParts.join(', ') : null;
    }
    return null;
  }

  return parts.join(', ');
}

function normalizeOpportunity(raw: SGSResult): OpportunityInsert {
  const dollars = extractDollarRange(raw);
  const { agency, subAgency } = extractAgency(raw);
  const primaryContact = raw.pointOfContacts?.find((c) => c.type === 'primary') ?? raw.pointOfContacts?.[0];
  const naics = raw.naics?.[0];
  const solNum = raw.solicitationNumber ?? raw.cleanSolicitationNumber ?? null;

  return {
    sam_notice_id: solNum ?? raw._id,
    title: raw.title ?? 'Untitled',
    description: raw.descriptions?.[0]?.content ?? null,
    agency,
    sub_agency: subAgency,
    naics_code: naics?.code ?? null,
    naics_description: naics?.value ?? null,
    dollar_min: dollars.min,
    dollar_max: dollars.max,
    posted_date: raw.publishDate ?? raw.originalPublishDate ?? null,
    response_deadline: raw.responseDateActual ?? raw.responseDate ?? null,
    point_of_contact: primaryContact?.fullName ?? null,
    contact_email: primaryContact?.email ?? null,
    source_url: solNum ? `https://sam.gov/opp/${raw._id}/view` : null,
    place_of_performance: extractPlaceOfPerformance(raw),
    source: 'samgov-sgs',
    raw_data: raw as unknown as Record<string, unknown>,
  };
}

async function fetchForKeyword(keyword: string): Promise<SGSResult[]> {
  const results: SGSResult[] = [];
  let page = 0;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(SGS_BASE_URL);
    url.searchParams.set('index', 'opp');
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(pageSize));
    url.searchParams.set('sort', '-modifiedDate');
    url.searchParams.set('q', keyword);

    try {
      const res = await fetch(url.toString());

      if (!res.ok) {
        console.error(`SAM.gov SGS API error for "${keyword}": ${res.status} ${res.statusText}`);
        break;
      }

      const data: SGSResponse = await res.json();
      const opps = data._embedded?.results ?? [];
      results.push(...opps);

      const totalPages = data.page?.totalPages ?? 0;
      page++;

      // Cap at 3 pages (300 results) per keyword to avoid excessive requests
      if (page >= totalPages || page >= 3 || opps.length < pageSize) {
        hasMore = false;
      } else {
        // Respect rate limits between pagination
        await sleep(1000);
      }
    } catch (err) {
      console.error(
        `SAM.gov SGS fetch error for "${keyword}":`,
        err instanceof Error ? err.message : String(err)
      );
      break;
    }
  }

  return results;
}

export async function fetchSamGovSGSOpportunities(): Promise<OpportunityInsert[]> {
  const allRaw: SGSResult[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < KEYWORD_GROUPS.length; i++) {
    const keyword = KEYWORD_GROUPS[i];
    console.log(`[samgov-sgs] Fetching keyword: "${keyword}" (${i + 1}/${KEYWORD_GROUPS.length})`);

    const opps = await fetchForKeyword(keyword);

    for (const opp of opps) {
      // Deduplicate by solicitationNumber first, then by _id
      const dedupeKey = opp.solicitationNumber ?? opp.cleanSolicitationNumber ?? opp._id;
      if (dedupeKey && !seenIds.has(dedupeKey)) {
        seenIds.add(dedupeKey);
        allRaw.push(opp);
      }
    }

    console.log(
      `[samgov-sgs] Got ${opps.length} results for "${keyword}", ${allRaw.length} unique total`
    );

    // Delay between keyword groups (skip delay after last one)
    if (i < KEYWORD_GROUPS.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Filter out non-biddable types and cancelled opportunities
  const biddable = allRaw.filter((opp) => {
    if (opp.isCanceled) return false;
    if (!opp.isActive) return false;
    const typeName = opp.type?.value ?? '';
    return !EXCLUDED_TYPES.has(typeName);
  });

  console.log(
    `[samgov-sgs] After filtering: ${biddable.length} biddable opportunities (from ${allRaw.length} total)`
  );

  return biddable.map(normalizeOpportunity);
}
