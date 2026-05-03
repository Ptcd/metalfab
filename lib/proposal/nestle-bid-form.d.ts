export interface NestleBidFormLine {
  line_no: number;
  category: string;
  description: string;
  quantity: number | null;
  quantity_unit: string | null;
  line_total_usd: number;
}

export interface NestleBidFormInput {
  lines: NestleBidFormLine[];
  bid_total_usd: number;
  subtotal_usd: number;
  rate_card: {
    foreman_per_hr: number;
    ironworker_per_hr: number;
    fab_per_hr: number;
  };
  project: {
    project_name: string;
    sf: number | null;
    substantial_completion: string | null;
    commencement: string | null;
  };
  proposal_number: string;
  open_rfis: string[];
  generated_at: string;
}

export function generateNestleBidForm(input: NestleBidFormInput, templateBuffer?: Buffer): Buffer;

export function rowForCategory(category: string): string | null;

export const ROWS: Record<string, number>;
export const COLS: Record<string, string>;
