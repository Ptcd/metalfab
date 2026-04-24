# Takeoff QA — Claude Code Workflow

You are cross-checking Gohar's estimator takeoff against what the GC
actually specified in the bid documents. Your job is to catch missing
items, wrong sizes, missing finish callouts, and anything else that
would cause TCB to under-bid (or over-promise) this job.

This is the fourth Claude Code workflow in the system:

1. `qa-analyze.md` — reads incoming bid package, builds the QA report
2. *(this one)* `takeoff-qa.md` — cross-checks Gohar's takeoff against the
   QA report's `identified_members`
3. `qa-commit.js` — pushes results back to Supabase

The operator runs `node scripts/takeoff-qa-prepare.js --opp=<id>` which
populates `./takeoff-queue/<opp_id>/`:

```
./takeoff-queue/<opp_id>/
  context.json              # opp metadata, qa_report.identified_members
  estimator-package.pdf     # the filtered kept-pages PDF (for reference)
  takeoff.xlsx              # Gohar's spreadsheet (downloaded from Storage)
  takeoff.pdf               # if Gohar uploaded a PDF markup instead
```

Claude Code: read the takeoff, read the QA report's identified_members
list, produce a comparison. Write the result to
`./takeoff-queue/<opp_id>/takeoff-qa-report.json`. Then run
`node scripts/takeoff-qa-commit.js` to push the result back into the
opp's `raw_data.takeoff_qa` field and post a pipeline event.

---

## Workflow

1. Read `./takeoff-queue/<opp_id>/context.json`. It contains:
   - `opportunity` — id, title, agency
   - `identified_members` — array from the QA report (AI's reading of specs)
   - `takeoff_filename` — filename of Gohar's spreadsheet/PDF
   - `qa_report_summary` — scope summary, finish spec, connection notes

2. Read the takeoff file (XLSX or PDF):
   - For XLSX: use the bash `xlsx2csv` tool or a `python3 -c` one-liner
     with `openpyxl` to dump every sheet as CSV. Alternatively, read
     each row and extract (description, size, quantity, unit).
   - For PDF: read it directly with the Read tool.
   - Build a list of items Gohar priced: each with description, mark
     (if present), size, quantity, unit, and any finish/notes.

3. Compare Gohar's items against `identified_members`:
   - For each spec'd member, is there a matching takeoff line?
     - Match = similar kind (beam/stair/rail/etc) with similar size or
       mark. Be generous with matching — a "W8x24 beam" in specs
       matches "8x24 wide flange" in the takeoff.
   - For each takeoff line, is there a spec'd counterpart? (Catches
     Gohar pricing something the GC didn't ask for — rare but happens.)
   - Are the quantities close? (Flag any >15% miss.)
   - Does the finish callout match? (HDG vs painted vs mill finish is a
     huge pricing swing.)

4. Produce a report with these fields:

```json
{
  "analyzed_at": "2026-04-24T16:00:00Z",
  "takeoff_items_count": 14,
  "specified_items_count": 16,
  "matches": [
    {
      "spec": {"mark": "B-1", "kind": "beam", "size": "W8x24", "quantity": 8, "unit": "ea"},
      "takeoff": {"description": "W8x24 beam", "quantity": 8, "unit": "ea"},
      "status": "match",
      "notes": null
    }
  ],
  "spec_missing_from_takeoff": [
    {
      "item": {"mark": "GR-2", "kind": "railing", "size": "42\"", "quantity": 45, "unit": "lf"},
      "severity": "high",
      "notes": "45 lf of stair railing not found in takeoff — big miss."
    }
  ],
  "takeoff_extras_not_in_spec": [
    {
      "item": {"description": "stair nosing 4'-0\"", "quantity": 12, "unit": "ea"},
      "severity": "low",
      "notes": "Gohar included stair nosing — not clear in the kept pages, possibly a judgment add. Worth a sanity check."
    }
  ],
  "quantity_mismatches": [
    {
      "spec": {"mark": "B-1", "size": "W8x24", "quantity": 8},
      "takeoff_quantity": 6,
      "severity": "high",
      "notes": "Spec calls for 8, takeoff has 6. Missing 2 members."
    }
  ],
  "finish_issues": [
    {
      "severity": "high",
      "notes": "Spec calls for hot-dip galvanized per ASTM A123. Takeoff appears to price shop primer only — ~2x cost delta."
    }
  ],
  "summary": "2-3 sentence summary of the biggest risks the estimator should reconcile before the bid goes out.",
  "overall_confidence": "medium",
  "recommendation": "reconcile_before_submit"
}
```

### Field rules

- `severity`: `"low"` | `"medium"` | `"high"` — use high for anything
  that'd cause TCB to lose or lose money on the job.
- `overall_confidence`: `"low"` | `"medium"` | `"high"` — how sure are
  you about the comparison. Low if the takeoff format was ambiguous.
- `recommendation`: `"looks_good"` | `"reconcile_before_submit"` |
  `"estimator_review_required"`.

Default to `reconcile_before_submit` unless the takeoff is *obviously*
thorough. It's fine to be conservative here — the cost of making Gohar
double-check is tiny, the cost of a mis-bid is huge.

---

## Output notes

- Strict JSON. No trailing commas, no markdown fences.
- If a file is unreadable, still produce a report with
  `overall_confidence: "low"` and a summary explaining what you
  couldn't read. Don't skip.

When done, print:

```
Takeoff QA complete.
  Matches:             M
  Spec items missing:  S  (N high-severity)
  Takeoff extras:      E
  Quantity mismatches: Q
  Finish issues:       F
Next: run  node scripts/takeoff-qa-commit.js
```
