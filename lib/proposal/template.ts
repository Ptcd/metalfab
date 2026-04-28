/**
 * lib/proposal/template.ts — TCB Metalworks letterhead and standard
 * boilerplate text for generated proposals. Edit here once; every
 * proposal picks up the change.
 *
 * No DB lookup yet — these are constants. When/if we want Colin to
 * tweak terms per-proposal, lift these to a `proposal_templates`
 * table and add an admin UI.
 */

export const TCB_LETTERHEAD = {
  company:  'TCB Metalworks',
  tagline:  'Custom steel fabrication · Wisconsin',
  address:  '— address line —',          // TODO: fill from settings
  city:     '— city, state, zip —',
  phone:    '— phone —',
  email:    'bids@tcbmetalworks.com',
  website:  'tcbmetalworks.com',
};

export const STANDARD_TERMS = [
  {
    heading: 'Payment Terms',
    body: 'Net 30 from date of invoice unless otherwise agreed in the executed subcontract. Progress billings monthly per percentage complete.',
  },
  {
    heading: 'Lead Time',
    body: 'Lead time will be confirmed at receipt of approved shop drawings. Typical lead times: 4–6 weeks for misc metals, 6–10 weeks for structural steel framing, dependent on mill availability and finish (galvanizing).',
  },
  {
    heading: 'Price Validity',
    body: 'This proposal is valid for 30 days from the date above. Steel material costs are subject to mill confirmation at order — TCB reserves the right to adjust the bid in writing if material pricing moves more than 5% from the date of this proposal.',
  },
  {
    heading: 'Taxes',
    body: 'Wisconsin state sales tax included in the bid total above unless otherwise indicated.',
  },
  {
    heading: 'Bonds and Insurance',
    body: 'Performance and payment bond included at the rate shown in the bid total. General liability and workers compensation insurance included. Bonding capacity available; certificate of insurance furnished upon request.',
  },
  {
    heading: 'Welding and Quality',
    body: 'All welding to AWS D1.1 by certified welders. Galvanizing per ASTM A123 / A153. AISC certified shop. Inspections per spec; special inspections by Owner.',
  },
  {
    heading: 'Changes',
    body: 'Any changes to scope, drawings, or addenda issued after this proposal date require a written change order before TCB proceeds with affected work.',
  },
  {
    heading: 'Schedule',
    body: 'TCB to coordinate fabrication and delivery with the GC schedule. Multiple deliveries can be accommodated; mobilization to site for field-installed items quoted as listed in the bid total.',
  },
];

export const STANDARD_EXCLUSIONS = [
  'Reinforcing steel (rebar) and dowels',
  'Concrete, masonry, grout, and epoxy unless explicitly listed',
  'Metal roof, wall, or fascia panels',
  'Glazing, curtain wall, storefront, and aluminum windows',
  'HVAC ductwork, piping, and supports for trades other than as listed',
  'Field painting beyond galvanizing touch-up',
  'Engineering / PE stamp unless explicitly listed',
  'Permits and AHJ fees',
  'Material testing and special inspection (by Owner)',
  'Unloading and storage by others if delivery is to a staging yard',
  'Temporary shoring, bracing, scaffolding, and lifts',
];
