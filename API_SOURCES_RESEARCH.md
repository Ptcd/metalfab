# Government Contract & Procurement API Sources Research
## For TCB Metalworks Bid Pipeline CRM
### Research Date: April 2, 2026

**Relevant NAICS Codes for Metal Fabrication:**
- 332 (Fabricated Metal Product Manufacturing - prefix)
- 332311 (Prefabricated Metal Building and Component Manufacturing)
- 332312 (Fabricated Structural Metal Manufacturing)
- 332321 (Metal Window and Door Manufacturing)
- 332323 (Ornamental and Architectural Metal Work Manufacturing)
- 332439 (Other Metal Container Manufacturing)
- 332510 (Hardware Manufacturing)
- 332999 (All Other Miscellaneous Fabricated Metal Product Manufacturing)
- 238120 (Structural Steel and Precast Concrete Contractors)
- 238290 (Other Building Equipment Contractors)

**Relevant PSC (Product Service Codes):**
- 3441 (Fabricated Structural Metal)
- 3442 (Metal Doors and Gates)
- 3446 (Architectural and Ornamental Metalwork)
- 5680 (Miscellaneous Fabricated Metal)

**Relevant FSC (Federal Supply Class):**
- 34 (Metalworking Machinery)
- 53 (Hardware and Abrasives)
- 56 (Construction and Building Materials)

---

## 1. USASpending.gov API (CONFIRMED FREE - NO API KEY)

### Overview
Comprehensive federal spending data. Shows awarded contracts (historical and recent). Useful for identifying agencies that buy metal fab work, tracking award patterns, and finding subcontracting opportunities from prime contractors.

### Details
- **URL:** https://api.usaspending.gov
- **Docs:** https://api.usaspending.gov/docs/endpoints
- **GitHub:** https://github.com/fedspendingtransparency/usaspending-api
- **Free?** YES - completely free, NO API key required
- **Rate Limits:** Not explicitly documented; no known hard throttle but be reasonable

### Key Endpoints

#### Search Awards (Best for finding metal fab contracts)
```
POST https://api.usaspending.gov/api/v2/search/spending_by_award/
```
**Request Body:**
```json
{
  "subawards": false,
  "limit": 25,
  "page": 1,
  "sort": "Award Amount",
  "order": "desc",
  "filters": {
    "keywords": ["steel fabrication", "handrails", "structural steel", "metal stairs"],
    "award_type_codes": ["A", "B", "C", "D"],
    "naics_codes": {
      "require": ["332312", "332323", "238120"]
    },
    "time_period": [
      {
        "start_date": "2025-01-01",
        "end_date": "2026-04-02"
      }
    ],
    "award_amounts": [
      {"lower_bound": 10000, "upper_bound": 5000000}
    ],
    "place_of_performance_scope": "domestic"
  },
  "fields": [
    "Award ID",
    "Recipient Name",
    "Start Date",
    "End Date",
    "Award Amount",
    "Total Outlays",
    "Description",
    "Awarding Agency",
    "Awarding Sub Agency",
    "Place of Performance City",
    "Place of Performance State Code",
    "NAICS Code",
    "Contract Award Type"
  ]
}
```

#### Spending by NAICS Category
```
POST https://api.usaspending.gov/api/v2/search/spending_by_category/naics/
```

#### Available Filters (all combine with AND logic):
- `keywords` - array of search terms (OR within array)
- `naics_codes` - `{ "require": ["332"], "exclude": [] }` - prefix matching
- `psc_codes` - Product Service Codes for metal fab
- `award_type_codes` - A/B/C/D for contracts, IDV_A etc for IDVs
- `time_period` - date ranges with date_type option
- `place_of_performance_scope` - "domestic" or specific states
- `place_of_performance_locations` - `[{"country":"USA","state":"TX"}]`
- `award_amounts` - `[{"lower_bound":10000,"upper_bound":5000000}]`
- `agencies` - filter by awarding/funding agency
- `recipient_type_names` - e.g. "Small Business"
- `set_aside_type_codes` - small business set-asides

### How to Query for Metal Fab Work
Use `naics_codes.require: ["332"]` to get all fabricated metal products, or be specific with individual codes. Combine with keywords like "handrail", "railing", "structural steel", "ornamental metal", "fencing", "gates", "canopy", "welding".

### Value for TCB
- Find which agencies buy metal fab work and how much they spend
- Identify prime contractors who win big metal fab contracts (subcontracting leads)
- Track spending patterns to predict upcoming opportunities
- NOT a source of active solicitations - these are awarded contracts

---

## 2. SAM.gov Contract Awards API (CONFIRMED FREE - API KEY REQUIRED)

### Overview
Replaced FPDS.gov (decommissioned Feb 24, 2026). This is now THE authoritative source for federal contract award data. Different from the SAM.gov Opportunities API you already use -- this shows AWARDED contracts, not open solicitations.

### Details
- **URL:** https://open.gsa.gov/api/contract-awards/
- **Production Base:** `https://api.sam.gov/contract-awards/v1/search`
- **Alpha/Test:** `https://api-alpha.sam.gov/contract-awards/v1/search`
- **Free?** YES - uses your existing SAM.gov API key
- **API Key:** Same key from SAM.gov profile (you already have this: SAM_GOV_API_KEY)
- **Rate Limits:**
  - Non-federal (no role): 10 requests/day
  - Non-federal (with role): 1,000 requests/day
  - Federal: 1,000 requests/day
  - System accounts: 1,000-10,000 requests/day

### Sample API Call
```
GET https://api.sam.gov/contract-awards/v1/search?api_key=YOUR_KEY&naicsCode=332312~332323~238120&lastModifiedDate=[01/01/2026,04/02/2026]&limit=100&offset=0
```

### Key Query Parameters
- `api_key` - required, your SAM.gov API key
- `q` - free text search
- `naicsCode` - single code or up to 100 tilde-separated (e.g., `332312~332323`)
- `lastModifiedDate` - range `[MM/DD/YYYY,MM/DD/YYYY]`
- `dollarsObligated` - single value or range `[lower,upper]`
- `contractingDepartmentCode` - filter by department
- `piid` - contract identifier
- `limit` - max 100, default 10
- `offset` - pagination

### How to Query for Metal Fab Work
```
naicsCode=332312~332323~238120~332311~332999
```
Or use `q=steel+fabrication+handrail+structural+steel`

### Value for TCB
- Research past awards to understand pricing and competition
- Find prime contractors for subcontracting relationships
- Track which agencies are awarding metal fab contracts
- Complementary to the Opportunities API -- awards show who won and for how much

---

## 3. Grants.gov Search2 API (CONFIRMED FREE - NO AUTH REQUIRED)

### Overview
Federal grant opportunities. While grants are not contracts, many fund construction and infrastructure projects that need metal fabrication (e.g., FEMA building grants, HUD community development, DOT infrastructure grants). Subcontractors and vendors can benefit from knowing where grant money is flowing.

### Details
- **URL:** https://grants.gov/api/common/search2
- **Base URL:** `https://api.grants.gov/v1/api/search2`
- **Docs:** https://grants.gov/api/api-guide
- **Free?** YES - completely free
- **Auth:** NONE required
- **Rate Limits:** Not documented (appears unlimited for reasonable use)

### Sample API Call
```bash
curl -X POST https://api.grants.gov/v1/api/search2 \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "steel fabrication construction metalwork",
    "oppStatuses": "posted|forecasted",
    "fundingCategories": "",
    "agencies": "",
    "rows": 25
  }'
```

### Request Parameters (POST JSON body)
- `keyword` - search term(s)
- `oppNum` - opportunity number
- `oppStatuses` - pipe-delimited: `forecasted|posted|closed|archived`
- `agencies` - agency code filter
- `eligibilities` - eligibility filter
- `aln` - Assistance Listing Number (formerly CFDA)
- `fundingCategories` - category codes (e.g., "HL" for health)
- `rows` - number of results

### Response Fields
- `id`, `number`, `title`, `agencyCode`, `agencyName`, `openDate`, `closeDate`, `oppStatus`, `docType`, `alnist`

### How to Query for Metal Fab Work
Search with keywords: "construction", "building", "infrastructure", "renovation", "structural", "fabrication", "metalwork". These grants fund projects that will need metal fab subcontractors.

### Value for TCB
- Early intelligence: know which projects are getting funded before RFPs come out
- Construction/renovation grants often need handrails, stairs, structural steel
- Track infrastructure spending in your target areas

---

## 4. Simpler Grants.gov API (CONFIRMED FREE - API KEY REQUIRED)

### Overview
Newer, modernized version of the Grants.gov API with better filtering. Provides the same federal grant data but with a more developer-friendly interface and richer filter options.

### Details
- **URL:** https://api.simpler.grants.gov
- **Endpoint:** `POST https://api.simpler.grants.gov/v1/opportunities/search`
- **Docs:** https://wiki.simpler.grants.gov/product/api/search-opportunities
- **Developer Portal:** https://simpler.grants.gov/developer
- **Free?** YES
- **Auth:** API key via header `X-API-Key: YOUR_KEY`
- **Rate Limits:** 429 returned when exceeded (specific limits not documented)

### Sample API Call
```bash
curl -X POST https://api.simpler.grants.gov/v1/opportunities/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_SIMPLER_GRANTS_KEY" \
  -d '{
    "query": "construction steel fabrication infrastructure renovation",
    "filters": {
      "opportunity_status": {"one_of": ["posted", "forecasted"]},
      "funding_category": {"one_of": ["natural_resources"]},
      "award_floor": {"min": 50000},
      "award_ceiling": {"max": 10000000}
    },
    "pagination": {
      "page_offset": 1,
      "page_size": 25,
      "sort_order": [{"order_by": "post_date", "sort_direction": "descending"}]
    }
  }'
```

### Key Filter Parameters
- `query` - free text (max 100 chars)
- `query_operator` - "AND" or "OR"
- `opportunity_status` - posted, forecasted, closed, archived
- `funding_instrument` - grant, cooperative_agreement, etc.
- `funding_category` - recovery_act, arts, natural_resources, etc.
- `applicant_type` - state_governments, nonprofits, etc.
- `post_date` / `close_date` - date ranges
- `award_floor` / `award_ceiling` - dollar ranges
- `top_level_agency` - agency filter
- `assistance_listing_number` - specific program numbers

### Response Fields
- `opportunity_id`, `opportunity_title`, `agency_name`, `close_date`, `award_floor`, `award_ceiling`, `post_date`, pagination info

### Value for TCB
Same as Grants.gov but with better filtering -- can narrow by dollar range, specific categories, and dates more precisely.

---

## 5. NYC Open Data - City Record Online (CONFIRMED FREE - NO AUTH)

### Overview
New York City publishes ALL solicitations and awards in the City Record. This dataset is available via Socrata SODA API -- completely free. NYC processes ~$1 billion in procurement annually across 100+ agencies.

### Details
- **URL:** https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx
- **API Endpoint:** `https://data.cityofnewyork.us/resource/dg92-zbpx.json`
- **Free?** YES - completely free
- **Auth:** None required (optional app token increases rate limit)
- **Rate Limits:** 50,000 requests/day unauthenticated; higher with free app token
- **App Token:** Register at https://data.cityofnewyork.us/ (free)

### Sample API Call
```bash
# Search for steel/metal related solicitations
curl "https://data.cityofnewyork.us/resource/dg92-zbpx.json?\$where=type_description='Solicitation'&\$q=steel+metal+fabrication&\$limit=25&\$order=date_entered+DESC"

# With SOQL filtering
curl "https://data.cityofnewyork.us/resource/dg92-zbpx.json?\$where=type_description='Solicitation' AND (notice LIKE '%steel%' OR notice LIKE '%metal%' OR notice LIKE '%handrail%' OR notice LIKE '%railing%')&\$limit=50"
```

### Query Syntax (SOQL - Socrata Query Language)
- `$where` - SQL-like filtering
- `$q` - full-text search
- `$limit` - results per page
- `$offset` - pagination
- `$order` - sort field and direction
- `$select` - choose specific columns

### Value for TCB
- NYC has massive infrastructure needs -- bridges, parks, public buildings
- DOT, Parks Dept, School Construction Authority all need metal fab
- Real-time solicitation data, not just awards
- Municipal-level opportunities that SAM.gov doesn't cover

---

## 6. SAM.gov Get Opportunities Public API (YOU MAY ALREADY USE THIS)

### Overview
This is the same SAM.gov Opportunities API you already use, but I'm documenting it here because the GSA open.gsa.gov page shows additional capabilities you may not be using.

### Details
- **URL:** https://open.gsa.gov/api/get-opportunities-public-api/
- **Base:** `https://api.sam.gov/opportunities/v2/search`
- **Free?** YES with API key
- **Auth:** `api_key` query parameter

### Note
You already have this. Skip if your samgov.ts fetcher is comprehensive.

---

## 7. PIEE Solicitation Module (FREE - WEB SCRAPING CANDIDATE)

### Overview
The Procurement Integrated Enterprise Environment is where the DoD is consolidating ALL solicitations. NECO (Navy) is migrating to PIEE by May 25, 2026. By Oct 1, 2026, ALL DoD unclassified solicitations must be posted here.

### Details
- **URL:** https://piee.eb.mil/sol/xhtml/unauth/index.xhtml
- **Public Search:** Available without login
- **API?** NO formal public API
- **Scraping Candidate:** YES - the public search page allows unauthenticated browsing
- **Free?** YES to browse

### Access Notes
- Public-facing search allows anyone to find solicitations without login
- To view secured attachments, you need a PIEE account (free to register)
- Self-registration available for vendors
- This is the FUTURE of DoD procurement posting

### Value for TCB
- Army, Navy, Air Force, Marines, DLA solicitations consolidating here
- Military bases need handrails, stairs, structural steel, fencing, gates constantly
- Worth building a scraper or at minimum monitoring manually

---

## 8. DIBBS - DLA Internet Bid Board System (FREE - WEB SCRAPING CANDIDATE)

### Overview
DLA posts ~10,000+ solicitations weekly. Approximately 85% of DLA solicitations appear ONLY on DIBBS. Covers military supply chains including fabricated metal products.

### Details
- **URL:** https://www.dibbs.bsm.dla.mil/
- **API?** NO formal public API
- **Free?** YES to search and browse
- **Auth:** Must accept DoD warning banner, then full search access

### Search Parameters (Web Form)
- Federal Supply Class (FSC) - use 34xx, 53xx, 56xx for metal fab
- National Stock Number (NSN)
- Solicitation Number (SPMxxx pattern)
- CAGE Code
- Keyword search

### How to Query for Metal Fab Work
Search by FSC codes:
- FSC 3441 - Fabricated Structural Metal
- FSC 3442 - Metal Doors and Gates
- FSC 3446 - Architectural and Ornamental Metalwork
- FSC 5680 - Miscellaneous Fabricated Metal Products

### Value for TCB
- Massive volume of military procurement
- Most DIBBS solicitations NOT posted on SAM.gov
- DLA buys metal parts, fencing, gates, structural components
- Consider building a scraper with Puppeteer/Playwright

---

## 9. Texas ESBD - Electronic State Business Daily (FREE - WEB SCRAPING CANDIDATE)

### Overview
All Texas state agency solicitations over $25,000 must be posted here. Texas is a huge market for construction and metal fab.

### Details
- **URL:** https://www.txsmartbuy.gov/esbd
- **API?** NO formal API
- **Free?** YES - no login required to search
- **Search:** Web-based keyword and NIGP code search

### Search Capabilities
- Keyword search (title contains-match)
- NIGP Class/Item codes (5-digit codes, contains search)
- Agency filter
- Status filter (open solicitations)

### URL Pattern for Filtering
```
https://www.txsmartbuy.gov/esbd/filter=T&agencyNumber=696&solStatus=1
```

### Value for TCB
- Texas state agencies, universities, local governments
- TxDOT, TPWD, TDCJ all need metal fab work
- No API but relatively scrapeable web interface

---

## 10. California Cal eProcure (THIRD-PARTY API AVAILABLE)

### Overview
California state procurement portal. All state bid opportunities posted here.

### Details
- **Official URL:** https://caleprocure.ca.gov/
- **Third-Party API:** https://apitude.co/en/docs/services/cal-eprocure-us/
  - Base URL: `https://apitude.co/api/v1.0/requests/cal-eprocure-us/`
  - Auth: API key required (`x-api-key` header)
  - FREE? Unknown - requires contacting Apitude for API key
  - Method: POST to submit query, GET to poll for results
- **Official API?** NO direct government API

### Third-Party API Sample
```bash
curl -X POST https://apitude.co/api/v1.0/requests/cal-eprocure-us/ \
  -H "x-api-key: YOUR_APITUDE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "steel fabrication"}'
```

### Value for TCB
- California is the largest state market
- CalTrans, DGS, UC system all procure metal fab work
- Third-party API may have costs; scraping official site is alternative

---

## 11. ITA Trade Leads API (LIKELY FREE - NEEDS VERIFICATION)

### Overview
International Trade Administration provides trade leads including foreign government procurement opportunities for U.S. exporters. Less relevant for domestic steel fab but could surface international opportunities.

### Details
- **URL:** https://developer.trade.gov/apis
- **Developer Portal:** https://developer.trade.gov/
- **Free?** Likely yes (government open data platform)
- **Auth:** API key registration at developer.trade.gov

### Value for TCB
- Lower priority -- mainly international procurement
- Could surface military base construction overseas
- U.S. embassy construction projects sometimes need metal fab

---

## SOURCES NOT RECOMMENDED (and why)

### GovTribe / GovWin
- **NOT FREE.** GovTribe starts at $1,350/year. GovWin is more expensive.
- API requires paid subscription
- They aggregate data from free sources listed above

### BidNet Direct
- **NO API available** (confirmed 2026)
- Paid subscription for vendors
- Aggregates municipal data but no programmatic access

### NECO (Navy Electronic Commerce Online)
- **Shutting down May 25, 2026** - migrating to PIEE
- No API; web-only
- Build for PIEE instead

### FedBizOpps (FBO)
- **Defunct.** Merged into SAM.gov in 2019
- All data available via SAM.gov Opportunities API (which you already use)

### Army Corps of Engineers PROJNET
- **NOT a procurement portal.** ProjNet is a design review tool
- USACE solicitations go to SAM.gov and PIEE
- No API for procurement

### GSA eBuy
- **Requires GSA Schedule contract** to access opportunities
- Not free/open access for vendors without a schedule
- No public API

### OpenOpps.com
- Paid subscription platform
- Aggregates from free sources
- API may be available but behind paywall

### State DOT Systems (BidExpress/BidX)
- **BidExpress** used by 44 state DOTs for electronic bidding
- Paid subscription for vendors ($30-50/month per state)
- No free API

---

## IMPLEMENTATION PRIORITY ORDER

### Tier 1 - Build Now (Free, API Available, High Value)
1. **USASpending.gov API** - No auth, rich contract award data
2. **SAM.gov Contract Awards API** - Uses existing API key, award intelligence
3. **Grants.gov Search2 API** - No auth, infrastructure grant intelligence
4. **Simpler Grants.gov API** - Better filters than Search2

### Tier 2 - Build Soon (Free, Scraping Required, High Value)
5. **PIEE Solicitation Module** - Future of all DoD solicitations
6. **DIBBS (DLA)** - 10K+ solicitations/week, most exclusive to DIBBS
7. **NYC Open Data (City Record)** - Free API, municipal opportunities

### Tier 3 - Build Later (Free, Scraping, Regional Value)
8. **Texas ESBD** - Large state market, scrapeable
9. **California Cal eProcure** - Largest state, third-party API available

### Already Have
- SAM.gov Opportunities API (existing samgov.ts fetcher)

---

## NAICS CODE REFERENCE FOR FETCHER CONFIGS

```typescript
// Metal fabrication NAICS codes for API queries
const METAL_FAB_NAICS = [
  '332311', // Prefabricated Metal Building and Component Mfg
  '332312', // Fabricated Structural Metal Manufacturing
  '332321', // Metal Window and Door Manufacturing
  '332323', // Ornamental and Architectural Metal Work Mfg
  '332439', // Other Metal Container Manufacturing
  '332510', // Hardware Manufacturing
  '332999', // All Other Misc Fabricated Metal Product Mfg
  '238120', // Structural Steel and Precast Concrete Contractors
  '238290', // Other Building Equipment Contractors
  '238990', // All Other Specialty Trade Contractors
];

// For USASpending prefix matching
const NAICS_PREFIXES = ['332', '2381'];

// Keywords for text search across all APIs
const METAL_FAB_KEYWORDS = [
  'steel fabrication',
  'structural steel',
  'handrail', 'handrails',
  'railing', 'railings',
  'metal stairs', 'staircase',
  'ornamental metal', 'ornamental iron',
  'metal fencing', 'steel fencing',
  'metal gates', 'steel gates',
  'canopy', 'canopies',
  'welding', 'welding services',
  'misc metals', 'miscellaneous metals',
  'metal fabrication',
  'iron work', 'ironwork',
  'steel erection',
  'guard rail', 'guardrail',
  'bollard', 'bollards',
  'metal deck', 'steel deck',
  'steel joist', 'bar joist',
];
```
