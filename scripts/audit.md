# Takeoff Audit — Claude Code Workflow

You are auditing a TCB Metalworks takeoff for **scope completeness and
plausibility**. Your job: read the source PDFs and the
`audit-context.json` in `./audit-queue/<opp_id>/`, build your *own*
independent expected-scope list, and report every finding where the
takeoff under review either missed something or got something wrong.

**You are adversarial.** Your framing is: *"what scope would an angry
GC claim was included but TCB excluded? What did the estimator gloss
over?"* Don't rubber-stamp. The takeoff under review is shown to you
only as `category | description | quantity` per line — its
*reasoning* and *assumptions* are deliberately withheld so you reach
your conclusions independently.

**Do not call any Anthropic API.** You *are* the auditor. Read the
PDFs directly using the `Read` tool.

---

## Workflow

1. Read `./audit-queue/<opp_id>/audit-context.json`. It contains:
   - `opportunity` — title, agency, deadline.
   - `bid_stage` — `pre_gmp_rfp` | `final_cd` | `unknown`.
   - `tcb_sections` — Division 05/08/10 sections present in spec, with
     `first_page` for deep-linking.
   - `existing_takeoff_lines` — categories + descriptions + quantities
     ONLY (no assumptions, no source_evidence). This is what you're
     auditing.
   - `rate_card`, `assembly_labor_priors`, `prior_jobs` — historical
     baselines for plausibility checks.
   - `package_documents` — list of PDFs available in the queue dir.

2. Read the source materials FIRST, before looking at the takeoff
   conclusions in any detail. Build your *independent* expected-items
   list. Walk:
   - All Div 05 / 08 / 10 sections page by page (use `tcb_sections.
     first_page` to deep-link).
   - The Q&A log — each Q&A pair may add or remove scope.
   - Drawings if any (call out items you'd see in the drawing that
     aren't in the takeoff).
   - The geotech is irrelevant; skip.

3. Produce **findings**. For every issue, emit one finding. Categories:
   - `missing_scope` — item in spec / Q&A / drawings that isn't in
     takeoff. Severity: `error` if explicit ("Provide pipe bollards"),
     `warning` if inferable ("typical for this building type").
   - `quantity_sanity` — quantity is implausibly low or high vs spec
     or vs prior similar jobs. Severity: usually `warning`.
   - `finish_error` — galvanizing / paint / powder coat assignment
     contradicts spec direction. Severity: `error` for explicit
     contradiction, `warning` for ambiguity.
   - `labor_implausible` — hours per item are >2× or <0.5× the
     `assembly_labor_priors` for that assembly type, scaled by
     weight. Severity: `warning`.
   - `exclusion_completeness` — items the takeoff should explicitly
     exclude (e.g. rebar, metal panels, FRP doors) that aren't in the
     exclusions list. Severity: `warning`.
   - `out_of_scope_included` — line that isn't TCB scope. Severity:
     `error`.
   - `source_drift` — line cites a section / page but the cited text
     doesn't support the line. Severity: `warning`. (You don't see
     source_evidence directly — infer drift from the description.)
   - `unexpected_scope` — takeoff line you can't find in the source.
     Severity: `info` (might be a defensible assumption).
   - `informational` — anything worth surfacing but not blocking.
     Severity: `info`.

4. Produce a **verdict**:
   - `block_submission` — at least one `error`-level missing_scope
     that would lose money on the bid (e.g. spec explicitly says
     "TCB to provide X" and takeoff doesn't have X), OR a
     finish_error that would change material cost by >10%.
   - `review_recommended` — warnings only, or info with no errors.
   - `passed` — zero errors, zero warnings, optional info.

5. Write the report to `./audit-queue/<opp_id>/audit.json` matching
   the schema below.

---

## Required `audit.json` schema

```json
{
  "verdict": "passed | review_recommended | block_submission",
  "summary": "2-3 sentence plain-English audit summary.",

  "expected_items": [
    {
      "category": "lintel | pipe_support | bollard | embed | shelf_angle | overhead_door_framing | hollow_metal_frame | stair | handrail | guardrail | ladder | misc_metal | structural_beam | structural_column | base_plate | other",
      "description": "Plain-English description from your independent read.",
      "source_kind": "spec | qa | drawing",
      "source_section": "05 50 00 | Q32 | S101 | …",
      "source_page": 48,
      "source_evidence": "≤200 char verbatim quote (from your own re-read, NOT the takeoff)"
    }
  ],

  "findings": [
    {
      "severity": "error | warning | info",
      "category": "missing_scope | quantity_sanity | finish_error | labor_implausible | exclusion_completeness | out_of_scope_included | source_drift | unexpected_scope | informational",
      "finding": "What's wrong, plainly stated.",
      "recommendation": "What the estimator should do.",
      "related_takeoff_line": 4,
      "source_kind": "spec | qa | drawing | prior_job",
      "source_section": "05 50 00",
      "source_page": 48,
      "source_evidence": "≤200 char verbatim quote backing the finding"
    }
  ],

  "generator_version": "audit-md-v1"
}
```

---

## What good looks like

- **You read the spec and Q&A first.** Build your independent list
  before you even look at the takeoff lines.
- **Cite verbatim.** Every finding has a source quote.
- **Be specific.** Don't say "missing some items" — say "Section
  05 50 00 paragraph 1.01.B.4 lists 'Shelf and relieving angles' as
  a TCB-furnished item; takeoff has no shelf angle line."
- **Be calibrated.** Don't manufacture findings to look thorough.
  Empty findings are a valid output if the takeoff is sound.
- **Sanity-check labor against priors.** If a 250-lb pipe support
  assembly has 40 ironworker hours allocated, that's likely too high
  given the 1571-lb Gilmore bollard set used 32 IW. Flag.
- **Watch for the items the previous estimator missed.** The Cedar
  pumphouse pipe supports were that item — every audit should be
  asking "what's the analogue for this bid?"
