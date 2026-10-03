import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAIL_SERVICES, SPA_SERVICES, NAIL_GROUP, pickedServiceNames, describePick, bookingNotes } from '../js/services.mjs';

test('catalog names match the migration', () => {
  assert.deepEqual(NAIL_SERVICES.map((s) => s.name), [
    'Manicure', 'Pedicure', 'Gel Manicure', 'Gel Pedicure', 'SNS Powder', 'Gel X',
    'UV Gel/Hard Gel', 'Spa Pedicure', 'Buff & Shine Manicure', 'Buff & Shine Pedicure',
    'Polish Change',
  ]);
});

test('gel/extension services require design; UV Gel/Hard Gel also set and length', () => {
  const labels = (name) => NAIL_SERVICES.find((s) => s.name === name).choices.map((c) => c.label);
  assert.deepEqual(labels('Gel Manicure'), ['Design']);
  assert.deepEqual(labels('SNS Powder'), ['Design', 'Length']);
  assert.deepEqual(labels('Gel X'), ['New set or fill', 'Design']);
  assert.deepEqual(labels('UV Gel/Hard Gel'), ['New set or fill', 'Design', 'Length']);
  assert.deepEqual(labels('Spa Pedicure'), ['Spa type', 'Polish', 'Design']);
  assert.deepEqual(labels('Polish Change'), ['Polish']);
  assert.deepEqual(labels('Manicure'), []);
});

test('add-ons follow the menu: callus removal only on feet, spa pedicure paraffin only', () => {
  const addOns = (name) => NAIL_SERVICES.find((s) => s.name === name).addOns;
  assert.deepEqual(addOns('Manicure'), ['Massage', 'Paraffin']);
  assert.deepEqual(addOns('Pedicure'), ['Callus Removal', 'Massage', 'Paraffin']);
  assert.deepEqual(addOns('Gel Pedicure'), ['Callus Removal', 'Massage', 'Paraffin']);
  assert.deepEqual(addOns('Buff & Shine Pedicure'), ['Callus Removal', 'Massage', 'Paraffin']);
  assert.deepEqual(addOns('Spa Pedicure'), ['Paraffin']);
});

test('describePick formats choices and add-ons', () => {
  assert.equal(
    describePick('Gel X', { 'New set or fill': 'Fill', Design: 'Chrome' }, ['Paraffin']),
    'Gel X: Fill, Chrome + Paraffin'
  );
  assert.equal(describePick('Manicure', {}, ['Massage']), 'Manicure + Massage');
  assert.equal(describePick('Manicure', {}, []), 'Manicure');
  // Choice values come out in catalog order, whatever order they were given in.
  assert.equal(
    describePick('UV Gel/Hard Gel', { Length: 'Extension tips', Design: 'French', 'New set or fill': 'New set' }, []),
    'UV Gel/Hard Gel: New set, French, Extension tips'
  );
});

test('Massage asks for type and duration, with no add-ons', () => {
  const massage = SPA_SERVICES.find((s) => s.name === 'Massage');
  assert.deepEqual(massage.choices.map((c) => [c.label, c.options]), [
    ['Massage type', ['Foot', 'Chair', 'Bed']],
    ['Duration', ['10 min', '15 min', '30 min', '45 min', '60 min']],
  ]);
  assert.deepEqual(massage.addOns, []);
  assert.equal(describePick('Massage', { Duration: '30 min', 'Massage type': 'Bed' }, []), 'Massage: Bed, 30 min');
});

test('bookingNotes puts details first', () => {
  assert.equal(bookingNotes(['A', 'B'], 'hi'), 'A\nB\n\nhi');
  assert.equal(bookingNotes(['A'], ''), 'A');
  assert.equal(bookingNotes([], 'hi'), 'hi');
  assert.equal(bookingNotes([], ''), '');
});

test('bookingNotes caps at 1000 chars', () => {
  const lines = Array.from({ length: 10 }, () => 'x'.repeat(90));
  assert.equal(bookingNotes(lines, 'y'.repeat(600)).length, 1000);
});

test('every choice is optional, Massage duration included', () => {
  const required = [...NAIL_SERVICES, ...SPA_SERVICES].flatMap((s) =>
    s.choices.filter((c) => c.required).map((c) => `${s.name}|${c.label}`));
  assert.deepEqual(required, []);
});

test('describePick leaves out choices the customer skipped', () => {
  assert.equal(describePick('Spa Pedicure', {}, []), 'Spa Pedicure');
  assert.equal(describePick('UV Gel/Hard Gel', { Length: 'Extension tips' }, ['Paraffin']), 'UV Gel/Hard Gel: Extension tips + Paraffin');
});

// --- the Nails group ---------------------------------------------------------

test('Nails on its own is sent as the general Nails service', () => {
  assert.equal(NAIL_GROUP, 'Nails');
  assert.deepEqual(pickedServiceNames(['Nails']), ['Nails']);
  assert.deepEqual(pickedServiceNames(['Nails', 'Waxing']), ['Nails', 'Waxing']);
  assert.equal(describePick('Nails', {}, []), 'Nails');
});

test('picking specific nail services replaces the general Nails entry', () => {
  assert.deepEqual(pickedServiceNames(['Nails', 'Gel X', 'Pedicure', 'Massage']), ['Gel X', 'Pedicure', 'Massage']);
  // The $38 bundle and Massage are not nail-group services, so Nails stays.
  assert.deepEqual(pickedServiceNames(['Nails', 'Massage', '$38 Bundle: Regular Mani + Pedi']), ['Nails', 'Massage', '$38 Bundle: Regular Mani + Pedi']);
  assert.deepEqual(pickedServiceNames([]), []);
});