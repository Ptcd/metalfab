# Skill: Review Pipeline Opportunities

## Purpose
Automated daily review of new SAM.gov opportunities in the TCB Metalworks bid pipeline. Opens each opportunity on SAM.gov, reads the solicitation details and SOW documents, and assesses whether the job is a real fit for a small metal fabrication shop in Racine, WI.

## TCB Metalworks Capabilities
- **Core work**: Handrails, railings, stairs, structural steel, ornamental metalwork, fencing, gates, canopies, awnings, bollards, platforms, ladders, guardrails, misc metals, welding/fabrication
- **Sweet spot**: $10K - $1.5M government contracts
- **Location**: Racine, WI — can travel up to ~4 hours for site visits (WI, IL, IN, MI, IA, MN)
- **NOT qualified for**: AISC HYD certification, PE stamp work, fall protection engineering, AWS certification requirements, Davis-Bacon certified payroll
- **NOT interested in**: Supply-only (no fab), DLA manufactured parts/NSN procurements, ranch fencing, concrete/paving/roofing/HVAC as primary scope

## Process

### Step 1: Get Top Unreviewed Opportunities
Query the Supabase API to get opportunities with status "new" sorted by score descending:
```
GET /api/opportunities?status=new&score_min=40&limit=20
```

### Step 2: For Each Opportunity
1. **Read the opportunity record** from the API to get source_url and details
2. **Open the SAM.gov page** using the source_url in Chrome
3. **Read the page text** to get the full solicitation description
4. **Check for attachments** — look for SOW, Statement of Work, specifications documents
5. **If .docx attachment available**, download and read with mammoth
6. **Assess fit** based on:
   - Is this ACTUALLY metal fabrication work? (not concrete, paving, electrical, etc.)
   - Is the scope something TCB can do? (handrails, gates, stairs, structural steel, etc.)
   - Is the location feasible? (within 4 hours of Racine, or can bid off prints)
   - Is the dollar amount realistic? ($10K-$1.5M)
   - Are there disqualifying requirements? (AISC HYD, PE stamp, specialized certs)
   - Is the deadline still open?

### Step 3: Update Each Opportunity
Based on assessment, update via API:
```
PATCH /api/opportunities/[id]
```

**If it's a good fit:**
- Set status to "reviewing"
- Add notes explaining why it's worth pursuing
- Include key details: scope summary, deadline, site visit requirements, location

**If it's NOT a fit:**
- Set status to "passed"
- Add notes explaining why (wrong scope, too far, cert required, etc.)

**If uncertain:**
- Keep status as "new"
- Add notes with questions that need human review

### Step 4: Summary Report
After reviewing all opportunities, output a summary:
- How many reviewed
- How many moved to "reviewing" (worth pursuing)
- How many passed
- Top 3 best opportunities with brief descriptions
- Any upcoming deadlines within 7 days

## Red Flags (Auto-Pass)
- Title starts with 2-digit number followed by `--` (DLA FSC code)
- Contains "Proposed procurement for NSN"
- Primary scope is non-fabrication (concrete, asphalt, roofing, HVAC, painting, landscaping)
- Requires AISC HYD, AWS certification, or PE stamp
- Location is overseas or far from Midwest with mandatory site visit
- Expired deadline
- Award notice or modification to existing contract

## Green Flags (Priority Review)
- Title directly mentions: handrail, railing, stairs, gate, fence, bollard, platform, canopy, steel fabrication, welding
- Location in WI, IL, IN, MI
- Dollar range $25K-$500K (sweet spot within sweet spot)
- Has attached drawings/specifications
- Set-aside for small business

## Authentication Note
SAM.gov may require login to view attachments. The user's SAM.gov credentials:
- Email: tcbmetalworks@gmail.com
- May need SMS verification — if login is required and can't proceed, note it and move on

## API Endpoints
- List: `GET /api/opportunities?status=new&score_min=40`
- Detail: `GET /api/opportunities/[id]`
- Update: `PATCH /api/opportunities/[id]` with JSON body `{ status, notes }`
- Stats: `GET /api/opportunities/stats`
