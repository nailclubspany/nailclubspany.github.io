// Renders the detailed services from js/services.mjs into the public booking
// form (nail services into #nail-services, Massage into #spa-services) and
// reads back what the customer picked.
//
// Each service is a normal `name="service"` checkbox, so the rest of
// js/booking.mjs treats it like any other service (availability, the RPC's
// p_services). Under it sits a details panel with the service's required
// choices (radio pills) and optional add-ons. The panel is a <fieldset> that
// is `disabled` as well as `hidden` while the service is unticked: disabled
// controls are skipped by form validation, so an abandoned service's
// unanswered choices never block a submit.
import { NAIL_SERVICES, SPA_SERVICES, describePick } from './services.mjs';

const DETAILED_NAMES = new Set([...NAIL_SERVICES, ...SPA_SERVICES].map((s) => s.name));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setOpen(item, open) {
  const panel = item.querySelector('.nail-details');
  if (!panel) return;
  panel.disabled = !open;
  panel.hidden = !open;
  item.classList.toggle('open', open);
  if (!open) {
    for (const error of panel.querySelectorAll('.choice-error')) error.hidden = true;
    for (const group of panel.querySelectorAll('.choice.missing')) group.classList.remove('missing');
  }
}

function buildItem(service) {
  const box = el('input', { type: 'checkbox', name: 'service', value: service.name });
  const item = el('div', { className: 'nail-item' }, el('label', {}, box, ` ${service.name}`));
  if (!service.choices.length && !service.addOns.length) return item;

  const panel = el('fieldset', { className: 'nail-details', disabled: true, hidden: true });
  for (const choice of service.choices) {
    const pills = el('div', { className: 'pills' });
    // The radios are invisible behind the pills, so the browser's own
    // "please select" bubble is easy to miss; say it under the group instead.
    const error = el('p', { className: 'choice-error', textContent: 'Please choose one.', hidden: true });
    const group = el('fieldset', { className: 'choice' }, el('legend', { className: 'choice-label', textContent: choice.label }), pills, error);
    choice.options.forEach((option, i) => {
      // `required` on one radio makes the whole same-name group required.
      const radio = el('input', { type: 'radio', name: `${service.name}|${choice.label}`, value: option, required: i === 0 });
      radio.addEventListener('invalid', () => { error.hidden = false; group.classList.add('missing'); });
      radio.addEventListener('change', () => { error.hidden = true; group.classList.remove('missing'); });
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
  item.append(panel);
  box.addEventListener('change', () => setOpen(item, box.checked));
  return item;
}

export function renderNailPicker(host, services = NAIL_SERVICES) {
  const items = services.map(buildItem);
  host.append(...items);
  // form.reset() unticks the boxes without firing `change`, so collapse the
  // panels to match — after the reset has actually happened.
  host.closest('form')?.addEventListener('reset', () => {
    setTimeout(() => items.forEach((item) => setOpen(item, false)), 0);
  });
}

// What the customer picked: `names` for the RPC and staff matching, and
// `detailLines` (one per service, with its choices and add-ons) for staff.
// `pickDetailLines` is the detailed-service subset (nails, Massage) — the
// lines that add something beyond the bare service names already stored with
// the appointment.
export function serviceSummary(form) {
  const names = [...form.querySelectorAll('input[name="service"]:checked')].map((b) => b.value);
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
