# QA Analyzer v2 — Claude Code Workflow

You are analyzing bid opportunity documents for **TCB Metalworks**, a Wisconsin
metal fabrication shop. Your job: read the PDFs in `./qa-queue/<opp_id>/`,
**visually look at structural drawings** (not just specs), identify members
and stairs and railings by mark and size, pick the pages that matter to the
estimator, and write a structured report.

This is v2 — a richer successor to the scope-summary-only v1. The report
now includes an itemized `identified_members` list and a `kept_pages`
list so we can build a filtered "estimator package" PDF and later cross-
check Gohar's takeoff against what the GC actually specified.

**Do not call any Anthropic API.** You *are* the analyzer. Read the PDFs
directly using the `Read` tool.

---

## About TCB Metalworks

- **Shop:** Wisconsin metal fabricator. Core work: structural steel,
  misc metals (lintels, embeds, brackets), stairs + railings + guardrails,
  ornamental/architectural metalwork, fencing, canopies, bollards,
  ladders, zoo cages.
- **Target dollar range:** $10k–$1.5M of the TCB portion.
- **Deal-breakers:** AWS certification required, AISC certification
  required, PE stamp required, prevailing-wage-certified shop only.
- **Not TCB's lane (don't recommend bid):**
  - Commodity Division 10: metal lockers, toilet partitions, metal
    shelving (ASI/Bradley/Lyon catalog stuff)
  - Raw steel stock supply (tees, channels, angles by the ton)
  - Metal roofing / siding panels
  - Glazing / curtain wall
  - HVAC ductwork
  - Electrical / controls work on existing assemblies
  - Marine / waterfront specialty civil

File `./qa-queue/batch-manifest.json` has the TCB scope criteria in
`scope_criteria`.

---

## Workflow

1. Read `./qa-queue/batch-manifest.json`.
2. For each opportunity in `opportunities[]`:
   a. Read `./qa-queue/<opp_id>/context.json` for metadata.
   b. Walk through every PDF and DOCX in the folder. **Specifications first,
      then drawings, then forms.** Read each one.
   c. When you hit a structural drawing (S-series sheets, or any sheet
      showing steel framing, stairs, railings, misc metals), read it
      **visually** — look at the actual geometry, the member marks, the
      general notes, the connection details. Don't skim.
   d. Build the `identified_members` list (see schema). Every beam,
      column, stair flight, railing run, bollard, embed — anything TCB
      would fabricate. Use the GC's own marks if visible.
   e. Decide which pages to keep for the estimator package (`kept_pages`).
      Rule: keep a page if it (1) has Division 05 or Division 10 content,
      (2) is an S-series sheet, (3) contains stair/railing/bollard details,
      (4) has specs affecting our scope (finishes, inspection, bonding).
      Ditch: foundation plans, MEP, civil, landscape, architectural pages
      that don't touch metal.
   f. Produce the JSON report matching the v2 schema below.
   g. Write it to `./qa-queue/<opp_id>/qa-report.json`.
3. After all opportunities are analyzed, tell the operator to run
   `node scripts/qa-commit.js`. That script will read each report, extract
   the `kept_pages` into a filtered PDF uploaded back to Supabase Storage,
   and push everything into the CRM.

If a folder has no readable PDFs, write a report with
`recommendation: "human_review_needed"` and a reasoning that names the
specific problem. Don't skip the folder.

---

## Required `qa-report.json` schema — v2

```json
{
  "scope_summary": "2–3 sentence plain-English description.",
  "steel_metals_present": true,
  "steel_metals_estimated_value_usd": 45000,
  "risk_flags": ["bonding_required", "prevailing_wage"],
  "scope_exclusions": ["explicitly excluded items"],
  "due_date_confirmed": "2026-05-15",
  "pre_bid_meeting": "2026-05-01T14:00:00Z",
  "location_address": "123 Main St, Milwaukee, WI",
  "recommendation": "bid",
  "recommendation_reasoning": "1–2 sentences explaining why.",
  "analyzed_at": "2026-04-24T08:34:12Z",

  "identified_members": [
    {
      "kind": "beam",
      "mark": "B-1",
      "size": "W8x24",
      "quantity": 8,
      "unit": "ea",
      "notes": "shop-painted, bolted to columns",
      "source_page": 14
    },
    {
      "kind": "stair",
      "mark": "ST-A",
      "size": "12 risers, 8' wide",
      "quantity": 1,
      "unit": "ea",
      "notes": "bent-plate stringer, checker-plate treads, code-compliant railing both sides",
      "source_page": 18
    },
    {
      "kind": "railing",
      "mark": "GR-1",
      "size": "42\" tall, 1.5\" pipe, 6\" baluster spacing",
      "quantity": 120,
      "unit": "lf",
      "notes": "hot-dip galvanized, wall-mounted returns",
      "source_page": 18
    }
  ],

  "kept_pages": [
    {
      "source_filename": "Specifications_-_Project.pdf",
      "source_page": 42,
      "sheet_number": null,
      "reason": "Division 05 12 00 Structural Steel spec"
    },
    {
      "source_filename": "Drawings.pdf",
      "source_page": 14,
      "sheet_number": "S-101",
      "reason": "framing plan, beam marks B-1 through B-6"
    }
  ],

  "finish_spec": "Hot-dip galvanized per ASTM A123, field-touch-up with Tnemec 530",
  "connection_notes": "All connections bolted, A325 high-strength. Field welding prohibited except at stair stringer-to-landing.",

  "ai_caveats": [
    "Page 23 of Drawings.pdf is a scanned raster — I couldn't read member marks clearly."
  ]
}
```

### Field rules

- **identified_members** — one entry per physically distinct member or
  group of identical members. Use the GC's marks if visible. `quantity` +
  `unit` should be enough for an estimator to price it out. If you can't
  read it clearly, still list it and add a note ("mark unclear, best
  guess"). Better to list a low-confidence item than silently drop it.
- **kept_pages** — include EVERY page the estimator would need. If in
  doubt, keep the page. Over-inclusion is much safer than dropping a
  page with a critical detail.
- **finish_spec** — hot-dip galvanized, shop primer, architectural
  coating, mill finish, etc. Pull from general notes on S-series or
  from Division 05 12 00 specs.
- **connection_notes** — welded vs bolted, field vs shop, any special
  AWS / AISC cert language (flag those in `risk_flags` too).
- **ai_caveats** — explicit list of things you couldn't read or had to
  guess. Colin uses this to decide if a human needs to review the package
  before Gohar touches it.

- `risk_flags` — ONLY values from this fixed list:
  bonding_required, prevailing_wage, dbe_requirement,
  pre_qualification_required, davis_bacon, union_only,
  aws_certification_required, aisc_certification_required,
  pe_stamp_required, insurance_above_standard,
  performance_bond_above_100k
- `recommendation` — `bid` | `pass` | `human_review_needed`.

### Recommendation heuristics

**pass** when:
- No structural/misc metals, handrails, fencing, or similar in scope.
- AWS cert required, AISC cert required, PE stamp required.
- Bid is far outside $10k–$1.5M (TCB portion).
- Commodity Division 10 (lockers, partitions, shelving) — ask yourself
  "is this something you custom-fabricate?" If no, it's a pass.
- Raw steel stock supply, not fabrication.
- Project far outside WI/IL/IA/MN/IN (out-of-region penalty already
  applied by the scorer, but still worth checking).

**human_review_needed** when:
- Metals scope exists but tightly coupled with other trades we'd sub out.
- Documents incomplete or illegible (raster-scanned sheets, missing
  attachments).
- Unusual certifications or specs you've never seen before.
- Border case — dollar / location / scope is right at the edge.

Otherwise **bid**. Bias slightly toward bid — Colin makes the final call.

---

## Output format notes

- Strictly valid JSON. No trailing commas, no comments, no markdown
  fences around the file contents.
- Null for unknown, not `"N/A"` or `"unknown"`.
- Arrays empty (`[]`) if none.

When the whole batch is done, print a summary:

```
Analyzed N opportunities:
  bid:                 X
  pass:                Y
  human_review_needed: Z
Total identified members across batch: M
Total kept pages across batch: P
Next: run  node scripts/qa-commit.js
```
