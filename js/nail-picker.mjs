// Renders the optional details of the booking form's services (from
// js/services.mjs) and reads back what the customer picked.
//
// The first screen of the form offers the top-level services only: Nails,
// Massage and the rest, as plain `name="service"` checkboxes. The details
// screen that follows has one section per service that has something to
// ask (`<fieldset data-options-for="Nails">`), shown only while that service
// is ticked:
//   - Nails: the specific nail services, each a `name="service"` checkbox of
//     its own with a panel of choices (radio pills) and add-ons under it.
//     All optional — a customer who picks none is booked for "Nails".
//   - Massage: its type and duration pills.
// A hidden section or panel is also `disabled`, so its controls are skipped
// by form validation and never block a submit. Unticking a service clears
// what was picked in its section, so a hidden pick is never booked.
import { NAIL_SERVICES, SPA_SERVICES, pickedServiceNames, describePick } from './services.mjs';

const DETAILED_NAMES = new Set([...NAIL_SERVICES, ...SPA_SERVICES].map((s) => s.name));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setOpen(item, open) {
  const panel = item.querySelector(':scope > .nail-details');
  if (!panel) return;
  panel.disabled = !open;
  panel.hidden = !open;
  item.classList.toggle('open', open);
  if (!open) {
    for (const error of panel.querySelectorAll('.choice-error')) error.hidden = true;
    for (const group of panel.querySelectorAll('.choice.missing')) group.classList.remove('missing');
  }
}

// A service's choices (radio pills; optional unless the choice is marked
// `required`, and a picked pill can be tapped again to clear it) and add-ons.
function buildPanel(service) {
  const panel = el('fieldset', { className: 'nail-details' });
  for (const choice of service.choices) {
    const pills = el('div', { className: 'pills' });
    // The radios are invisible behind the pills, so the browser's own
    // "please select" bubble is easy to miss; say it under the group instead.
    const error = el('p', { className: 'choice-error', textContent: 'Please choose one.', hidden: true });
    const legend = el('legend', { className: 'choice-label' }, choice.label);
    if (!choice.required) legend.append(el('span', { className: 'optional', textContent: ' (optional)' }));
    const group = el('fieldset', { className: 'choice' }, legend, pills, error);
    choice.options.forEach((option, i) => {
      // `required` on one radio makes the whole same-name group required.
      const radio = el('input', { type: 'radio', name: `${service.name}|${choice.label}`, value: option, required: i === 0 && !!choice.required });
      radio.addEventListener('invalid', () => { error.hidden = false; group.classList.add('missing'); });
      radio.addEventListener('change', () => { error.hidden = true; group.classList.remove('missing'); });
      // Radios can't be unticked, so a tap on the already-picked pill clears
      // an optional choice. dataset.picked is cleared on form reset.
      if (!choice.required) {
        radio.addEventListener('click', () => {
          if (group.dataset.picked === option) { radio.checked = false; delete group.dataset.picked; }
          else group.dataset.picked = option;
        });
      }
      pills.append(el('label', {}, radio, option));
    });
    panel.append(group);
  }
  if (service.addOns.length) {
    const addons = el('div', { className: 'addons' });
    for (const addOn of service.addOns) {
      addons.append(el('label', {}, el('input', { type: 'checkbox', name: `${service.name}|addon`, value: addOn }), ` Add ${addOn}`));
    }
    panel.append(el('fieldset', { className: 'choice' }, el('legend', { className: 'choice-label', textContent: 'Add-ons (optional)' }), addons));
  }
  return panel;
}

// A service as its own checkbox, with its panel opening under it when ticked.
function buildItem(service) {
  const box = el('input', { type: 'checkbox', name: 'service', value: service.name });
  const item = el('div', { className: 'nail-item' }, el('label', {}, box, ` ${service.name}`));
  if (!service.choices.length && !service.addOns.length) return item;
  item.append(Object.assign(buildPanel(service), { disabled: true, hidden: true }));
  box.addEventListener('change', () => setOpen(item, box.checked));
  return item;
}

// The nail services, each with its own checkbox, into the Nails section.
export function renderNailPicker(host, services = NAIL_SERVICES) {
  host.append(...services.map(buildItem));
}

// Just the choices of a service that was already ticked on the first screen
// (Massage), into its section.
export function renderChoices(host, service) {
  host.append(buildPanel(service));
}

function clearSection(section) {
  for (const input of section.querySelectorAll('input')) input.checked = false;
  for (const choice of section.querySelectorAll('.choice')) delete choice.dataset.picked;
  for (const item of section.querySelectorAll('.nail-item')) setOpen(item, false);
}

// Shows each `[data-options-for]` section only while its service is ticked.
// Returns hasOptions(): whether any section is showing, i.e. whether the
// details screen has anything on it.
export function wireOptionSections(form) {
  const sections = [...form.querySelectorAll('[data-options-for]')].map((section) => ({
    section,
    box: form.querySelector(`input[name="service"][value="${section.dataset.optionsFor}"]`),
  }));
  function sync({ section, box }) {
    const open = box.checked;
    if (!open) clearSection(section);
    section.disabled = !open;
    section.hidden = !open;
  }
  for (const pair of sections) pair.box.addEventListener('change', () => sync(pair));
  // form.reset() unticks the boxes without firing `change`, so close the
  // sections to match — after the reset has actually happened.
  form.addEventListener('reset', () => setTimeout(() => sections.forEach(sync), 0));
  sections.forEach(sync);
  return () => sections.some(({ box }) => box.checked);
}

// What the customer picked: `names` for the RPC and staff matching, and
// `detailLines` (one per service, with its choices and add-ons) for staff.
// `pickDetailLines` is the detailed-service subset (nails, Massage) — the
// lines that add something beyond the bare service names already stored with
// the appointment.
export function serviceSummary(form) {
  const names = pickedServiceNames([...form.querySelectorAll('input[name="service"]:checked')].map((b) => b.value));
  const detailLines = [];
  const pickDetailLines = [];
  for (const name of names) {
    if (!DETAILED_NAMES.has(name)) {
      detailLines.push(name);
      continue;
    }
    const choices = {};
    for (const radio of form.querySelectorAll(`input[type="radio"]:checked`)) {
      const [service, label] = radio.name.split('|');
      if (service === name) choices[label] = radio.value;
    }
    const addOns = [...form.querySelectorAll('input[type="checkbox"]:checked')]
      .filter((b) => b.name === `${name}|addon`)
      .map((b) => b.value);
    const line = describePick(name, choices, addOns);
    detailLines.push(line);
    pickDetailLines.push(line);
  }
  return { names, detailLines, pickDetailLines };
}
