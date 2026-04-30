# Vision Title-Block OCR — Claude Code Workflow

You are reading **only the title block of each flagged drawing page**
to extract the sheet identifier (e.g. A201, S101, P501, M-101) and
sheet title that text extraction couldn't find. The title block is
typically rendered as line geometry instead of text on these pages,
which is why the deterministic parser missed them.

**Do not call any Anthropic API.** Read the PDFs directly with the
`Read` tool, page-by-page.

---

## Workflow

1. Read `./vision-titleblocks-queue/<opp_id>/context.json`. It contains:
   - `pages_to_process` — list of `{ filename, page_number }` where
     deterministic title-block extraction failed.
2. For each page:
   - Use `Read` with `pages: "<n>"` to render the page.
   - **Look only at the bottom-right corner** (~30% of the page).
     Title blocks are conventionally there.
   - Extract `sheet_no` and `sheet_title`.
3. Write `./vision-titleblocks-queue/<opp_id>/result.json`.

## Output schema

```json
{
  "title_blocks": [
    {
      "filename": "...",
      "page_number": 44,
      "sheet_no": "A4.10",
      "sheet_title": "INTERIOR ELEVATIONS",
      "confidence": 0.95
    }
  ],
  "generator_version": "vision-titleblocks-v1"
}
```

## Rules

- **Be exact.** Don't guess if the rendered image is unclear — leave
  fields null with confidence < 0.7.
- **Sheet titles in CAPS** are the standard convention; preserve case.
- **Watch for revision tags.** "A4.10R" or "A4.10 REV 1" — capture
  the base identifier without the revision suffix.
- **Process in batches of 10–15 pages per session.** Vision rendering
  is slow; the queue caps at 30 pages by default.
