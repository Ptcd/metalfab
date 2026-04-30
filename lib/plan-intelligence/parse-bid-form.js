/**
 * parse-bid-form.js — read the GC's bid form to learn what CSI codes
 * the takeoff is allowed to populate.
 *
 * GCs publish a bid form (xlsx or PDF) that lists the CSI line items
 * they want priced. If `05 50 00 Metal Fabrications` isn't on it,
 * misc-metals shouldn't be a takeoff line — it has nowhere to land
 * in the GC's compilation. The bid-form CSI list becomes the
 * authoritative scope envelope: takeoff line categories that map to
 * codes outside this envelope are phantom items.
 *
 * Supports xlsx via the existing tooling pattern (pandas via Python
 * subprocess if present; otherwise heuristic text scan of any PDF
 * the user uploaded as the form).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// CSI category → likely takeoff_lines.category. Used to map the
// bid-form's listed CSI codes back into "is this takeoff line allowed?"
const CSI_TO_CATEGORY = {
  '05 10 00': ['structural_beam', 'structural_column', 'base_plate'],
  '05 12 00': ['structural_beam', 'structural_column', 'base_plate'],
  '05 21 00': ['structural_beam'],            // joists
  '05 30 00': [],                              // metal decking — typically not TCB
  '05 40 00': ['misc_metal'],                  // cold-formed framing (RTU frames, etc)
  '05 50 00': ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing'],
  '05 51 00': ['stair'],                       // metal stairs
  '05 51 13': ['stair'],
  '05 51 33': ['ladder'],
  '05 52 00': ['handrail', 'guardrail'],
  '05 53 00': ['misc_metal'],                  // gratings
  '05 54 00': ['misc_metal'],                  // floor plates
  '05 73 00': ['handrail', 'guardrail'],       // decorative railings
  '05 75 00': ['misc_metal'],                  // decorative metal
  '08 11 13': ['hollow_metal_frame'],
  '08 12 11': ['hollow_metal_frame'],
  '08 12 13': ['hollow_metal_frame'],
  '08 36 13': ['overhead_door_framing'],
  // 08 00 00 (catch-all door category) — covers HM frames in many GC bid forms
  '08 00 00': ['hollow_metal_frame'],
  // 05 00 00 (catch-all metals) — covers most TCB scope
  '05 00 00': ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing', 'structural_beam', 'structural_column', 'base_plate', 'stair', 'handrail', 'guardrail', 'hollow_metal_frame'],
};

const CSI_RE = /\b(\d{2})\s+(\d{2})\s+(\d{2})\b/g;

/**
 * Extract CSI codes from xlsx bid form via Python subprocess.
 * Returns array of { code, description, found_at }.
 */
function parseXlsxBidForm(filepath) {
  // Write the helper to a temp file to avoid quote-escaping pain on
  // Windows + cross-platform shells.
  const py = [
    'import pandas as pd, json, sys, re',
    'codes = []',
    'xl = pd.read_excel(sys.argv[1], sheet_name=None, header=None)',
    'pat = re.compile(r"\\b(\\d{2})\\s+(\\d{2})\\s+(\\d{2})\\b")',
    'for name, df in xl.items():',
    '    for i in range(len(df)):',
    '        row = df.iloc[i]',
    '        cells = [str(v) for v in row.values if pd.notna(v)]',
    '        text = " | ".join(cells)',
    '        for m in pat.finditer(text):',
    '            code = m.group(1) + " " + m.group(2) + " " + m.group(3)',
    '            codes.append({"code": code, "description": text[:140], "sheet": name, "row": i})',
    'print(json.dumps(codes))',
  ].join('\n');
  const tmpScript = path.join(require('os').tmpdir(), `bidform-parse-${Date.now()}.py`);
  fs.writeFileSync(tmpScript, py);
  try {
    const out = execSync(`python "${tmpScript}" "${filepath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e) {
    console.error('parseXlsxBidForm failed:', e.message?.slice(0, 200));
    return [];
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
}

/**
 * Extract CSI codes from PDF bid form via the existing extract-text.
 */
async function parsePdfBidForm(buffer) {
  const { extractText } = require('./extract-text');
  const pages = await extractText(buffer);
  const codes = [];
  for (const p of pages) {
    const text = p.items.map((i) => i.str).join(' ');
    for (const m of text.matchAll(CSI_RE)) {
      codes.push({
        code: `${m[1]} ${m[2]} ${m[3]}`,
        description: text.slice(Math.max(0, m.index - 30), m.index + 80).replace(/\s+/g, ' '),
        page: p.page_number,
      });
    }
  }
  return codes;
}

/**
 * Build the allowed-categories envelope from a bid-form CSI code list.
 * If the form lists `05 00 00` we open the gate to all 05 categories;
 * otherwise we only allow the specific subcodes listed.
 */
function allowedCategoriesFromCsi(csiCodes) {
  const allowed = new Set();
  for (const { code } of csiCodes) {
    const cats = CSI_TO_CATEGORY[code];
    if (cats) cats.forEach((c) => allowed.add(c));
  }
  return [...allowed];
}

/**
 * Cross-check takeoff line categories against the bid-form envelope.
 * Returns { in_scope[], phantom[], finding[] }.
 */
function crossCheckTakeoffCategories(takeoffLineCategories, csiCodes) {
  const allowed = new Set(allowedCategoriesFromCsi(csiCodes));
  const csiList = csiCodes.map((c) => c.code);

  const inScope = [];
  const phantom = [];
  for (const cat of takeoffLineCategories) {
    if (allowed.has(cat)) inScope.push(cat);
    else phantom.push(cat);
  }

  const findings = [];
  for (const cat of [...new Set(phantom)]) {
    findings.push({
      severity: 'warning',
      category: 'phantom_scope',
      finding: `Takeoff has ${cat} line(s) but the GC's bid form does not list a CSI code that maps to ${cat}. Form lists only: ${csiList.join(', ')}.`,
      recommendation: `Either drop the ${cat} line(s) from the takeoff, or confirm with the GC whether ${cat} should be added to the bid form / submitted as an alternate.`,
    });
  }

  return {
    bid_form_csi_codes: csiList,
    allowed_categories: [...allowed],
    takeoff_categories: [...new Set(takeoffLineCategories)],
    in_scope: [...new Set(inScope)],
    phantom: [...new Set(phantom)],
    findings,
  };
}

module.exports = { parseXlsxBidForm, parsePdfBidForm, allowedCategoriesFromCsi, crossCheckTakeoffCategories };
