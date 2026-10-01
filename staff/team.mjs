// Staff view: provider list (add, rename, active toggle, reorder) and each
// provider's skills (which service categories they cover). "Skills" are the
// services rows where requires = name (own-name categories like Nails,
// Massage, ... — not a bundle like "$38 Bundle: Regular Mani + Pedi", whose
// requires points at a different category, and not "Other", whose requires
// is null). Appointments reference staff, so providers are never deleted
// here — only deactivated (staff.active).
//
// Pure helper `reorder` has no DOM/network and is imported directly by node
// tests (see task 7 fix-round-1: staff.sort has no unique constraint, so a
// partial write failure from a naive two-row swap can leave two rows with
// the same sort, wedging the order). mount/unmount own the live Supabase
// reads/writes; those are only exercised manually (a Supabase project is
// required; see the task report).
//
// Must never import app.mjs or the supabase-js CDN — that's what keeps
// other view modules' pure helpers importable by plain `node --test`.
import { createLoadSequencer } from './calendar.mjs';
import { say, sayBriefly, t, fieldMessage } from './i18n.mjs';
import { inlineErrors, showError, clearError } from '../js/inline-errors.mjs';

const LOAD_ERROR_COPY = "Couldn't load the team — check the connection and try again.";
const SAVE_ERROR_COPY = 'Could not save — try again.';

// --- Pure helpers ------------------------------------------------------

// Returns `list`'s ids in the order that results from moving the item at
// `index` one place in `direction` (-1 = up/earlier, 1 = down/later). A move
// past either end (top item up, bottom item down) is a no-op — the ids come
// back unchanged. This only computes the new *order*; the caller renumbers
// sort = 1..n from it (see persistReorder) rather than swapping two sort
// values directly, so the write is idempotent and self-healing: run it again
// from any state (including one left mid-swap by a partial failure, however
// it broke) and it converges on the same consecutive 1..n ordering.
export function reorder(list, index, direction) {
  const ids = list.map((s) => s.id);
  const otherIndex = index + direction;
  if (otherIndex < 0 || otherIndex >= ids.length) return ids;
  [ids[index], ids[otherIndex]] = [ids[otherIndex], ids[index]];
  return ids;
}

let state = null; // { supabase, show, onAvailabilityChanged } (only show/supabase used here)
let container = null;
let listHost = null;
let addForm = null;
let status = null;

let staffList = [];
let skillNames = [];
let staffServices = []; // [{staff_id, service}]
// Id of the provider just renamed: the reload that follows rebuilds the
// list, so the 'Saved.' confirmation is shown by renderItem instead.
let savedId = null;

const seqr = createLoadSequencer();

function skillsFor(staffId) {
  return new Set(staffServices.filter((r) => r.staff_id === staffId).map((r) => r.service));
}

function setStatus(text) {
  if (status) say(status, text);
}

async function loadAll() {
  const [staffRes, servicesRes, staffServicesRes] = await Promise.all([
    // Ordered by sort then id: a stable tie-break so that if drift ever
    // leaves two rows sharing a sort value (see reorder() above), the list
    // — and so reorder()'s renumbering — is still deterministic rather than
    // depending on unspecified row order from the database.
    state.supabase.from('staff').select('id,name,active,sort').order('sort', { ascending: true }).order('id', { ascending: true }),
    state.supabase.from('services').select('name,requires'),
    state.supabase.from('staff_services').select('staff_id,service'),
  ]);
  const error = staffRes.error || servicesRes.error || staffServicesRes.error || null;
  return {
    staff: staffRes.data ?? [],
    services: servicesRes.data ?? [],
    staffServices: staffServicesRes.data ?? [],
    error,
  };
}

async function reload() {
  const seq = seqr.bump();
  if (!container) return;
  const { staff, services, staffServices: rows, error } = await loadAll();
  if (!seqr.isCurrent(seq) || !container) return;
  if (error) {
    savedId = null;
    setStatus(LOAD_ERROR_COPY);
    return;
  }
  staffList = staff;
  skillNames = services.filter((s) => s.requires === s.name).map((s) => s.name);
  staffServices = rows;
  render();
}

function renameField(person) {
  const wrap = document.createElement('div');
  wrap.className = 'team-name-field';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'team-name-input';
  nameInput.value = person.name;
  nameInput.required = true;
  // Not in a form, so clear its "fill this in" message here.
  nameInput.addEventListener('input', () => clearError(nameInput));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn team-rename-btn';
  say(saveBtn, 'Save');

  const itemStatus = document.createElement('p');
  itemStatus.className = 'team-item-status';
  itemStatus.setAttribute('role', 'alert');

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showError(nameInput, t('Please fill this in.'));
      return;
    }
    if (name === person.name) {
      sayBriefly(itemStatus, 'Saved.');
      return;
    }
    saveBtn.disabled = true;
    itemStatus.textContent = '';
    const { error } = await state.supabase.from('staff').update({ name }).eq('id', person.id);
    saveBtn.disabled = false;
    if (error) {
      say(itemStatus, SAVE_ERROR_COPY);
      nameInput.value = person.name;
      return;
    }
    savedId = person.id;
    await reload();
  });

  wrap.append(nameInput, saveBtn);
  return { wrap, itemStatus };
}

function activeToggle(person, itemStatus) {
  const label = document.createElement('label');
  label.className = 'team-active-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = person.active;
  const span = document.createElement('span');
  say(span, 'Active');
  label.append(box, span);

  box.addEventListener('change', async () => {
    const next = box.checked;
    box.disabled = true;
    itemStatus.textContent = '';
    const { error } = await state.supabase.from('staff').update({ active: next }).eq('id', person.id);
    box.disabled = false;
    if (error) {
      box.checked = !next;
      say(itemStatus, SAVE_ERROR_COPY);
      return;
    }
    await reload();
  });

  return label;
}

// Persists a reordering: renumbers sort = 1..n from `newOrderIds`'s
// position, writing only the rows whose sort actually needs to change.
// Because this always recomputes the *whole* ordering from scratch (rather
// than swapping two values), it's safe to call again after a prior partial
// failure — whatever state the DB was left in, this converges it to the
// same consecutive 1..n ordering in one more pass, and a click that finds
// nothing out of place writes nothing.
async function persistReorder(newOrderIds, itemStatus) {
  const currentSortById = new Map(staffList.map((s) => [s.id, s.sort]));
  const updates = newOrderIds
    .map((id, i) => ({ id, sort: i + 1 }))
    .filter(({ id, sort }) => currentSortById.get(id) !== sort);
  if (updates.length === 0) return;

  itemStatus.textContent = '';
  const results = await Promise.all(
    updates.map(({ id, sort }) => state.supabase.from('staff').update({ sort }).eq('id', id))
  );
  if (results.some((r) => r.error)) {
    say(itemStatus, SAVE_ERROR_COPY);
  }
  await reload();
}

function reorderButtons(person, index, itemStatus) {
  const wrap = document.createElement('div');
  wrap.className = 'reorder-buttons';

  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'btn reorder-btn';
  upBtn.textContent = '↑';
  upBtn.setAttribute('aria-label', `Move ${person.name} up`);
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => persistReorder(reorder(staffList, index, -1), itemStatus));

  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'btn reorder-btn';
  downBtn.textContent = '↓';
  downBtn.setAttribute('aria-label', `Move ${person.name} down`);
  downBtn.disabled = index === staffList.length - 1;
  downBtn.addEventListener('click', () => persistReorder(reorder(staffList, index, 1), itemStatus));

  wrap.append(upBtn, downBtn);
  return wrap;
}

function skillChecks(person, itemStatus) {
  const wrap = document.createElement('div');
  wrap.className = 'service-checks team-skills';
  const has = skillsFor(person.id);

  for (const skill of skillNames) {
    const label = document.createElement('label');
    label.className = 'service-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = has.has(skill);
    const span = document.createElement('span');
    span.textContent = skill;
    label.append(box, span);

    box.addEventListener('change', async () => {
      const checked = box.checked;
      box.disabled = true;
      itemStatus.textContent = '';
      const { error } = checked
        ? await state.supabase.from('staff_services').insert({ staff_id: person.id, service: skill })
        : await state.supabase.from('staff_services').delete().eq('staff_id', person.id).eq('service', skill);
      box.disabled = false;
      if (error) {
        box.checked = !checked;
        say(itemStatus, SAVE_ERROR_COPY);
        return;
      }
      await reload();
    });

    wrap.appendChild(label);
  }

  return wrap;
}

function renderItem(person, index) {
  const item = document.createElement('article');
  item.className = 'team-item';

  const row = document.createElement('div');
  row.className = 'team-item-row';

  const { wrap: nameWrap, itemStatus } = renameField(person);
  row.append(reorderButtons(person, index, itemStatus), nameWrap, activeToggle(person, itemStatus));

  item.append(row, skillChecks(person, itemStatus), itemStatus);
  if (person.id === savedId) {
    savedId = null;
    sayBriefly(itemStatus, 'Saved.');
  }
  return item;
}

function render() {
  if (!listHost) return;
  listHost.replaceChildren();
  if (staffList.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    say(empty, 'No providers yet.');
    listHost.appendChild(empty);
    return;
  }
  for (const [index, person] of staffList.entries()) {
    listHost.appendChild(renderItem(person, index));
  }
}

function buildAddForm() {
  const form = document.createElement('form');
  form.className = 'team-add-form';
  inlineErrors(form, fieldMessage);

  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  say(span, 'New provider name');
  const input = document.createElement('input');
  input.type = 'text';
  input.required = true;
  label.append(span, input);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  say(submitBtn, 'Add provider');

  form.append(label, submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    submitBtn.disabled = true;
    setStatus('');
    const nextSort = staffList.reduce((max, s) => Math.max(max, s.sort), 0) + 1;
    const { error } = await state.supabase.from('staff').insert({ name, active: true, sort: nextSort });
    submitBtn.disabled = false;
    if (error) {
      setStatus(SAVE_ERROR_COPY);
      return;
    }
    form.reset();
    await reload();
  });

  return form;
}

function mount(root, ctx) {
  seqr.bump();
  state = ctx;
  staffList = [];
  skillNames = [];
  staffServices = [];
  savedId = null;

  container = document.createElement('div');
  container.className = 'team-view';

  const h2 = document.createElement('h2');
  say(h2, 'Providers');

  listHost = document.createElement('div');
  listHost.className = 'team-list';

  addForm = buildAddForm();

  status = document.createElement('p');
  status.className = 'team-status';
  status.setAttribute('role', 'alert');

  container.append(h2, listHost, addForm, status);
  root.replaceChildren(container);

  reload();
}

function unmount() {
  seqr.bump();
  container = null;
  listHost = null;
  addForm = null;
  status = null;
  state = null;
}

export default { mount, unmount };
