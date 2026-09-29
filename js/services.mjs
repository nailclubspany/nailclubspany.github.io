// The booking form's detailed services: each nail service (and Massage), the
// choices a customer must make for it, and the add-ons they may tick. Edit
// this file to change the menu. A new service (or a renamed one) also needs a matching
// services row — add it in a new supabase/migrations file — so staff can be
// given it in the staff app's Team view. Choices and add-ons are details
// only: they are not staff skills and need no database change.
//
// Pure data and helpers (no DOM) — tested by tests/services.test.mjs.

// The RPC rejects notes longer than this (see request_appointment).
const NOTES_MAX = 1000;

const DESIGN = { label: 'Design', options: ['Solid color', 'French', 'Chrome', 'Other (tell us in notes)'] };
const SET = { label: 'New set or fill', options: ['New set', 'Fill'] };
const LENGTH = { label: 'Length', options: ['Natural nails', 'Extension tips'] };
const POLISH = { label: 'Polish', options: ['Regular polish', 'Gel polish'] };
const SPA = {
  label: 'Spa type',
  options: [
    'Lavender Spa — 10 min massage',
    'Green Tea Spa — 10 min massage + callus removal',
    'Lemon Spa — 20 min massage + callus removal',
    'Mango Spa — 25 min massage + callus removal',
    'Gold Mystique — 30 min massage + callus removal',
  ],
};

const HANDS = ['Massage', 'Paraffin'];
const FEET = ['Callus Removal', 'Massage', 'Paraffin'];

export const NAIL_SERVICES = [
  { name: 'Manicure', choices: [], addOns: HANDS },
  { name: 'Pedicure', choices: [], addOns: FEET },
  { name: 'Gel Manicure', choices: [DESIGN], addOns: HANDS },
  { name: 'Gel Pedicure', choices: [DESIGN], addOns: FEET },
  { name: 'SNS Powder', choices: [DESIGN, LENGTH], addOns: HANDS },
  { name: 'Gel X', choices: [SET, DESIGN], addOns: HANDS },
  { name: 'UV Gel/Hard Gel', choices: [SET, DESIGN, LENGTH], addOns: HANDS },
  { name: 'Spa Pedicure', choices: [SPA, POLISH, DESIGN], addOns: ['Paraffin'] },
  { name: 'Buff & Shine Manicure', choices: [], addOns: HANDS },
  { name: 'Buff & Shine Pedicure', choices: [], addOns: FEET },
  { name: 'Polish Change', choices: [POLISH], addOns: HANDS },
];

const MASSAGE_TYPE = { label: 'Massage type', options: ['Foot', 'Chair', 'Bed'] };
const DURATION = { label: 'Duration', options: ['10 min', '15 min', '30 min', '45 min', '60 min'] };

// Detailed services outside Nails, shown under "Spa & more". Their names are
// existing services rows, so no migration is needed.
export const SPA_SERVICES = [
  { name: 'Massage', choices: [MASSAGE_TYPE, DURATION], addOns: [] },
];

// One line describing a picked service for staff, e.g.
// 'Gel X: Fill, Chrome + Paraffin'. `choices` maps a choice label to the
// picked option; values come out in the catalog's order. A name that isn't
// in either catalog (e.g. Waxing) describes as itself plus any add-ons.
export function describePick(name, choices, addOns) {
  const service = [...NAIL_SERVICES, ...SPA_SERVICES].find((s) => s.name === name);
  const values = (service?.choices ?? []).map((c) => choices[c.label]).filter(Boolean);
  let line = values.length ? `${name}: ${values.join(', ')}` : name;
  if (addOns.length) line += ` + ${addOns.join(' + ')}`;
  return line;
}

// The appointment notes staff see: the service detail lines first, then a
// blank line and the customer's own notes. Capped so the RPC never rejects it.
export function bookingNotes(detailLines, customerNotes) {
  const parts = [];
  if (detailLines.length) parts.push(detailLines.join('\n'));
  if (customerNotes) parts.push(customerNotes);
  return parts.join('\n\n').slice(0, NOTES_MAX);
}
