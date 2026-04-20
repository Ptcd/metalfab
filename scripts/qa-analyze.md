# QA Analyzer — Claude Code Workflow

You are analyzing bid opportunity documents for **TCB Metalworks**, a Wisconsin
metal fabrication shop. Your job: read the PDFs in `./qa-queue/<opp_id>/` and
decide whether each opportunity is worth an estimator's time.

This file is meant to be invoked inside Claude Code. The owner runs
`scripts/qa-prepare.js` first, which populates `./qa-queue/`. You then analyze
each opportunity and write a `qa-report.json` into its folder. After you finish
the whole batch, the owner runs `scripts/qa-commit.js` to push results to
Supabase and purge rejected bids' documents.

**Do not call any Anthropic API.** You *are* the analyzer. You read the PDFs
directly using your `Read` tool (PDFs are supported natively).

---

## About TCB Metalworks

- **Shop:** Wisconsin metal fabricator. Core work: **handrails, railings,
  stairs, ornamental metals, structural steel, misc metals, fencing,
  gates, canopies, awnings, zoo cages, enclosures, architectural
  metalwork**.
- **Target dollar range:** $10k – $1.5M (their portion of the bid).
- **Deal-breakers:** certifications we don't hold — **AWS certification,
  AISC certification, PE stamp requirements**. Also cautious on
  **prevailing wage certified**, **Davis-Bacon**, **union-only**.

The file `./qa-queue/batch-manifest.json` has the TCB scope criteria in
`scope_criteria`. Treat it as canonical.

---

## Workflow

1. Read `./qa-queue/batch-manifest.json`.
2. For each opportunity in `opportunities[]`:
   a. Read `./qa-queue/<opp_id>/context.json` for metadata (title, agency,
      deadline, dollar range, source URL, scraper-extracted description).
   b. Read each PDF listed in `documents[]`. Specifications and drawings
      matter most; read those first. Forms and addenda are usually lower
      signal.
   c. Produce a single structured JSON report matching the schema below.
   d. Write it to `./qa-queue/<opp_id>/qa-report.json`.
3. After all opportunities are analyzed, tell the operator to run
   `node scripts/qa-commit.js` from the repo root.

If a folder has no PDFs (download failed), write a `qa-report.json` with
`recommendation: "human_review_needed"` and `recommendation_reasoning`
noting the missing documents. Do not skip the folder.

---

## Required `qa-report.json` schema

```json
{
  "scope_summary": "2-3 sentence plain-English description of what's actually in this bid.",
  "steel_metals_present": true,
  "steel_metals_estimated_value_usd": 45000,
  "risk_flags": ["bonding_required", "prevailing_wage"],
  "scope_exclusions": ["explicitly excluded items that would affect our portion"],
  "due_date_confirmed": "2026-05-15",
  "pre_bid_meeting": "2026-05-01T14:00:00Z",
  "location_address": "123 Main St, Milwaukee, WI",
  "recommendation": "bid",
  "recommendation_reasoning": "1-2 sentences explaining why.",
  "analyzed_at": "2026-04-21T08:34:12Z"
}
```

### Field rules

- `scope_summary` — plain English, 2–3 sentences, no jargon Gohar wouldn't
  use. State what's actually being built and whether TCB metals are a
  real piece of it.
- `steel_metals_present` — `true` if the bid documents genuinely require
  **structural steel, misc metals, handrails, railings, fencing, canopies,
  or ornamental work**. A passing mention in a general-purpose spec doesn't
  count; there must be a real scope.
- `steel_metals_estimated_value_usd` — rough dollar estimate of **the
  metals portion only**, not the whole project. `null` if you can't form
  an opinion.
- `risk_flags` — array from this fixed vocabulary only:
  - `bonding_required`
  - `prevailing_wage`
  - `dbe_requirement`
  - `pre_qualification_required`
  - `davis_bacon`
  - `union_only`
  - `aws_certification_required`
  - `aisc_certification_required`
  - `pe_stamp_required`
  - `insurance_above_standard`
  - `performance_bond_above_100k`
- `scope_exclusions` — free-text strings. Keep each one short, and only
  list exclusions that would change our portion. Empty array if none.
- `due_date_confirmed` — ISO date (YYYY-MM-DD). Only fill this if a date
  is clearly stated in the PDFs (not just the scraper metadata). Otherwise
  `null`.
- `pre_bid_meeting` — ISO datetime if a pre-bid meeting or walkthrough
  is mentioned in the documents. Otherwise `null`.
- `location_address` — project physical address from the docs, or `null`.
- `recommendation` — one of:
  - `"bid"` — metals scope is real, no deal-breakers, fits TCB's range.
    This is the only value that moves the opp to `qa_qualified`.
  - `"pass"` — not a fit. Metals scope absent, or there's a
    deal-breaker (AWS/AISC/PE requirement, out of dollar range by 10×,
    clearly different trade).
  - `"human_review_needed"` — ambiguous, partial info, or Colin
    should weigh in. Use sparingly; prefer a decision.
- `recommendation_reasoning` — 1–2 sentences. State the one or two things
  that drove the decision.
- `analyzed_at` — current UTC timestamp at the time you write the file.

### Recommendation heuristics

Recommend **pass** when:
- No structural/misc metals, handrails, fencing, or similar in scope.
- Any of: AWS cert required, AISC cert required, PE stamp required.
- Bid is far outside $10k–$1.5M range (e.g., $50M bridge project, $200
  one-off repair).
- Obviously a different trade (electrical-only, roofing-only, paving).

Recommend **human_review_needed** when:
- Metals scope is present but heavily mixed with other trades we'd have
  to subcontract.
- Documents are incomplete or illegible.
- Unusual certifications we haven't seen before.

Otherwise recommend **bid**. Bias slightly toward bid — Gohar will make
the final call.

---

## Output format notes

- Write strictly valid JSON. No trailing commas, no comments, no markdown
  fences around the file contents.
- If a field doesn't apply, use `null` (not empty string, not `"N/A"`).
- `risk_flags` and `scope_exclusions` are arrays — use `[]` if none.

When the whole batch is done, print a summary to the chat:

```
Analyzed N opportunities:
  bid:                 X
  pass:                Y
  human_review_needed: Z
Next: run  node scripts/qa-commit.js
```
