import { OpportunityInsert } from '@/types/opportunity';

const API_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

/** NAICS codes relevant to metal fabrication & structural work */
const NAICS_CODES = ['332312', '332321', '332323', '332999', '238120', '238990'];

const NAICS_DESCRIPTIONS: Record<string, string> = {
  '332312': 'Fabricated Structural Metal Manufacturing',
  '332321': 'Metal Window and Door Manufacturing',
  '332323': 'Ornamental and Architectural Metal Work Manufacturing',
  '332999': 'All Other Miscellaneous Fabricated Metal Product Manufacturing',
  '238120': 'Structural Steel and Precast Concrete Contractors',
  '238990': 'All Other Specialty Trade Contractors',
};

const FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Awarding Agency',
  'Description',
  'Period of Performance Start Date',
  'Place of Performance State Code',
  'generated_internal_id',
];

interface USASpendingResult {
  'Award ID': string;
  'Recipient Name': string;
  'Award Amount': number;
  'Awarding Agency': string;
  'Description': string | null;
  'Period of Performance Start Date': string | null;
  'Place of Performance State Code': string | null;
  'generated_internal_id': string;
  internal_id: number;
  [key: string]: unknown;
}

interface USASpendingResponse {
  results: USASpendingResult[];
  page_metadata: {
    page: number;
    hasNext: boolean;
  };
  messages?: string[];
}

/** Return the start of the current federal fiscal year (Oct 1) and today as YYYY-MM-DD strings. */
function getFiscalYearRange(): { start_date: string; end_date: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // Federal FY starts Oct 1. If we're in Oct-Dec, FY started this calendar year.
  // If Jan-Sep, FY started last calendar year.
  const fyStartYear = month >= 9 ? year : year - 1;
  const fyStart = new Date(fyStartYear, 9, 1); // Oct 1

  // Go back 6 months from today for the time window
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // Use whichever is more recent: FY start or 6 months ago
  const startDate = fyStart > sixMonthsAgo ? fyStart : sixMonthsAgo;

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return { start_date: fmt(startDate), end_date: fmt(now) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchByNAICS(naicsCode: string): Promise<USASpendingResult[]> {
  const { start_date, end_date } = getFiscalYearRange();

  const body = {
    filters: {
      naics_codes: { require: [naicsCode] },
      time_period: [{ start_date, end_date }],
      award_type_codes: ['A', 'B', 'C', 'D'],
    },
    fields: FIELDS,
    limit: 25,
    sort: 'Award Amount',
    order: 'desc',
    page: 1,
  };

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(
      `USASpending API error for NAICS ${naicsCode}: ${response.status} ${response.statusText}`
    );
    return [];
  }

  const data: USASpendingResponse = await response.json();
  return data.results ?? [];
}

function normalizeResult(result: USASpendingResult, naicsCode: string): OpportunityInsert {
  const awardId = result['Award ID'];
  const recipientName = result['Recipient Name'];
  const description = result['Description'];
  const amount = result['Award Amount'];
  const agency = result['Awarding Agency'];
  const stateCode = result['Place of Performance State Code'];
  const perfDate = result['Period of Performance Start Date'];
  const internalId = result['generated_internal_id'];

  const title = description?.trim() || `Award to ${recipientName}`;

  return {
    source: 'usaspending',
    sam_notice_id: `usa-${awardId}`,
    title,
    description: `Awarded to ${recipientName} — $${amount?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    agency: agency || null,
    naics_code: naicsCode,
    naics_description: NAICS_DESCRIPTIONS[naicsCode] || null,
    dollar_min: amount ?? null,
    dollar_max: amount ?? null,
    posted_date: perfDate || null,
    place_of_performance: stateCode || null,
    source_url: internalId
      ? `https://www.usaspending.gov/award/${internalId}`
      : null,
    notes:
      'INTEL: This is an awarded contract, not an open solicitation. Use for targeting agencies and understanding market pricing.',
    raw_data: result as unknown as Record<string, unknown>,
  };
}

export async function fetchUSASpendingIntelligence(): Promise<OpportunityInsert[]> {
  console.log('[USASpending] Fetching awarded contract intelligence...');

  // Track results with their originating NAICS code
  const awardToNaics = new Map<string, string>();
  const awardToResult = new Map<string, USASpendingResult>();

  for (let i = 0; i < NAICS_CODES.length; i++) {
    const code = NAICS_CODES[i];
    console.log(`[USASpending] Querying NAICS ${code} (${NAICS_DESCRIPTIONS[code]})...`);

    try {
      const results = await fetchByNAICS(code);
      console.log(`[USASpending]   -> ${results.length} awards found`);

      for (const result of results) {
        const awardId = result['Award ID'];
        if (awardId && !awardToResult.has(awardId)) {
          awardToResult.set(awardId, result);
          awardToNaics.set(awardId, code);
        }
      }
    } catch (err) {
      console.error(`[USASpending] Error fetching NAICS ${code}:`, err);
    }

    // 2-second delay between API calls (skip after the last one)
    if (i < NAICS_CODES.length - 1) {
      await delay(2000);
    }
  }

  console.log(
    `[USASpending] ${awardToResult.size} unique awards across ${NAICS_CODES.length} NAICS codes`
  );

  const opportunities: OpportunityInsert[] = [];
  awardToResult.forEach((result, awardId) => {
    const naicsCode = awardToNaics.get(awardId) ?? NAICS_CODES[0];
    opportunities.push(normalizeResult(result, naicsCode));
  });

  return opportunities;
}
