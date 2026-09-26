import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function field(name) {
  const m = html.match(new RegExp(`<(input|select|textarea)[^>]*name="${name}"[^>]*>`));
  assert.ok(m, `form field "${name}" exists`);
  return m[0];
}

test('page has every section and form hook', () => {
  for (const id of ['services', 'book', 'hours', 'contact', 'booking-form', 'booking-status']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing id="${id}"`);
  }
});

test('contact links are correct', () => {
  assert.ok(html.includes('href="tel:+17183928899"'));
  assert.ok(html.includes('href="mailto:nailclubspany@gmail.com"'));
  assert.ok(html.includes('https://www.instagram.com/nailclubspany/'));
  // Every Google Maps link opens the salon's own listing (no tracking params).
  const PLACE = 'https://www.google.com/maps/place/The+Nail+Club+%26+Spa/@40.740175,-73.9259104,17z/data=!3m1!4b1!4m6!3m5!1s0x89c25fc3c4560633:0x47fd7d933a673481!8m2!3d40.740171!4d-73.9233355!16s%2Fg%2F11vx486pxy';
  const mapLinks = [...html.matchAll(/href="(https:\/\/www\.google\.com\/maps[^"]*)"/g)].map((m) => m[1]);
  assert.equal(mapLinks.length, 2, 'address link and Get directions button');
  for (const link of mapLinks) assert.equal(link, PLACE);
});

test('required booking fields are required; notes is optional', () => {
  for (const name of ['name', 'phone', 'email', 'date', 'time']) {
    assert.match(field(name), /\srequired/, `${name} should be required`);
  }
  assert.doesNotMatch(field('notes'), /\srequired/);
});

test('all services and bundles are listed', () => {
  for (const s of ['Nails', 'Massage', 'Head Spa', 'Eyelash Extensions', 'Facials', 'Waxing',
                   'Regular Mani + Pedi', '$38']) {
    assert.ok(html.includes(s), `missing "${s}"`);
  }
});

function luminance(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const cssVar = (name) => html.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1];

test('accent text meets WCAG AA (4.5:1) on white and on the soft background', () => {
  assert.ok(contrast(cssVar('accent'), '#ffffff') >= 4.5, `accent on white ${contrast(cssVar('accent'), '#ffffff').toFixed(2)}`);
  assert.ok(contrast(cssVar('accent'), cssVar('soft')) >= 4.5, `accent on soft ${contrast(cssVar('accent'), cssVar('soft')).toFixed(2)}`);
});

test('Send request button keeps 4.5:1 white text at rest and on hover', () => {
  const hover = html.match(/\.book \.btn-primary:hover\s*\{[^}]*background:\s*(#[0-9a-f]{6}|var\(--[a-z-]+\))/i)[1];
  const hoverHex = hover.startsWith('var') ? cssVar(hover.slice(6, -1)) : hover;
  assert.ok(contrast(hoverHex, '#ffffff') >= 4.5, `hover ${contrast(hoverHex, '#ffffff').toFixed(2)}`);
});

test('Contact anchor clears the sticky header', () => {
  assert.match(html, /#contact\s*\{[^}]*scroll-margin-top/);
});

test('Instagram gallery: every photo exists, is described, lazy-loads, and links to Instagram', () => {
  const section = html.match(/<section id="instagram"[\s\S]*?<\/section>/);
  assert.ok(section, 'missing <section id="instagram">');
  const tiles = [...section[0].matchAll(/<a[^>]*href="([^"]+)"[^>]*>\s*<img([^>]*)>/g)];
  assert.ok(tiles.length >= 6, `expected at least 6 photos, got ${tiles.length}`);
  for (const [, href, attrs] of tiles) {
    assert.match(href, /^https:\/\/www\.instagram\.com\/(nailclubspany\/|p\/)/);
    const src = attrs.match(/src="([^"]+)"/)[1];
    assert.ok(existsSync(new URL(`../${src.split("?")[0]}`, import.meta.url)), `missing file ${src}`);
    assert.match(attrs, /alt="[^"]{5,}"/, `${src} needs a description`);
    assert.match(attrs, /loading="lazy"/);
  }
  assert.match(section[0], /Follow @nailclubspany/);
});

test('hours match Yelp (confirmed) and page is mobile-ready', () => {
  assert.ok(!html.includes('UNCONFIRMED'), 'hours are confirmed from Yelp');
  assert.ok(html.includes('<!-- HOURS (source: Yelp, 2026-09-25) -->'));
  const rows = [...html.matchAll(/<tr data-day="(\d)"><td>\w+<\/td><td>([^<]+)<\/td><\/tr>/g)]
    .map(([, day, hours]) => `${day}=${hours}`);
  assert.deepEqual(rows, [
    '1=10:00am – 8:00pm', '2=10:00am – 8:00pm', '3=10:00am – 8:00pm', '4=10:00am – 8:00pm',
    '5=10:00am – 8:00pm', '6=10:00am – 8:00pm', '0=10:00am – 7:00pm',
  ]);
  assert.ok(html.includes('<meta name="viewport"'));
});

test('open/closed status has a live region in the hero and in Hours', () => {
  assert.equal((html.match(/class="open-status"[^>]*aria-live="polite"/g) || []).length, 2);
});

test('logo shows in the header and as the browser tab icon', () => {
  const brand = html.match(/<a class="brand"[\s\S]*?<\/a>/)[0];
  assert.match(brand, /<img[^>]*src="photos\/logo\.png(\?v=\d+)?"[^>]*>/);
  assert.match(brand, /alt=""/, 'logo is decorative next to the visible name');
  assert.match(html, /<link rel="icon" href="photos\/logo\.png(\?v=\d+)?"/);
  assert.ok(existsSync(new URL('../photos/logo.png', import.meta.url)));
});

test('technician dropdown is optional and offers No preference, Mia, Yoyo, Carmela, Lili, Linda', () => {
  const select = html.match(/<select[^>]*name="technician"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'missing technician select');
  assert.doesNotMatch(select[0].split('>')[0], /\srequired/);
  const options = [...select[1].matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)]
    .map(([, value, label]) => `${value ?? label}|${label}`);
  assert.deepEqual(options, ['|No preference', 'Mia|Mia', 'Yoyo|Yoyo', 'Carmela|Carmela', 'Lili|Lili', 'Linda|Linda']);
});

test('booking form has a required email field', () => {
  const email = field('email');
  assert.match(email, /type="email"/);
  assert.match(email, /autocomplete="email"/);
  assert.match(email, /\srequired/);
  assert.ok(html.includes('>Email<input name="email"'), 'label is plain "Email", not "(optional)"');
});

test('hero shows a large logo beside the name', () => {
  const hero = html.match(/<section class="hero">[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<img[^>]*class="hero-logo"[^>]*src="photos\/logo\.png(\?v=\d+)?"[^>]*alt=""/);
  assert.match(html, /\.hero-logo\s*\{[^}]*width:/);
});

test('services are checkboxes, one per service, none individually required', () => {
  const boxes = [...html.matchAll(/<input type="checkbox" name="service" value="([^"]+)"[^>]*>/g)];
  assert.deepEqual(boxes.map((m) => m[1]), [
    'Nails', 'Massage', 'Head Spa', 'Eyelash Extensions', 'Facials', 'Waxing',
    '$38 Bundle: Regular Mani + Pedi', 'Other',
  ]);
  for (const [tag] of boxes) assert.doesNotMatch(tag, /\srequired/);
  assert.doesNotMatch(html, /<select[^>]*name="service"/);
});

test('price list: every category, sample prices, nav link, and the original menus', () => {
  const section = html.match(/<section id="prices"[\s\S]*?<\/section>/);
  assert.ok(section, 'missing <section id="prices">');
  const s = section[0];
  for (const cat of ['Manicure', 'Pedicure', 'Spa Pedicure', 'Waxing', 'Eyelash Extensions', 'Massage', 'Facial']) {
    assert.match(s, new RegExp(`<summary>${cat}</summary>`), `missing category ${cat}`);
  }
  for (const [item, price] of [
    ['Manicure', '$15'], ['Gel-X Extension', '$70'], ['UV Gel French', '+$15'], ['Gel Pedi', '$45'],
    ['Gold Mystique', '$80'], ['Bikini', '$25'], ['Signature Deep Clean Facial', '$85'],
  ]) {
    assert.ok(s.includes(`<span>${item}</span><b>${price}</b>`), `${item} ${price}`);
  }
  assert.match(s, /Dramatic \(120 pieces\)<\/th><td>\$140<\/td><td>\$95<\/td><td>\$105<\/td><td>\$120<\/td>/);
  assert.match(s, /Swedish<\/span><b>30 min \$45 · 60 min \$80<\/b>/);
  assert.ok(html.includes('<a href="#prices"'), 'nav links to prices');
  // Prices sit between Services and the Instagram gallery.
  assert.ok(html.indexOf('id="services"') < html.indexOf('id="prices"'));
  assert.ok(html.indexOf('id="prices"') < html.indexOf('id="instagram"'));
  for (const n of [1, 2, 3]) {
    assert.ok(s.includes(`href="photos/menu-${n}.png"`), `link to menu-${n}`);
    assert.ok(existsSync(new URL(`../photos/menu-${n}.png`, import.meta.url)), `missing photos/menu-${n}.png`);
  }
});
