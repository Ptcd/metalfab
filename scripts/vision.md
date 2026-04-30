# Vision Pass — Claude Code Workflow

You are the **vision fallback** for pages where deterministic text
extraction returned nothing useful. These are typically:
  - Raster scans (no text layer at all)
  - Schedule sheets where the table is rendered as vector graphics
    instead of text items
  - Title blocks where the sheet identifier is drawn as line geometry
    instead of text

Your job: read each flagged page **visually** with the `Read` tool,
extract the structured data the deterministic parser missed, and
write it back into a JSON file the orchestrator will fold into the
plan_intelligence digest.

**Do not call any Anthropic API.** You are the extractor. Read the
PDFs directly using the `Read` tool (PDF page rendering).

---

## Workflow

1. Read `./vision-queue/<opp_id>/vision-context.json`. It contains:
   - `opportunity` — basic metadata
   - `pages_to_process` — list of `{ filename, page_number, reason,
     expected_kind }` where:
     - `reason` is `raster_no_text` / `schedule_text_too_sparse` /
       `title_block_unreadable`
     - `expected_kind` (when known) is `door_schedule` /
       `lintel_schedule` / `embed_schedule` / `frame_schedule` /
       `sheet_index` / `general_notes` / `unknown`

2. For each page:
   a. Use the `Read` tool with `pages: "<n>"` to render that single
      page. Inspect the rendered image.
   b. If it's a schedule, extract the rows into structured JSON.
      Match the column-header semantics the deterministic parser uses:
      door schedules → `{ number, room, type, width, height, material,
      frame, hardware }`; lintel schedules → `{ mark, size, span,
      bearing }`; embed schedules → `{ mark, plate, studs, anchor }`.
   c. If it's a title block, extract the sheet identifier and title.
   d. If it's general notes / spec text, extract any tonnage
      assertions or scope items mentioned.

3. Write your output to `./vision-queue/<opp_id>/vision-result.json`
   with the schema below.

---

## Required `vision-result.json` schema

```json
{
  "pages": [
    {
      "filename": "4_Nestle_SCH-FAC_BID-PERMIT_SET.pdf",
      "page_number": 22,
      "extracted_kind": "door_schedule",
      "rows": [
        { "number": "103", "room": "EMPLOYEE ENTRY", "type": "F1",
          "width": "3'-0\"", "height": "7'-0\"",
          "material": "HM", "frame": "HM", "finish": "PTD" }
      ],
      "title_block": { "sheet_no": "G204", "sheet_title": "ACCESSIBILITY GUIDELINES" },
      "tonnage_assertions": [],
      "notes": null,
      "confidence": 0.95
    }
  ],
  "generator_version": "vision-md-v1"
}
```

---

## What good looks like

- **Read every flagged page.** Don't skip ones that look hard.
- **Cite the page number** in every extracted row's source.
- **Don't invent.** If a column is illegible, leave the field null.
  Don't guess the door material from the room name.
- **Distinguish ETR from new.** Doors marked ETR (existing to remain)
  are out of TCB scope — flag them but include the row.
- **Per-page confidence.** 0.95+ for clean printed schedules; 0.7-
  0.85 for hand-marked-up or low-res scans.
