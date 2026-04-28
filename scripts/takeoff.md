# Takeoff Engine — Claude Code Workflow

You are producing a structured **takeoff** for **TCB Metalworks** on a
specific bid opportunity. Your job: read the PDFs and the
`context.json` in `./takeoff-queue/<opp_id>/`, identify every TCB-
scope line item, assign quantities, link each item to its source
evidence, and write a JSON file the pricing engine can consume.

**Do not call any Anthropic API.** You *are* the takeoff engine. Read
the PDFs directly using the `Read` tool.

---

## About TCB Metalworks (recap)

Wisconsin metal fabricator. **In-scope:** structural steel framing,
misc metal fabrications (lintels, pipe supports, embeds, brackets,
shelf angles), stairs + railings + guardrails, ladders, bollards,
hollow metal frames. **Out-of-scope:** commodity Div 10 (lockers,
partitions, shelving), raw steel supply, metal roofing/siding, glazing,
HVAC ductwork.

The catalog of standard steel shapes is in `context.json` under
`steel_shapes`. The labor priors per assembly are under
`assembly_labor_priors`. The current rate card is under `rate_card`.

---

## Two stages, two playbooks

`context.json` carries `bid_stage` ∈ `pre_gmp_rfp` | `final_cd` | `unknown`.

### Pre-GMP / RFP stage
- Drawings are draft or absent. **Don't demand sheets that don't exist
  yet.** The GC's Q&A explicitly tells contractors to make assumptions.
- Source the line items from spec narrative (Division 05, 08, 10
  sections — see `tcb_sections` in context) and Q&A clarifications.
- Quantities are ranges or assumed-typical, not measured. Use
  `quantity_band: "range"` with min/max, or `"assumed_typical"`.
- Confidence per line should be 0.4–0.7. Use `flagged_for_review:
  true` for any line where the GC's instruction is "make a reasonable
  assumption".
- Document every assumption in the `assumptions` field.

### Final CD stage
- Source from drawings + spec. Measure or count.
- `quantity_band: "point"` for items pulled from schedules or
  dimensioned details. `"range"` only when the drawing is ambiguous.
- Confidence 0.7–0.95 typical.

---

## Workflow

1. Read `./takeoff-queue/<opp_id>/context.json`. It contains:
   - `opportunity` — title, GC, deadline.
   - `bid_stage`, `bid_stage_confidence`.
   - `tcb_sections` — Division 05/08/10 sections present in the spec,
     each with `first_page` for deep-linking.
   - `sheets_referenced` and `sheets_covered` — what's cited and
     what's actually uploaded.
   - `rate_card` — material, labor, finish rates plus markup factors.
   - `steel_shapes` — designation → (unit_weight, unit). Use these
     for the `steel_shape_designation` field on every line that has a
     standard shape.
   - `assembly_labor_priors` — per-assembly type, expected fab/det/
     foreman/ironworker hours. Use these for labor allocation rather
     than per-item time estimates.
   - `prior_jobs` — closest historical bids on similar work, if any
     are stored. Reference these in `notes` when you mirror their
     approach.
2. Walk every PDF in `./takeoff-queue/<opp_id>/`. Specifications
   first (Division 05/08/10 pages — see `tcb_sections.first_page`),
   then Q&A log (clarifications can drastically change scope), then
   drawings (if any).
3. For each TCB scope item identified:
   - Pick a `category` from the enum (see schema).
   - Quote the source evidence verbatim into `source_evidence` (≤200
     chars). Cite the exact section/page/Q-number.
   - Pick a `steel_shape_designation` from the catalog when applicable
     (e.g. `L4x4x3/8`, `1 1/2" pipe`, `PL 3/8 x 6`). If the item is
     custom, leave the designation null and set `unit_weight` directly
     from your dimensional estimate.
   - Pick the matching `assembly_type` from
     `assembly_labor_priors.keys` (`pan_stair`, `wall_handrail_run`,
     `guardrail_run`, `lintel_set`, `bollard_set`, `hss_framing`,
     `w_framing`, `mezzanine`, `misc`). Use `expected` hours scaled
     pro-rata if the quantity is materially smaller/larger than the
     prior's `total_weight_lbs`.
   - Set `confidence` honestly. Don't pad.
4. For items the spec or Q&A explicitly mentions but you can't
   quantify (e.g. "loose lintels — quantity TBD with construction
   docs"), still emit a line with `quantity_band: "assumed_typical"`,
   a defensible default count, and `flagged_for_review: true`.
5. Compute `total_weight_lbs` per line:
   - LF items: `quantity × unit_weight (lb/ft) × (1 + waste_factor)` —
     waste_factor is in `rate_card`.
   - EA items: `quantity × unit_weight (lb/ea) × (1 + waste_factor)`.
   - Custom items without a steel_shape: estimate from dimensions
     using the plate formula `length × width × thickness × 0.2836` for
     thickness in inches and length/width in inches.
6. **Do not** compute material/labor/finish/line costs. The commit
   script does that deterministically from the rate card. Leave those
   fields null in your output.
7. Compute `total_weight_lbs` and `confidence_avg` for the run.
8. Write the report to `./takeoff-queue/<opp_id>/takeoff.json` with
   the schema below.

---

## Required `takeoff.json` schema

```json
{
  "stage": "pre_gmp_rfp",
  "scope_summary": "2-3 sentences describing TCB scope on this bid.",
  "exclusions": ["clear list of items NOT in TCB's price"],
  "assumptions": ["package-level assumptions that apply to multiple lines"],
  "rfis_recommended": ["questions worth asking the GC before bidding"],
  "lines": [
    {
      "line_no": 1,
      "category": "lintel | pipe_support | hollow_metal_frame | bollard | embed | stair | handrail | guardrail | ladder | misc_metal | structural_beam | structural_column | base_plate | shelf_angle | overhead_door_framing | other",
      "description": "Plain-English description that maps to rate card",
      "in_tcb_scope": true,
      "assembly_type": "lintel_set | pipe_support_set | bollard_set | wall_handrail_run | guardrail_run | pan_stair | hss_framing | w_framing | mezzanine | misc",

      "source_kind": "spec | qa | drawing | assumption | industry_default",
      "source_filename": "02_-_Project_Manual_-...pdf",
      "source_section": "05 50 00",
      "source_page": 48,
      "source_evidence": "≤200 char verbatim quote",

      "quantity": 6,
      "quantity_unit": "EA | LF | SF | LBS | LS",
      "quantity_band": "point | range | assumed_typical",
      "quantity_min": 4,
      "quantity_max": 8,

      "steel_shape_designation": "L4x4x3/8 | 1 1/2\" pipe | PL 3/8 x 6 | null",
      "unit_weight": 8.5,
      "unit_weight_unit": "lb/ft | lb/ea",
      "total_weight_lbs": 224,
      "material_grade": "A36 | A992 | A500 | null",

      "fab_hrs": 4,
      "det_hrs": 2,
      "foreman_hrs": 4,
      "ironworker_hrs": 8,

      "finish": "galvanized | shop_primer | powder_coat | none",
      "finish_surface_sf": null,

      "confidence": 0.55,
      "flagged_for_review": false,
      "assumptions": "Quantity assumed at 6 typical for a single-story well house; lintel size assumed L4x4x3/8 per common Div 05 50 00 narrative. Verify with construction documents.",
      "notes": null
    }
  ],
  "total_weight_lbs": 0,
  "total_fab_hrs": 0,
  "total_ironworker_hrs": 0,
  "confidence_avg": 0.0,
  "flagged_lines_count": 0,
  "generator_version": "takeoff-md-v1"
}
```

---

## What good looks like

- **Every line cites a real source.** No phantom items.
- **Quantities show the math.** `assumptions` says how you got there.
- **Confidence is honest.** RFP-stage assumed-typical lines are 0.4-
  0.6 — say so, don't pad to 0.9.
- **Exclusions are explicit.** If the spec mentions overhead doors but
  the panels are by a specialty sub, exclude the doors and explicitly
  bid only the surrounding lintels/framing.
- **No costs.** The commit script applies the rate card.

If the package has no TCB scope at all (hydrology drawings only,
geotech only, etc.), emit a takeoff with `lines: []` and a
`scope_summary` that says "No TCB scope identified" — don't skip the
folder.
