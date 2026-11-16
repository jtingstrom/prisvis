import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toLidlItem, parseBasePrice } from './lidl-lib.mjs';

const [regular, discounted, lidlPlus] = JSON.parse(readFileSync(new URL('./fixtures/lidl-sample.json', import.meta.url)));
const NOV_20 = Date.UTC(2026, 10, 20, 12);

test('jämförpris', () => {
  assert.deepEqual(parseBasePrice('66,33 kr/kg'), { value: 66.33, unit: 'kg' });
  assert.deepEqual(parseBasePrice('13,04 kr/l'), { value: 13.04, unit: 'l' });
});

test('vanlig vara', () => {
  const i = toLidlItem(regular, NOV_20);
  assert.equal(i.price, 19.9);
  assert.equal(i.promo_price, null);
  assert.equal(i.compare_price, 66.33);
  assert.equal(i.size_norm, '300g');
  assert.equal(i.url, 'https://www.lidl.se/p/favorina-mandelkex-med-pepparkakssmak/p11000056');
  assert.equal(i.category, 'Godis & snacks');
});

test('rabatt: ordinarie pris och erbjudandepris', () => {
  const i = toLidlItem(discounted, NOV_20);
  assert.equal(i.price, 78);
  assert.equal(i.promo_price, 49);
  assert.match(i.promo_text, /-37% · I butik 19\/11 - 22\/11/);
});

test('varor som gäller först senare hoppas över', () => {
  assert.equal(toLidlItem(lidlPlus, NOV_20), null);
  const later = toLidlItem(lidlPlus, Date.UTC(2026, 10, 26, 12));
  assert.equal(later.promo_price, 24.9);
  assert.match(later.promo_text, /Med Lidl Plus -16%/);
});

test('utgångna varor hoppas över', () => {
  assert.equal(toLidlItem(regular, Date.UTC(2026, 11, 1)), null);
});
