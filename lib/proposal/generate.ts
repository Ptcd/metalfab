/**
 * lib/proposal/generate.ts — render a TCB Metalworks proposal PDF.
 *
 * Built with pdf-lib (already a project dependency). Layout is plain
 * but readable: letterhead, project info, scope of work grouped by
 * category, exclusions, clarifications / RFIs, lump-sum bid total,
 * standard terms, signature block.
 *
 * Pure-ish function: takes structured data, returns Uint8Array PDF
 * bytes. The API route handles persistence.
 */

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { TCB_LETTERHEAD, STANDARD_TERMS, STANDARD_EXCLUSIONS } from './template';

export interface ProposalInput {
  proposal_number: string;
  generated_at: Date;

  // Project
  project_name: string;
  gc_name: string | null;
  project_location: string | null;

  // Pricing snapshot
  scenario: 'conservative' | 'expected' | 'aggressive';
  bid_total_usd: number;

  // Scope content
  scope_summary: string;
  lines: Array<{
    line_no: number;
    category: string;
    description: string;
    quantity: number;
    quantity_unit: string;
    finish: string | null;
  }>;
  exclusions: string[];                  // bid-specific exclusions (from takeoff)
  clarifications: string[];              // bid-specific clarifications / RFIs
  flagged_assumptions: string[];         // assumption notes from low-confidence lines
}

const MARGIN_X = 60;
const PAGE_WIDTH = 612;                  // US Letter
const PAGE_HEIGHT = 792;
const TEXT_COLOR = rgb(0.12, 0.16, 0.22);
const ACCENT     = rgb(0.10, 0.32, 0.62);
const MUTED      = rgb(0.40, 0.45, 0.55);

interface Layout {
  pdf: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
}

function newPage(layout: Layout): Layout {
  const page = layout.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { ...layout, page, y: PAGE_HEIGHT - 60 };
}

function ensureSpace(layout: Layout, needed: number): Layout {
  if (layout.y - needed < 60) return newPage(layout);
  return layout;
}

/** Soft-wrap a string into lines that fit `maxWidth` at `size`. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawTextBlock(layout: Layout, text: string, opts: {
  font?: PDFFont;
  size?: number;
  color?: ReturnType<typeof rgb>;
  lineGap?: number;
  maxWidth?: number;
} = {}): Layout {
  const font = opts.font || layout.font;
  const size = opts.size ?? 10;
  const color = opts.color ?? TEXT_COLOR;
  const lineGap = opts.lineGap ?? 3;
  const maxWidth = opts.maxWidth ?? PAGE_WIDTH - 2 * MARGIN_X;

  for (const paragraph of text.split('\n')) {
    const lines = wrap(paragraph, font, size, maxWidth);
    for (const line of lines) {
      layout = ensureSpace(layout, size + lineGap + 2);
      layout.page.drawText(line, {
        x: MARGIN_X,
        y: layout.y - size,
        size,
        font,
        color,
      });
      layout.y -= size + lineGap;
    }
  }
  return layout;
}

function drawSectionHeading(layout: Layout, text: string): Layout {
  layout = ensureSpace(layout, 26);
  layout.y -= 8;
  layout.page.drawText(text.toUpperCase(), {
    x: MARGIN_X,
    y: layout.y - 11,
    size: 11,
    font: layout.bold,
    color: ACCENT,
  });
  layout.y -= 14;
  layout.page.drawLine({
    start: { x: MARGIN_X, y: layout.y },
    end:   { x: PAGE_WIDTH - MARGIN_X, y: layout.y },
    thickness: 0.6,
    color: ACCENT,
  });
  layout.y -= 8;
  return layout;
}

function drawHeader(layout: Layout, input: ProposalInput): Layout {
  // Company name
  layout.page.drawText(TCB_LETTERHEAD.company, {
    x: MARGIN_X,
    y: PAGE_HEIGHT - 60,
    size: 22,
    font: layout.bold,
    color: ACCENT,
  });
  layout.page.drawText(TCB_LETTERHEAD.tagline, {
    x: MARGIN_X,
    y: PAGE_HEIGHT - 78,
    size: 9,
    font: layout.font,
    color: MUTED,
  });

  // Right-aligned contact info
  const contact = [
    TCB_LETTERHEAD.address,
    TCB_LETTERHEAD.city,
    TCB_LETTERHEAD.phone,
    TCB_LETTERHEAD.email,
    TCB_LETTERHEAD.website,
  ];
  let cy = PAGE_HEIGHT - 60;
  for (const line of contact) {
    const w = layout.font.widthOfTextAtSize(line, 8);
    layout.page.drawText(line, {
      x: PAGE_WIDTH - MARGIN_X - w,
      y: cy,
      size: 8,
      font: layout.font,
      color: MUTED,
    });
    cy -= 11;
  }

  layout.page.drawLine({
    start: { x: MARGIN_X, y: PAGE_HEIGHT - 105 },
    end:   { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - 105 },
    thickness: 1.2,
    color: ACCENT,
  });

  layout.y = PAGE_HEIGHT - 130;

  // Proposal title + meta
  layout.page.drawText('BID PROPOSAL', {
    x: MARGIN_X,
    y: layout.y - 14,
    size: 14,
    font: layout.bold,
    color: TEXT_COLOR,
  });

  const dateStr = input.generated_at.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const meta = [
    ['Proposal #:', input.proposal_number],
    ['Date:',       dateStr],
    ['Project:',    input.project_name],
  ];
  if (input.gc_name)         meta.push(['General Contractor:', input.gc_name]);
  if (input.project_location) meta.push(['Location:',           input.project_location]);

  let my = layout.y - 36;
  for (const [k, v] of meta) {
    layout.page.drawText(k, {
      x: MARGIN_X,
      y: my,
      size: 9,
      font: layout.bold,
      color: MUTED,
    });
    layout.page.drawText(v, {
      x: MARGIN_X + 110,
      y: my,
      size: 10,
      font: layout.font,
      color: TEXT_COLOR,
    });
    my -= 14;
  }
  layout.y = my - 8;
  return layout;
}

function groupLinesByCategory(lines: ProposalInput['lines']): Map<string, ProposalInput['lines']> {
  const map = new Map<string, ProposalInput['lines']>();
  for (const l of lines) {
    if (!map.has(l.category)) map.set(l.category, []);
    map.get(l.category)!.push(l);
  }
  return map;
}

const CATEGORY_LABEL: Record<string, string> = {
  lintel: 'Loose lintels',
  pipe_support: 'Pipe supports',
  hollow_metal_frame: 'Hollow metal frames',
  bollard: 'Pipe bollards',
  embed: 'Embedded steel plates',
  stair: 'Stairs',
  handrail: 'Handrails',
  guardrail: 'Guardrails',
  ladder: 'Ladders',
  misc_metal: 'Miscellaneous metal fabrications',
  structural_beam: 'Structural beams',
  structural_column: 'Structural columns',
  base_plate: 'Bearing and leveling plates',
  shelf_angle: 'Shelf angles',
  overhead_door_framing: 'Overhead door framing',
  other: 'Other items',
};

function drawScopeOfWork(layout: Layout, input: ProposalInput): Layout {
  layout = drawSectionHeading(layout, 'Scope of Work');
  layout = drawTextBlock(layout, input.scope_summary, { size: 10, lineGap: 3 });
  layout.y -= 6;

  layout = drawTextBlock(layout, 'Included:', { font: layout.bold, size: 10 });

  const grouped = groupLinesByCategory(input.lines);
  const entries = Array.from(grouped.entries());
  for (const [category, items] of entries) {
    const label = CATEGORY_LABEL[category] || category;
    const summary = items.length === 1
      ? `${items[0].quantity} ${items[0].quantity_unit} — ${items[0].description}`
      : `${items.length} items: ${items.map((i: ProposalInput['lines'][number]) => `${i.quantity} ${i.quantity_unit}`).join(', ')}`;
    const finishSet = new Set<string>();
    items.forEach((i: ProposalInput['lines'][number]) => { if (i.finish) finishSet.add(i.finish); });
    const finishes = Array.from(finishSet);
    const finishStr = finishes.length ? ` (${finishes.join(' / ')})` : '';
    layout = drawTextBlock(layout, `• ${label}${finishStr}: ${summary}`, { size: 10, lineGap: 3 });
  }
  return layout;
}

function drawBidTotal(layout: Layout, input: ProposalInput): Layout {
  layout = drawSectionHeading(layout, 'Bid Total — Lump Sum');
  layout = ensureSpace(layout, 56);

  const dollars = `$${Math.round(input.bid_total_usd).toLocaleString()}`;
  layout.page.drawRectangle({
    x: MARGIN_X,
    y: layout.y - 50,
    width: PAGE_WIDTH - 2 * MARGIN_X,
    height: 46,
    color: rgb(0.94, 0.96, 0.99),
    borderColor: ACCENT,
    borderWidth: 1,
  });
  layout.page.drawText('Total Lump Sum:', {
    x: MARGIN_X + 16,
    y: layout.y - 30,
    size: 11,
    font: layout.bold,
    color: TEXT_COLOR,
  });
  const w = layout.bold.widthOfTextAtSize(dollars, 18);
  layout.page.drawText(dollars, {
    x: PAGE_WIDTH - MARGIN_X - 16 - w,
    y: layout.y - 35,
    size: 18,
    font: layout.bold,
    color: ACCENT,
  });
  layout.y -= 54;
  layout = drawTextBlock(layout, 'Includes material, fabrication, finishing, delivery, overhead, profit, and bond. See terms below for what is and is not included.', { size: 8, color: MUTED, lineGap: 2 });
  return layout;
}

function drawList(layout: Layout, items: string[]): Layout {
  for (const item of items) {
    layout = drawTextBlock(layout, `• ${item}`, { size: 10, lineGap: 3 });
  }
  return layout;
}

function drawSignatureBlock(layout: Layout): Layout {
  layout = drawSectionHeading(layout, 'Acceptance');
  layout = ensureSpace(layout, 80);
  layout = drawTextBlock(layout,
    'Acceptance of this proposal constitutes a binding agreement on the terms above, pending execution of a written subcontract.',
    { size: 9, color: MUTED, lineGap: 2 }
  );
  layout.y -= 18;

  // Two signature lines side by side
  const colW = (PAGE_WIDTH - 2 * MARGIN_X - 30) / 2;
  const baseline = layout.y - 12;
  layout.page.drawLine({ start: { x: MARGIN_X, y: baseline }, end: { x: MARGIN_X + colW, y: baseline }, thickness: 0.6, color: TEXT_COLOR });
  layout.page.drawLine({ start: { x: MARGIN_X + colW + 30, y: baseline }, end: { x: PAGE_WIDTH - MARGIN_X, y: baseline }, thickness: 0.6, color: TEXT_COLOR });

  layout.page.drawText('TCB Metalworks', { x: MARGIN_X, y: baseline - 12, size: 9, font: layout.bold, color: TEXT_COLOR });
  layout.page.drawText('Date', { x: MARGIN_X, y: baseline - 24, size: 8, font: layout.font, color: MUTED });
  layout.page.drawText('Accepted by (General Contractor)', { x: MARGIN_X + colW + 30, y: baseline - 12, size: 9, font: layout.bold, color: TEXT_COLOR });
  layout.page.drawText('Date', { x: MARGIN_X + colW + 30, y: baseline - 24, size: 8, font: layout.font, color: MUTED });

  layout.y = baseline - 38;
  return layout;
}

export async function generateProposal(input: ProposalInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TCB_LETTERHEAD.company} — ${input.proposal_number}`);
  pdf.setAuthor(TCB_LETTERHEAD.company);
  pdf.setSubject(`Bid Proposal for ${input.project_name}`);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let layout: Layout = {
    pdf,
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    font,
    bold,
    y: PAGE_HEIGHT - 60,
  };

  layout = drawHeader(layout, input);
  layout = drawScopeOfWork(layout, input);
  layout = drawBidTotal(layout, input);

  layout = drawSectionHeading(layout, 'Exclusions');
  layout = drawList(layout, [...input.exclusions, ...STANDARD_EXCLUSIONS]);

  if (input.clarifications.length || input.flagged_assumptions.length) {
    layout = drawSectionHeading(layout, 'Clarifications and Assumptions');
    if (input.clarifications.length) {
      layout = drawTextBlock(layout, 'Items requiring clarification from the GC:', { font: bold, size: 10 });
      layout = drawList(layout, input.clarifications);
      layout.y -= 6;
    }
    if (input.flagged_assumptions.length) {
      layout = drawTextBlock(layout, 'Assumptions made for items not yet on construction documents:', { font: bold, size: 10 });
      layout = drawList(layout, input.flagged_assumptions);
    }
  }

  layout = drawSectionHeading(layout, 'Standard Terms');
  for (const t of STANDARD_TERMS) {
    layout = drawTextBlock(layout, t.heading, { font: bold, size: 10, lineGap: 1 });
    layout = drawTextBlock(layout, t.body, { size: 9, color: MUTED, lineGap: 2 });
    layout.y -= 4;
  }

  layout = drawSignatureBlock(layout);

  return pdf.save();
}
