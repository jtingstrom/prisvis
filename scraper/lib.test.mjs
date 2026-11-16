// Kör: node --test scraper/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKr, eanFromImage, toItem } from './lib.mjs';

const sample = JSON.parse(readFileSync(new URL('./fixtures/willys-sample.json', import.meta.url)));
const base = 'https://www.willys.se';

test('parseKr', () => {
  assert.equal(parseKr('11,90 kr'), 11.9);
  assert.equal(parseKr('1 049,00 kr'), 1049);
  assert.equal(parseKr(''), null);
});

test('EAN från bildlänk, viktvaror utan EAN', () => {
  assert.equal(eanFromImage(sample[0].image.url), '7340045504167');
  assert.equal(eanFromImage(sample[1].image.url), null); // 02... = viktvara
});

test('styckpriskampanj', () => {
  const i = toItem(sample[0], 'Kött', base);
  assert.equal(i.price, 78.9);
  assert.equal(i.promo_price, 69.9);
  assert.equal(i.compare_price, 157.8);
  assert.equal(i.url, 'https://www.willys.se/produkt/101106287_ST');
});

test('kilopriskampanj', () => {
  assert.equal(toItem(sample[1], 'Kött', base).promo_price, 29.9);
});

test('flerköp räknas om till styckpris', () => {
  const i = toItem(sample[2], 'Kött', base);
  assert.equal(i.promo_price, 44.5);
  assert.match(i.promo_text, /2 för 89,00 kr/);
});

test('utan kampanj', () => {
  const i = toItem(sample[3], 'Kött', base);
  assert.equal(i.promo_price, null);
  assert.equal(i.promo_text, null);
  assert.equal(i.in_stock, true);
});
