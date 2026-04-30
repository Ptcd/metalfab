/**
 * parse-schedule.js — reconstruct construction-drawing schedules
 * (door, lintel, embed, frame schedules) from the pdfjs item-with-
 * positions output produced by extract-text.js.
 *
 * Vector-rendered tables flatten when you join the text linearly, but
 * the original column / row geometry is preserved in the per-item x/y
 * coordinates. This module clusters items by Y (rows) then orders each
 * row by X (cells), recognizes a header row, and emits structured rows.
 *
 * Validated on Nestle/Camosy bid-permit-set page 22 (Nestle door
 * schedule): pulled 16 schedule rows with door number, room name,
 * type, dimensions, material, frame type. Distinguished ETR (existing
 * to remain) rows from new construction.
 *
 * Usage:
 *   const { parseSchedules } = require('./parse-schedule');
 *   const schedules = parseSchedules(page); // → [{ kind, rows: [...], region: {...} }]
 */

// Header column-label patterns we look for to identify a schedule
// table on a given page. Each entry has `expected` (any of) + `required`
// (at least one of these must match). The required set rules out false
// positives — e.g. an electrical motor schedule has 'mark' and 'size'
// columns but doesn't have 'lintel' or 'span', so it won't be picked
// up as a lintel schedule.
const SCHEDULE_HEADERS = [
  {
    kind: 'door_schedule',
    expected: ['number', 'room', 'width', 'height', 'type', 'material', 'frame', 'hardware', 'finish'],
    required: ['frame', 'hardware'],   // both door-specific
    minMatches: 4,
    minRequired: 1,
  },
  {
    kind: 'lintel_schedule',
    expected: ['mark', 'lintel', 'size', 'span', 'bearing', 'angle', 'plate', 'opening'],
    required: ['lintel', 'span', 'bearing'],  // any one of these is lintel-specific
    minMatches: 3,
    minRequired: 1,
  },
  {
    kind: 'embed_schedule',
    expected: ['mark', 'embed', 'plate', 'studs', 'anchor', 'detail', 'thickness'],
    required: ['embed', 'studs', 'anchor'],  // 'plate' alone is too common
    minMatches: 3,
    minRequired: 1,
  },
  {
    kind: 'frame_schedule',
    expected: ['mark', 'frame', 'type', 'size', 'material', 'profile', 'gauge', 'jamb'],
    required: ['frame', 'jamb'],
    minMatches: 3,
    minRequired: 1,
  },
  {
    kind: 'beam_schedule',
    expected: ['mark', 'beam', 'size', 'span', 'reaction', 'camber', 'shape'],
    required: ['beam', 'reaction', 'camber'],
    minMatches: 3,
    minRequired: 1,
  },
  {
    // Equipment schedule (E60 BOLLARD, RTU-1, EH-1, etc.). Critical
    // because architects often list TCB-relevant items here that
    // never appear in a structural or door schedule. The Nestle bid
    // had bollards (E60) only visible via the equipment schedule.
    kind: 'equipment_schedule',
    expected: ['mark', 'description', 'manufacturer', 'model', 'item', 'quantity', 'qty', 'remarks', 'equipment'],
    required: ['mark', 'description'],   // both must match — distinguishes from generic tables
    minMatches: 3,
    minRequired: 2,
  },
];

// Common equipment-mark prefixes that imply TCB scope when present
// in an equipment schedule. Keyed loose so future additions don't
// need code changes.
const TCB_EQUIPMENT_HINTS = [
  /\bbollard/i,
  /\bladder/i,
  /\brailing/i,
  /\bhandrail/i,
  /\bguardrail/i,
  /\blintel/i,
  /\bembed/i,
  /\bshelf\s+angle/i,
  /\bsteel\s+(?:plate|frame|angle|gate|stair)/i,
  /\bmetal\s+(?:plate|frame|panel|gate|stair)/i,
  /\bhollow\s+metal/i,
];

const ROW_TOLERANCE_PX = 12;     // items within ±12 vertical px count as same row
const REGION_PADDING_PX = 50;    // when bounding a schedule region, pad by this much

function clusterIntoRows(items, tolerance = ROW_TOLERANCE_PX) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const rows = [];
  let curr = [];
  let lastY = -Infinity;
  for (const it of sorted) {
    if (Math.abs(it.y - lastY) > tolerance && curr.length) {
      rows.push(curr);
      curr = [];
    }
    curr.push(it);
    lastY = it.y;
  }
  if (curr.length) rows.push(curr);
  return rows;
}

/**
 * Two improvements to header detection:
 *   1. Require a real schedule shape: 4-25 items in the header row
 *      (filters out floor-plan strips with 30+ scattered labels) AND
 *      ≥25% of those items must be header-keyword matches.
 *   2. Multi-row header support: when the next row has short tokens
 *      ('BY', etc.) that match column x-positions in the prior row,
 *      merge them so 'PROVIDED' + 'BY' → 'PROVIDED BY' as one cell.
 */
function detectHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // 4-30 items: door schedules can have ~25 columns (door+frame+hw
    // +fire+access+comments). Floor plans typically have 30+ scattered
    // labels at similar y, so the upper bound still filters them, and
    // the 25% match-ratio gate below catches stragglers.
    if (row.length < 4 || row.length > 30) continue;
    const tokens = row.map((it) => it.str.toLowerCase());
    for (const header of SCHEDULE_HEADERS) {
      const matches = header.expected.filter((label) =>
        tokens.some((t) => t.includes(label))
      ).length;
      const requiredMatches = (header.required || []).filter((label) =>
        tokens.some((t) => t.includes(label))
      ).length;
      // Ratio gate: at least 25% of the row's items must match an
      // expected header label. Real headers are ~50%+; coincidental
      // matches in floor plans are <15%.
      const matchRatio = matches / row.length;
      if (matchRatio < 0.25) continue;
      if (matches >= header.minMatches && requiredMatches >= (header.minRequired || 0)) {
        let mergedRow = [...row];
        // Multi-row header merge: if the next row has tokens at
        // similar x-positions whose tokens are short ('BY', 'TYP',
        // numbers), combine them into the header row's cells.
        const nextRow = rows[i + 1];
        if (nextRow && nextRow.length >= 2 && nextRow.length <= row.length + 4) {
          const nextShortTokens = nextRow.filter((it) => it.str.length <= 6);
          if (nextShortTokens.length >= 2) {
            for (const nx of nextShortTokens) {
              const closest = mergedRow.reduce((best, it) =>
                Math.abs(it.x - nx.x) < Math.abs(best.x - nx.x) ? it : best, mergedRow[0]);
              if (closest && Math.abs(closest.x - nx.x) <= Math.max(40, (closest.font_size || 12) * 4)) {
                closest.str = (closest.str + ' ' + nx.str).trim();
              }
            }
          }
        }
        const sortedRow = [...mergedRow].sort((a, b) => a.x - b.x);
        return {
          row: sortedRow,
          rowIndex: i,
          kind: header.kind,
          columnXs: sortedRow.map((it) => it.x),
          headerLabels: sortedRow.map((it) => it.str),
          mergedFromMultiRow: nextRow && rows[i + 1] !== rows[i],
        };
      }
    }
  }
  return null;
}

function rowToCells(row, columnXs, headerLabels) {
  // Sort row items by x and bucket them into the closest column.
  const sortedRow = [...row].sort((a, b) => a.x - b.x);
  const cells = headerLabels.map(() => []);
  for (const it of sortedRow) {
    let bestIdx = 0;
    let bestDist = Math.abs(it.x - columnXs[0]);
    for (let i = 1; i < columnXs.length; i++) {
      const d = Math.abs(it.x - columnXs[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    cells[bestIdx].push(it.str);
  }
  // Build a {label: combinedText} object
  const out = {};
  for (let i = 0; i < headerLabels.length; i++) {
    const label = headerLabels[i].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    out[label] = cells[i].join(' ').trim();
  }
  return out;
}

/**
 * Extract schedules from a single page's items[].
 *
 * Strategy:
 *  1. Cluster all items by Y → rows
 *  2. Find a header row whose labels match a known schedule type
 *  3. For rows below the header, bucket cells into columns and emit
 *  4. Stop when we hit a row that looks structurally different (very
 *     few items, very wide gap, or matches a different header)
 */
function parseSchedules(page) {
  const allRows = clusterIntoRows(page.items);
  const header = detectHeaderRow(allRows);
  if (!header) return [];

  // Schedule body rows = rows after the header (and the merged second-
  // header-row if we combined them) until we hit a clear break.
  const bodyStart = header.rowIndex + (header.mergedFromMultiRow ? 2 : 1);
  const body = [];
  for (let i = bodyStart; i < allRows.length; i++) {
    const row = allRows[i];
    // Filter out rows that are clearly outside the schedule x-range
    const minX = Math.min(...header.columnXs) - REGION_PADDING_PX;
    const maxX = Math.max(...header.columnXs) + REGION_PADDING_PX;
    const inRange = row.filter((it) => it.x >= minX && it.x <= maxX);
    if (inRange.length === 0) continue;
    // If a row only has 1-2 items but the header had many columns, it's
    // probably a section divider or a stray label — skip
    if (inRange.length < 3 && header.columnXs.length > 4) continue;
    body.push(inRange);
  }

  const rows = body.map((row) => rowToCells(row, header.columnXs, header.headerLabels));

  // Body-quality check: most schedule kinds have a recognizable mark
  // pattern in the first column. If fewer than half the rows match,
  // it's almost certainly a false-positive header match (random text
  // on the page that happened to overlap with column labels).
  const MARK_PATTERNS = {
    door_schedule:   /^\d{2,3}[A-Za-z]?$/,                           // 103, 112a, 125B
    lintel_schedule: /^L\d{1,2}$|^LIN[\s-]?\d+$/i,                   // L1, L12, LIN-3
    embed_schedule:  /^E\d{1,2}$|^EMB[\s-]?\d+$/i,                   // E1, EMB-4
    frame_schedule:  /^[A-Z]\d{1,2}$/,                               // F1, S2
    beam_schedule:   /^[BWG]\d{1,3}$|^BM[\s-]?\d+$/i,                // B12, W123, BM-7
  };
  const markRe = MARK_PATTERNS[header.kind];
  if (markRe && rows.length > 0) {
    let matched = 0;
    for (const r of rows) {
      // Scan every cell's tokens — one mark per row is enough
      const allTokens = Object.values(r)
        .filter((v) => v != null && v !== '')
        .flatMap((v) => String(v).split(/\s+/));
      if (allTokens.some((t) => markRe.test(t))) matched++;
    }
    const matchRate = matched / rows.length;
    if (matchRate < 0.4) {
      // Too many noise rows — don't surface this schedule
      return [];
    }
  }

  // Bound the region for the orchestrator to use later (e.g. to crop
  // for a vision pass or to avoid double-counting items)
  const allItems = [header.row, ...body].flat();
  const xs = allItems.map((it) => it.x);
  const ys = allItems.map((it) => it.y);
  const region = xs.length === 0 ? null : {
    x_min: Math.min(...xs),
    x_max: Math.max(...xs),
    y_min: Math.min(...ys),
    y_max: Math.max(...ys),
  };

  return [{
    kind: header.kind,
    page_number: page.page_number,
    headers: header.headerLabels,
    rows,
    row_count: rows.length,
    region,
  }];
}

/**
 * Door-schedule-specific summarizer. Reads a parsed door schedule and
 * counts HM frames by frame type, distinguishing TCB scope from ETR /
 * aluminum / FRP-supplier doors. Accepts either a single schedule or
 * an array of schedules (the orchestrator hands all door_schedule rows
 * across pages to be deduplicated and counted together).
 */
function summarizeDoorSchedule(scheduleOrList, options = {}) {
  if (!scheduleOrList) return null;
  const schedules = Array.isArray(scheduleOrList) ? scheduleOrList : [scheduleOrList];
  const door = schedules.filter((s) => s && s.kind === 'door_schedule');
  if (door.length === 0) return null;

  // De-dup rows by (room number + door number + room name) — same door
  // often appears on multiple plan-revision sheets in a CD set.
  const seen = new Set();
  const allRows = [];
  for (const s of door) {
    for (const r of s.rows) {
      const key = `${r.number || ''}|${r.door || ''}|${r.room || ''}|${r.room_name || ''}`.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      allRows.push(r);
    }
  }

  const excludeRooms = new Set((options.excludeRoomNumbers || []).map(String));
  const counts = {
    hm_f1: 0,             // standard single HM frame
    hm_f2_glass: 0,        // HM with sidelight / full-glass / FG type
    hm_other: 0,           // other HM categorizations
    etr: 0,                // existing to remain
    aluminum: 0,           // aluminum gates, storefronts (not TCB)
    frp: 0,                // FRP doors and frames (not TCB)
    excluded_by_room: 0,   // user-flagged exclusions (e.g. handwash stations)
    total: allRows.length,
    tcb_rows: [],
  };

  for (const r of allRows) {
    // Heuristic field detection — the column labels vary by drawing standard
    const allText = Object.values(r).join(' ').toLowerCase();
    // Pull all 3-digit room-number candidates from any cell (the parser
    // sometimes concatenates the door number into the room_name cell).
    const candidateNumbers = new Set();
    for (const cell of Object.values(r)) {
      const cellStr = String(cell || '');
      for (const m of cellStr.matchAll(/\b(\d{3}[A-Za-z]?)\b/g)) {
        candidateNumbers.add(m[1]);
      }
    }
    if ([...candidateNumbers].some((n) => excludeRooms.has(n))) {
      counts.excluded_by_room++;
      continue;
    }
    if (/\betr\b|existing.to.remain/.test(allText)) {
      counts.etr++;
      continue;
    }
    if (/\balum/.test(allText)) {
      counts.aluminum++;
      continue;
    }
    if (/\bfrp\b/.test(allText)) {
      counts.frp++;
      continue;
    }
    if (/\bhm\b|hollow.metal/.test(allText)) {
      // FG (full glass) or sidelight = F2-type with glazing
      if (/\bfg\b|hm\/?glass|sidelight|full.glass/.test(allText)) {
        counts.hm_f2_glass++;
      } else if (/\bf1\b|standard|flush|\bf\s/.test(allText)) {
        counts.hm_f1++;
      } else {
        counts.hm_other++;
      }
      counts.tcb_rows.push(r);
    }
  }
  counts.tcb_total = counts.hm_f1 + counts.hm_f2_glass + counts.hm_other;
  return counts;
}

/**
 * Pull TCB-relevant rows from any equipment schedules.
 * Returns { items: [{ mark, description, qty, source_page }] }.
 */
function summarizeEquipmentSchedule(scheduleOrList) {
  if (!scheduleOrList) return null;
  const schedules = Array.isArray(scheduleOrList) ? scheduleOrList : [scheduleOrList];
  const equip = schedules.filter((s) => s && s.kind === 'equipment_schedule');
  if (equip.length === 0) return null;

  const items = [];
  for (const s of equip) {
    for (const r of s.rows || []) {
      // Concatenate ALL cell values — column-mapping is brittle on
      // multi-row schedule headers, but TCB-relevant scope items
      // (BOLLARD, LINTEL, RAILING) tend to land in SOME cell of the
      // row regardless of which header bucket they got assigned to.
      const allCellsText = Object.values(r).join(' ').trim();
      if (!allCellsText) continue;
      const matchedHint = TCB_EQUIPMENT_HINTS.find((re) => re.test(allCellsText));
      if (!matchedHint) continue;
      items.push({
        mark:        r.mark || r.no || r.number || null,
        description: (r.description || r.item || r.equipment || allCellsText).trim().slice(0, 200),
        all_cells:   allCellsText.slice(0, 240),
        matched_pattern: matchedHint.source,
        qty:         r.qty || r.quantity || null,
        provided_by: r.provided || r.by || null,
        remarks:     r.remarks || r.notes || null,
        source_page: s.page_number,
        source_filename: s.source_filename,
      });
    }
  }
  return { tcb_relevant_items: items, total_rows: equip.reduce((a, s) => a + s.rows.length, 0) };
}

/**
 * Door-schedule gate-type filter: door schedule rows where the
 * 'type' column contains 'GATE' are typically NOT TCB scope (alum
 * gates, security gates). Returns the count of gate-type rows for
 * audit logging.
 */
function countDoorScheduleGates(scheduleOrList) {
  if (!scheduleOrList) return 0;
  const schedules = Array.isArray(scheduleOrList) ? scheduleOrList : [scheduleOrList];
  const door = schedules.filter((s) => s && s.kind === 'door_schedule');
  let count = 0;
  for (const s of door) {
    for (const r of s.rows || []) {
      const allText = Object.values(r).join(' ').toLowerCase();
      if (/\bgate\b/.test(allText)) count++;
    }
  }
  return count;
}

module.exports = { parseSchedules, summarizeDoorSchedule, summarizeEquipmentSchedule, countDoorScheduleGates };
