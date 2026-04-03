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

## MIDWEST STATE & LOCAL PROCUREMENT SOURCES (Racine, WI Focus Area)

### Research Date: April 2, 2026

The following sources cover the 6-state region most relevant to a metal fabrication shop in Racine, WI: Wisconsin, Illinois, Indiana, Michigan, Iowa, and Minnesota. Plus county/city level portals and private construction lead services.

---

### 12. Wisconsin VendorNet / eSupplier Portal

**Status: NO API. Email alerts only. FREE.**

- **URL:** https://vendornet.wi.gov (legacy, still shows bids)
- **New Portal:** https://esupplier.wi.gov (replaced VendorNet for account management)
- **Bids Page:** https://vendornet.wi.gov/bids.aspx
- **NIGP Codes Page:** https://vendornet.wi.gov/NIGPCodes.aspx
- **Free?** YES - completely free to register and receive alerts
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - register NIGP commodity codes and receive automatic email notifications when matching solicitations are posted
- **Scrapeable?** YES - the bids page at vendornet.wi.gov/bids.aspx is a web-based list that could be scraped

**How it works:**
1. Register at esupplier.wi.gov (free)
2. Add NIGP codes matching metal fabrication (see codes below)
3. Receive email alerts when state agencies or UW System campuses post matching solicitations
4. All sealed bids and RFPs from Wisconsin state agencies post here

**Relevant NIGP Codes for Metal Fab:**
- 557 (Metal, Bars, Plates, Rods, Sheets, Strips, etc.)
- 560 (Castings & Forgings)
- 595 (Pipe, Tubing, and Fittings)
- 715 (Building Construction Services, New)
- 910 (Welding Equipment and Supplies)
- 912 (Building Components, Prefabricated)
- 914 (Construction Services, General)
- 928 (Metal Work, Fabrication and Repairs)

**Covers:** All Wisconsin state agencies, UW System campuses. Does NOT cover counties/cities (they use their own portals).

**Automation approach:** Build an email parser for VendorNet notification emails, OR scrape vendornet.wi.gov/bids.aspx periodically.

---

### 13. Illinois BidBuy

**Status: NO API. Email alerts only. FREE.**

- **URL:** https://www.bidbuy.illinois.gov/bso/
- **Public Bids:** https://www.bidbuy.illinois.gov/bso/external/publicBids.sdo
- **Vendor Manual:** https://pathway2procurement.illinois.gov/content/dam/soi/en/web/cpo-pathway-to-procurement/documents/bidbuy-documents/bidbuy-vendor-manual.pdf
- **Free?** YES - free to register
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - register commodity codes to receive bid notifications
- **Scrapeable?** MAYBE - the public bids page could be scraped but uses server-side rendering (JSF/Java)
- **Help Desk:** il.bidbuy@illinois.gov / 866-455-2897

**How it works:**
1. Register as a vendor on BidBuy
2. Select commodity codes for metal fabrication
3. Receive email notifications for matching solicitations
4. Both goods/services and Illinois Tollway solicitations post here

**Covers:** All Illinois state agencies, Illinois Tollway (goods/services over small purchase threshold). Does NOT cover local governments.

**Automation approach:** Email parser for BidBuy notifications. Scraping the public bids page is possible but the JSF framework makes it harder than static HTML.

---

### 14. Michigan SIGMA Vendor Self-Service (VSS)

**Status: NO API. Email alerts only. FREE.**

- **URL:** https://sigma.michigan.gov
- **VSS Portal:** https://sigma.michigan.gov/PRDVSS1X1/Advantage4
- **Info Page:** https://www.michigan.gov/budget/budget-offices/sigma/doing-business-with-the-state
- **Free?** YES - free to register
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - add commodity codes to receive email notifications for matching solicitations and grants
- **Scrapeable?** DIFFICULT - behind login/session management
- **Help Desk:** SIGMA-Vendor@michigan.gov / 517-284-0540

**How it works:**
1. Register for a SIGMA VSS account (free)
2. Add commodity codes for metal fabrication
3. Receive email notifications for matching solicitations
4. ALL Michigan state bid opportunities post here

**Covers:** All Michigan state agencies. Does NOT cover local governments.

**Automation approach:** Email parser for SIGMA notification emails. Web scraping is difficult due to session-based access.

---

### 15. Indiana IDOA Procurement

**Status: NO API. Email alerts only. FREE.**

- **URL:** https://www.in.gov/idoa/procurement/
- **Supplier Portal:** https://in.accessgov.com/idoa
- **Bidder Registration:** https://www.in.gov/idoa/procurement/supplier-resource-center/requirements-to-do-business-with-the-state/bidder-profile-registration/
- **Free?** YES
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - via bidder profile commodity code registration
- **Scrapeable?** POSSIBLE - the public procurement page lists current opportunities

**Covers:** Indiana state agencies.

**Automation approach:** Email parser for notification emails. Check whether the public solicitation listing can be scraped.

---

### 16. Iowa DAS / IMPACS (JAGGAER Platform)

**Status: NO PUBLIC API. Email alerts only. FREE.**

- **URL:** https://das.iowa.gov/vendors/bidding-opportunities
- **Bid Portal:** https://bidopportunities.iowa.gov/
- **IMPACS Vendor Portal:** https://solutions.sciquest.com/apps/Router/SupplierLogin?CustOrg=DASIowa
- **Free?** YES
- **API?** NO public API. JAGGAER has enterprise APIs but they are not exposed to vendors.
- **RSS Feed?** NO
- **Email Alerts?** YES - register IMPACS commodity codes to receive bid notifications via email
- **Scrapeable?** DIFFICULT - JAGGAER/SciQuest platform is session-heavy

**How it works:**
1. Create vendor account in IMPACS
2. Select commodity codes for metal fabrication
3. Receive email notifications for matching solicitations

**Covers:** Iowa state agencies (DAS and others).

**Automation approach:** Email parser only. JAGGAER platforms are difficult to scrape.

---

### 17. Minnesota Office of State Procurement / SWIFT

**Status: NO API. Email alerts only. FREE.**

- **URL:** https://mn.gov/admin/osp/vendors/solicitations-and-contract-opportunities/
- **Supplier Portal:** https://mn.gov/admin/osp/quicklinks/secure-portal/index.jsp
- **Contact:** OSPHelp.Line@state.mn.us / 651-296-2600
- **Free?** YES
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - register commodity categories in the Supplier Portal to receive email notifications
- **Scrapeable?** POSSIBLE - the solicitations page lists opportunities publicly

**How it works:**
1. Register through the state's Supplier Portal (free)
2. Select commodity categories during registration
3. Receive email notifications matching your categories
4. Vendor info enters SWIFT (Statewide Integrated Financial Tools) system

**Covers:** Minnesota state agencies.

**Automation approach:** Email parser for notification emails. Check if the public solicitations page can be scraped.

---

### 18. BidNet Direct (Municipal/County Aggregator)

**Status: NO OFFICIAL API. Third-party scraper available. PAID for full access.**

- **URL:** https://www.bidnetdirect.com/
- **Open Solicitations:** https://www.bidnetdirect.com/solicitations/open-bids
- **Wisconsin Bids:** https://www.bidnetdirect.com/wisconsin
- **Free?** PARTIALLY - can browse some bids free; full access requires paid subscription
- **API?** NO official API
- **RSS Feed?** NO
- **Email Alerts?** YES - with subscription
- **Third-Party Scraper:** Apify has a BidNetDirect Government Bids Scraper at https://apify.com/parseforge/governmentbids-scraper/api

**What it aggregates:** Municipal, county, school district, and special district bids from thousands of local government agencies. This is the single best source for LOCAL government bids in the Midwest.

**Apify Scraper Details:**
- Can scrape by keywords, status, categories, locations, publish date, agency type
- Structured JSON output
- Apify free tier available (limited); paid plans start ~$49/month
- Could automate monitoring of Wisconsin/Illinois/Midwest municipal bids

**Automation approach:** Use the Apify BidNet scraper to periodically pull bids matching metal fabrication keywords for WI, IL, IN, MI, IA, MN. This is the most viable path to automating local government bid monitoring.

---

### 19. Wisconsin DOT (WisDOT) Highway Construction

**Status: NO API. Uses BidExpress/BidX. PAID for bidding, FREE to view.**

- **HCCI Page:** https://wisconsindot.gov/Pages/doing-bus/contractors/hcci/default.aspx
- **BidX Portal:** https://ui.bidx.com/WIDOT/lettings
- **Legacy BidX:** https://www.bidx.com/wi/main
- **Free?** FREE to view bid results and letting schedules. PAID ($30-50/month) to submit bids electronically.
- **API?** NO
- **RSS Feed?** NO
- **Schedule:** Lettings occur on the 2nd Tuesday of each month. Projects advertised ~5 weeks before letting.

**Steel/Metal Fab Contracts:**
WisDOT does NOT post steel/metal fabrication contracts separately. They are included as line items within larger highway construction projects. Metal fab items in WisDOT lettings include: bridge rail, guard rail, structural steel, sign structures, light poles, median barriers.

**Note:** Starting April 14, 2026, WisDOT is moving to a new streamlined bidding system through BidX.com.

**Automation approach:** The BidX lettings page at ui.bidx.com/WIDOT/lettings could potentially be scraped for upcoming lettings and bid items. This would identify projects with steel/metal fab line items before letting.

---

### 20. Illinois Tollway Procurement

**Status: NO API. Uses BidBuy + separate plan room. FREE to register.**

- **Goods/Services:** https://agency.illinoistollway.com/doing-business/goods-and-services
- **Construction Bids:** https://agency.illinoistollway.com/doing-business/construction-engineering/bids-bulletins-awards
- **Plan Room (Construction):** https://www.illinoistollwaybidding.com/
- **Public Projects:** https://www.illinoistollwaybidding.com/projects/public
- **Active Contracts:** https://agency.illinoistollway.com/active-contracts
- **Free?** YES to register and view opportunities
- **API?** NO
- **RSS Feed?** NO
- **Email Alerts?** YES - register commodity codes on BidBuy for goods/services; register on illinoistollwaybidding.com for construction

**How it works:**
- Goods/services under small purchase threshold: RFQ basis on BidBuy
- Goods/services over threshold: IFB or RFP on BidBuy
- Construction projects: Advertised through the Online Plan Room (illinoistollwaybidding.com)
- Bid letting schedule updated every Friday

**Value for Metal Fab:** Illinois Tollway has a massive capital program (Move Illinois program). Bridge steel, sign structures, guardrail, barriers, and misc metals are regular line items.

**Automation approach:** Scrape the public projects page at illinoistollwaybidding.com/projects/public for new construction postings. Parse BidBuy notification emails for goods/services.

---

### 21. Cook County, IL - Open Data Portal (SOCRATA API)

**Status: FREE API AVAILABLE via Socrata/SODA. Bids posted on Bonfire.**

- **Open Data Portal:** https://datacatalog.cookcountyil.gov/
- **Programmatic Access Guide:** https://datacatalog.cookcountyil.gov/stories/s/Programmatic-Access/xydy-d85m
- **Bid Tabulations Dataset:** https://datacatalog.cookcountyil.gov/Finance-Administration/Procurement-Bid-Tabulations/32au-zaqn
- **Awarded Contracts Dataset:** https://datacatalog.cookcountyil.gov/Finance-Administration/Procurement-Awarded-Contracts-Amendments/qh8j-6k63
- **Intent to Execute Dataset:** https://datacatalog.cookcountyil.gov/Finance-Administration/Procurement-Intent-to-Execute/ag43-fvd7
- **Bonfire Portal (Active Bids):** https://cookcounty.bonfirehub.com (registration required for alerts)
- **Free?** YES - Open Data API is completely free
- **API?** YES - Socrata Open Data API (SODA)
- **Auth:** None required for public data; optional app token increases rate limit
- **Rate Limits:** Reasonable; app token recommended for automation

**API Query Examples:**
```
# Bid Tabulations - search for metal/steel
https://datacatalog.cookcountyil.gov/resource/32au-zaqn.json?$q=steel+metal+fabrication&$limit=50

# Awarded Contracts
https://datacatalog.cookcountyil.gov/resource/qh8j-6k63.json?$q=steel&$limit=50

# With SOQL filtering
https://datacatalog.cookcountyil.gov/resource/32au-zaqn.json?$where=description LIKE '%steel%' OR description LIKE '%metal%'&$order=date_received DESC
```

**Limitation:** The Open Data portal shows bid tabulations and awarded contracts (historical/recent awards), NOT upcoming solicitations. For active/upcoming bids, you need Cook County's Bonfire portal (no API).

**Automation approach:** Poll the Socrata API for new bid tabulations and awards. This gives intelligence on who's winning metal fab contracts in Cook County and at what prices. Combine with Bonfire email alerts for upcoming bids.

---

### 22. City of Chicago - Socrata Open Data + iSupplier

**Status: FREE API for contract data. No API for active bids.**

- **Data Portal:** https://data.cityofchicago.org/
- **Contracts Dataset:** https://data.cityofchicago.org/Administration-Finance/Contracts/rsxa-ify5
- **Developer Resources:** https://www.chicago.gov/city/en/narr/foia/sample_code0.html
- **iSupplier Portal (Active Bids):** https://eprocurement.cityofchicago.org/
- **Current Bids Page:** https://www.chicago.gov/city/en/depts/dps/isupplier/current-bids.html
- **Free?** YES - Open Data is free; iSupplier registration is free
- **API?** YES for contract/award data (Socrata SODA API). NO for active solicitations.
- **Auth:** None required for public datasets

**API Query Example:**
```
# Chicago contracts since 1993
https://data.cityofchicago.org/resource/rsxa-ify5.json?$q=steel+fabrication&$limit=50&$order=start_date DESC
```

**Limitation:** Same as Cook County - the Socrata API shows awarded contracts (great for competitive intelligence), but active solicitations are only on iSupplier with no API.

**Automation approach:** Poll Socrata for new metal fab contract awards. Register on iSupplier for email alerts on active bids.

---

### 23. Milwaukee County - Bonfire Portal

**Status: NO API. Email alerts via Bonfire registration. FREE.**

- **Bonfire Portal:** https://countymilwaukee.bonfirehub.com/portal/?tab=openOpportunities
- **Procurement Page:** https://county.milwaukee.gov/EN/Administrative-Services/Procurement
- **Also uses Bonfire:** Milwaukee County Transit (MCTS), Milwaukee Metropolitan Sewerage District (MMSD)
- **Free?** YES to register and receive alerts
- **API?** NO - Bonfire does not offer a public API
- **Email Alerts?** YES - register on Bonfire to receive notifications for matching opportunities
- **Scrapeable?** DIFFICULT - Bonfire is a SPA with dynamic loading

**Related Bonfire Portals in the Area:**
- City of Milwaukee: https://cityofmilwaukee.bonfirehub.com/portal
- MCTS: https://ridemcts.bonfirehub.com/portal
- MMSD: https://mmsd.bonfirehub.com/portal
- Waukesha County: https://waukeshacounty.bonfirehub.com/portal

**Automation approach:** Register on each Bonfire portal with metal fab categories. Parse notification emails. Bonfire cannot be easily scraped or accessed via API.

---

### 24. Racine County, WI - DemandStar/EUNA OpenBids

**Status: NO API. Email alerts via DemandStar. PARTIALLY FREE.**

- **County Procurement Page:** https://www.racinecounty.com/departments/finance/purchasing-rfps-and-bids
- **DemandStar Page:** https://www.demandstar.com/app/agencies/wisconsin/racine-county/procurement-opportunities/34fdc694-9d20-40d6-9ac9-84e50b0c192d/
- **City of Racine on DemandStar:** https://www.demandstar.com/app/agencies/wisconsin/city-of-racine-purchasing/procurement-opportunities/01dc3f5c-ed8d-466f-9fa8-3f31a8e08705/
- **City of Racine Purchasing:** https://cityofracine.org/purchasing/
- **Free?** PARTIALLY - browse some bids free on DemandStar; full access requires subscription
- **API?** NO
- **Email Alerts?** YES - with DemandStar registration
- **Contact:** Duane McKinney, Procurement Agent, 262-636-3700, duane.mckinney@racinecounty.gov

**WAPP Registration:** Register at DemandStar and select Wisconsin Association for Public Procurement (WAPP) as your Free Agency Registration to get basic free access.

**Automation approach:** Register on DemandStar with WAPP free registration. Parse notification emails. Racine County also posts RFPs directly on racinecounty.com which could be scraped.

---

### 25. Kenosha County, WI

**Status: NO API. Uses VendorNet + own website. FREE.**

- **Purchasing Division:** https://www.kenoshacountywi.gov/109/Purchasing
- **Free?** YES
- **API?** NO
- **Email Alerts?** YES - via VendorNet/eSupplier NIGP code registration
- **Scrapeable?** YES - the purchasing page lists current bids

**Automation approach:** Register on Wisconsin eSupplier with NIGP codes. Also periodically scrape the Kenosha County purchasing page.

---

## PRIVATE CONSTRUCTION LEAD SERVICES

### 26. Dodge Construction Network (includes Blue Book Network)

**Status: API AVAILABLE but PAID. Expensive.**

- **URL:** https://www.construction.com/
- **Products:** Dodge Construction Central, Blue Book Network
- **Apps/Integrations:** https://www.construction.com/products/apps-integrations
- **API Addendum:** https://www.construction.com/wp-content/uploads/2025/09/DCN_API-License_Addendum_20250812-FINAL.pdf
- **Salesforce Integration:** Dodge PipeLine for Salesforce available on AppExchange
- **Free?** NO
- **Pricing:** Starts ~$6,000/year per seat for regional access; $12,000+/year for national. Enterprise: $40,000-$75,000/year. API access requires additional licensing.
- **API?** YES - REST API available for subscribers. Allows downloading project leads into CRM/internal systems.
- **Auth:** Subscription-based credentials

**What you get:** Pre-construction project intelligence. Know about projects in planning/design before they go to bid. Identifies GCs, architects, owners. Tracks projects from planning through award.

**Blue Book Network Note:** The Blue Book API at webapi.bluebook.net is specifically for repair/estimation orders, NOT for project lead data. Blue Book's project leads are accessed through the Dodge Construction Central platform.

**Value for Metal Fab:** Highest-quality private construction lead data. Know about hospital expansions, school construction, highway projects, etc. in WI/IL/IN/MI before they bid. Expensive but high ROI if you close even one contract from a lead.

**Automation approach:** If subscribed, use the Dodge API to pull project leads into your CRM pipeline automatically. Salesforce integration available out of the box.

---

### 27. ConstructConnect (formerly iSqFt)

**Status: API for Enterprise only. PAID.**

- **URL:** https://www.constructconnect.com/
- **Pricing Page:** https://projects.constructconnect.com/pricing
- **Free?** NO
- **Pricing:** Starter: $129/month (month-to-month). Professional: $199/month (annual). Enterprise: custom pricing. API only available at Enterprise tier.
- **API?** YES but only for ConstructConnect Enterprise customers
- **RSS Feed?** NO
- **Email Alerts?** YES with subscription

**What you get:** Construction project leads, plan room access, bid management tools. iSqFt subcontractor networking features now integrated into ConstructConnect.

**Note:** iSqFt was acquired by ConstructConnect in 2014 and the brand has been retired. Subcontractor networking features are now in ConstructConnect Insight.

**Value for Metal Fab:** Good for receiving bid invitations from GCs. Less useful for finding public bids (use the free government portals instead). The $129/month Starter plan may be worth it for GC bid invitations alone.

**Automation approach:** At Enterprise tier, API integration into CRM. At lower tiers, email alert parsing only.

---

### 28. PlanHub

**Status: API AVAILABLE (paid). FREE tier for subcontractors.**

- **URL:** https://planhub.com/
- **API Page:** https://planhub.com/api/
- **Subcontractor Pricing:** https://planhub.com/pricing-subcontractors/
- **Free?** YES for basic subcontractor access (bid invitations, project plans, basic bidding tools)
- **Paid Plans:** Premier starts at $1,199/year for 25-mile radius. Full coverage: $1,999-$4,369+/year.
- **API?** YES - Projects API available. Provides project data, bidding GCs, market trends. Annual license, pricing varies by region/volume.
- **Integration:** No integration fees, 3-5 day typical setup

**What the API provides:**
- Project data (IDs, names, types, bidding dates, primary contacts)
- Contact information (IDs, names, emails, phone numbers)
- Nationwide or state-specific coverage options

**Value for Metal Fab:** Free tier covers ~30-40% of bids in a given market. PlanHub is strongest for GC-to-sub bid invitations on private commercial projects. The API could feed project leads into your CRM pipeline.

**Automation approach:** Register for free subcontractor account. If ROI justifies it, get API access to pull leads into CRM automatically. Parse email alerts from the free tier in the meantime.

---

### 29. The Blue Book Building & Construction Network

**Status: PAID subscription. NO useful API for project leads.**

- **URL:** https://www.thebluebook.com/
- **Now Part of:** Dodge Construction Network
- **Find Projects:** https://www.thebluebook.com/products/bluesearchtechnology/find-projects.html
- **Free?** NO - $150 to $800/month depending on features. Typically sold as 2-year contracts.
- **API?** The webapi.bluebook.net API is for repair estimates, NOT project leads
- **Email Alerts?** YES with subscription

**Note:** Blue Book is now owned by Dodge Construction Network. Their project lead data overlaps significantly with Dodge Construction Central. If you subscribe to Dodge, you likely don't need a separate Blue Book subscription.

---

## SUMMARY: MIDWEST PROCUREMENT AUTOMATION MATRIX

| Source | API? | RSS? | Email Alerts? | Scrapeable? | Free? | Coverage |
|--------|------|------|---------------|-------------|-------|----------|
| **WI VendorNet/eSupplier** | NO | NO | YES (NIGP codes) | YES | YES | WI state agencies |
| **IL BidBuy** | NO | NO | YES (commodity) | MAYBE (JSF) | YES | IL state agencies + Tollway |
| **MI SIGMA VSS** | NO | NO | YES (commodity) | DIFFICULT | YES | MI state agencies |
| **IN IDOA** | NO | NO | YES (commodity) | POSSIBLE | YES | IN state agencies |
| **IA IMPACS (JAGGAER)** | NO | NO | YES (commodity) | DIFFICULT | YES | IA state agencies |
| **MN OSP/SWIFT** | NO | NO | YES (commodity) | POSSIBLE | YES | MN state agencies |
| **BidNet Direct** | NO (Apify scraper) | NO | YES (paid) | YES (via Apify) | PARTIAL | Municipal/county nationwide |
| **WisDOT BidX** | NO | NO | NO | POSSIBLE | VIEW free | WI highway construction |
| **IL Tollway** | NO | NO | YES (BidBuy) | POSSIBLE | YES | IL Tollway projects |
| **Cook County Open Data** | **YES (SODA)** | NO | YES (Bonfire) | N/A (has API) | **YES** | Cook County awards/bids |
| **Chicago Open Data** | **YES (SODA)** | NO | YES (iSupplier) | N/A (has API) | **YES** | Chicago contract awards |
| **Milwaukee County** | NO | NO | YES (Bonfire) | DIFFICULT | YES | Milwaukee County |
| **Racine County** | NO | NO | YES (DemandStar) | YES (county site) | PARTIAL | Racine County |
| **Kenosha County** | NO | NO | YES (VendorNet) | YES | YES | Kenosha County |
| **Dodge/Blue Book** | **YES (paid)** | NO | YES (paid) | NO | NO ($6K+/yr) | National project leads |
| **ConstructConnect** | YES (Enterprise) | NO | YES (paid) | NO | NO ($129+/mo) | National project leads |
| **PlanHub** | **YES (paid)** | NO | YES (free tier) | NO | FREE basic | National GC-to-sub bids |

---

## REVISED IMPLEMENTATION PRIORITY ORDER (Midwest Focus)

### Tier 1 - Build Now (Free APIs, Highest Value)
1. **Cook County Open Data API (SODA)** - Free, real API, award intelligence for Cook County
2. **Chicago Open Data API (SODA)** - Free, real API, contract award data since 1993
3. **USASpending.gov API** - Already documented above
4. **SAM.gov Contract Awards API** - Already documented above
5. **Wisconsin VendorNet Scraper** - Free, scrapeable bids page, closest geography

### Tier 2 - Build Soon (Free, Email Parsing + Scraping)
6. **BidNet Direct via Apify Scraper** - Best single source for all Midwest municipal/county bids
7. **WI eSupplier Email Parser** - Parse VendorNet notification emails automatically
8. **IL BidBuy Email Parser** - Parse BidBuy notifications for IL state opportunities
9. **Racine/Kenosha County Scrapers** - Scrape local county procurement pages
10. **WisDOT BidX Scraper** - Monitor highway lettings for steel/metal line items

### Tier 3 - Register for Email Alerts (Manual/Semi-Automated)
11. **Milwaukee County Bonfire** - Register, parse alert emails
12. **City of Milwaukee Bonfire** - Register, parse alert emails
13. **MI SIGMA VSS** - Register, parse alert emails
14. **IN IDOA** - Register, parse alert emails
15. **IA IMPACS** - Register, parse alert emails
16. **MN OSP** - Register, parse alert emails
17. **IL Tollway Plan Room** - Register, monitor construction lettings

### Tier 4 - Paid Services (If Budget Allows)
18. **PlanHub Free Tier + API** - Start free, upgrade to API if ROI justifies
19. **ConstructConnect Starter** - $129/month for GC bid invitations
20. **Dodge Construction Network** - $6K+/year, best project intelligence, consider if revenue justifies

### Email Parsing Architecture
Since most Midwest state portals only offer email alerts (no APIs), the highest-leverage automation is:
1. Create a dedicated email inbox (e.g., bids@tcbmetalworks.com)
2. Register on ALL state portals with appropriate commodity/NIGP codes using this email
3. Build an email parser that extracts bid details from notification emails
4. Feed parsed bids into the CRM pipeline automatically
5. This single email parser approach covers WI, IL, MI, IN, IA, MN state portals with minimal code

---

## FEDERAL IMPLEMENTATION PRIORITY ORDER

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

**See "REVISED IMPLEMENTATION PRIORITY ORDER (Midwest Focus)" section above for the full Midwest state/local/private priority list.**

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
