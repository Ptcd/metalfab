/**
 * lib/takeoff/rfi.ts — auto-generate Request-For-Information questions
 * for the GC from a takeoff. For every line whose confidence is below
 * the threshold (default 0.70) or that is flagged_for_review, draft a
 * specific question that:
 *   - cites the source we DID find ("per spec section 05 50 00 page 48")
 *   - states the gap ("we could not determine quantity / size / type")
 *   - asks the GC for a concrete confirmation
 *
 * Bundle-ready output: numbered list of questions Colin can paste into
 * Camosy's Ariba portal, Bonfire, email, etc. — or a downloadable PDF.
 */

const DEFAULT_THRESHOLD = 0.70;

export interface TakeoffLineForRFI {
  line_no: number;
  category: string;
  description: string;
  quantity: number;
  quantity_unit: string;
  quantity_band: string;
  quantity_min: number | null;
  quantity_max: number | null;
  steel_shape_designation: string | null;
  source_kind: string;
  source_section: string | null;
  source_page: number | null;
  source_evidence: string | null;
  confidence: number;
  flagged_for_review: boolean;
  assumptions: string | null;
}

export interface RFIQuestion {
  rfi_no: number;
  line_no: number;
  category: string;
  topic: string;        // short headline ("HM frame count", "Lintel sizes")
  question: string;     // full question text
  context: string;      // what we found / our current assumption
  source_cited: string; // where it came from
  asked_for: string;    // what we want the GC to confirm
  copy_text: string;    // ready-to-paste single string for portals
}

const TOPIC_LABELS: Record<string, string> = {
  lintel: 'Lintel quantity, sizes, and clear-span dimensions',
  pipe_support: 'Pipe support count, base-plate sizes, and anchor type',
  hollow_metal_frame: 'Hollow metal frame count by frame type',
  bollard: 'Bollard count, locations, and pipe size',
  embed: 'Embed plate count, plate size, and stud detail',
  shelf_angle: 'Shelf angle linear footage and connection detail',
  stair: 'Stair count, riser count, width, finish',
  handrail: 'Handrail linear footage and termination detail',
  guardrail: 'Guardrail linear footage, height, and infill type',
  ladder: 'Ladder count, height, and cage requirement',
  overhead_door_framing: 'Overhead door frame size and bar-stop detail',
  structural_beam: 'Structural beam dimensions and connection design',
  structural_column: 'Structural column dimensions and base-plate detail',
  base_plate: 'Bearing / leveling plate count, size, and locations',
  misc_metal: 'Miscellaneous metal scope and quantity',
  other: 'Scope item details',
};

function topicFor(category: string): string {
  return TOPIC_LABELS[category] || `${category} scope and quantity`;
}

function bandPhrase(line: TakeoffLineForRFI): string {
  if (line.quantity_band === 'point') return `${line.quantity} ${line.quantity_unit}`;
  if (line.quantity_band === 'range' && line.quantity_min != null && line.quantity_max != null) {
    return `${line.quantity_min}–${line.quantity_max} ${line.quantity_unit} (assumed ${line.quantity} ${line.quantity_unit})`;
  }
  return `${line.quantity} ${line.quantity_unit} (assumed-typical)`;
}

function buildContext(line: TakeoffLineForRFI): string {
  const parts: string[] = [];
  parts.push(`Per the bid documents, we identified ${line.description.toLowerCase()}.`);
  if (line.source_section || line.source_page) {
    const cite = [line.source_section, line.source_page ? `page ${line.source_page}` : null]
      .filter(Boolean)
      .join(', ');
    parts.push(`Source: ${cite}.`);
  }
  parts.push(`Our current quantity is ${bandPhrase(line)}.`);
  if (line.assumptions) parts.push(`Assumption: ${line.assumptions}`);
  return parts.join(' ');
}

function buildAskFor(line: TakeoffLineForRFI): string {
  // Tailor the ask to the kind of gap
  if (line.source_kind === 'assumption' || line.source_kind === 'industry_default') {
    return `Please confirm the ${line.category.replace(/_/g, ' ')} quantity, sizes, and locations, or clarify whether this scope is excluded from TCB's bid.`;
  }
  if (line.flagged_for_review) {
    if (line.quantity_band === 'assumed_typical') {
      return `Please confirm the ${line.category.replace(/_/g, ' ')} quantity. Our draft assumes ${line.quantity} ${line.quantity_unit} based on typical scope for this building type; verify against the final schedule or detail.`;
    }
    if (line.quantity_band === 'range') {
      return `Please confirm the ${line.category.replace(/_/g, ' ')} count between our assumed range of ${line.quantity_min}–${line.quantity_max} ${line.quantity_unit}.`;
    }
  }
  return `Please confirm the ${line.category.replace(/_/g, ' ')} quantity and sizing details.`;
}

export function generateRFIs(
  lines: TakeoffLineForRFI[],
  opts: { threshold?: number } = {},
): RFIQuestion[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const candidates = lines.filter(
    (l) => l.confidence < threshold || l.flagged_for_review
  );
  // Sort by line_no so RFIs read in the same order as the takeoff
  candidates.sort((a, b) => a.line_no - b.line_no);

  const out: RFIQuestion[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const l = candidates[i];
    const topic = topicFor(l.category);
    const context = buildContext(l);
    const askFor = buildAskFor(l);
    const sourceCited = [
      l.source_section,
      l.source_page ? `p${l.source_page}` : null,
    ].filter(Boolean).join(', ') || `inferred from ${l.source_kind}`;

    const copyText =
      `Q${i + 1}: ${topic}\n` +
      `Context: ${context}\n` +
      `Source: ${sourceCited}\n` +
      `Request: ${askFor}`;

    out.push({
      rfi_no: i + 1,
      line_no: l.line_no,
      category: l.category,
      topic,
      question: askFor,
      context,
      source_cited: sourceCited,
      asked_for: askFor,
      copy_text: copyText,
    });
  }
  return out;
}

/** Format the full RFI list as one paste-ready string for portal upload */
export function formatRFIList(rfis: RFIQuestion[], header = ''): string {
  if (rfis.length === 0) return '';
  const lines: string[] = [];
  if (header) lines.push(header, '');
  for (const r of rfis) {
    lines.push(r.copy_text, '');
  }
  return lines.join('\n').trim();
}
