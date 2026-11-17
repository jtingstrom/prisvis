import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcaOffer, toIcaItem, foodLeaves, parseState, productsFromState } from './ica-lib.mjs';

const sample = JSON.parse(readFileSync(new URL('./fixtures/ica-sample.json', import.meta.url)));

test('kampanjtexter', () => {
  assert.equal(parseIcaOffer('4 för 55 kr -- Max 1 erbj/hushåll', 22.66), 13.75);
  assert.equal(parseIcaOffer('2 för 35 kr', 23.57), 17.5);
  assert.equal(parseIcaOffer('29,90 kr/kg', 52.9), 29.9);
  assert.equal(parseIcaOffer('Spara 10 kr', 49.9), 39.9);
  assert.equal(parseIcaOffer('Stammispris', 10), null);
  assert.equal(parseIcaOffer(null, 10), null);
});

test('ICA-vara till item', () => {
  const i = toIcaItem(sample[0], '1003417');
  assert.equal(i.sku, '1487131');
  assert.equal(i.price, 22.66);
  assert.equal(i.promo_price, 13.75);
  assert.equal(i.promo_text, '4 för 55 kr · Max 1 erbj/hushåll');
  assert.equal(i.compare_unit, 'l');
  assert.equal(i.size_norm, '1000ml');
  assert.equal(i.brand_norm, 'oatly');
  assert.equal(i.name_norm, 'havredryck ikaffe 3%');
  assert.equal(i.url, 'https://handlaprivatkund.ica.se/stores/1003417/products/x/1487131');
});

test('vara utan kampanj', () => {
  const i = toIcaItem(sample[3], '1003417');
  assert.equal(i.promo_price, null);
  assert.equal(i.name_norm, 'färsk mellanmjölk 1.5%');
  assert.equal(i.size_norm, '1500ml');
});

test('bladkategorier hoppar över icke-livsmedel', () => {
  const tree = [
    { name: 'Mejeri & Ost', childCategories: [{ name: 'Mjölk', categoryId: 'a', productCount: 10, childCategories: [] }] },
    { name: 'Skönhet', childCategories: [{ name: 'Tvål', categoryId: 'b', productCount: 5, childCategories: [] }] },
  ];
  assert.deepEqual(foodLeaves(tree).map((l) => l.id), ['a']);
});

test('läser state ur html', () => {
  const html = `<html><script>window.__INITIAL_STATE__={"data":{"products":{"productEntities":{"x":{"name":"A"}},"catalogue":{"data":{"totalProducts":"1"}}}}}</script></html>`;
  const { entities, total } = productsFromState(parseState(html));
  assert.equal(entities[0].name, 'A');
  assert.equal(total, 1);
});

import { extractJsonArray, offersToItems } from './ica-lib.mjs';

test('erbjudandesida: plockar ut weeklyOffers utan att köra sidans kod', () => {
  const html = readFileSync(new URL('./fixtures/ica-offers-page.html', import.meta.url), 'utf8');
  const offers = extractJsonArray(html, 'weeklyOffers');
  assert.equal(offers.length, 2);
  const items = offersToItems(offers, 'https://www.ica.se/erbjudanden/x-1051007/');
  assert.equal(items.length, 3); // en per streckkod
  const citrus = items[0];
  assert.equal(citrus.ean, '7318690132301');
  assert.equal(citrus.price, 30.9);
  assert.equal(citrus.promo_price, 20);
  assert.equal(citrus.brand, 'ICA');
  assert.match(citrus.promo_text, /20 kr\/st · Stammispris · t\.o\.m\. 22\/11/);
  const fil = items[1];
  assert.equal(fil.price, null);        // ordinarie pris är ett intervall
  assert.equal(fil.promo_price, 20);    // 2 för 40 kr
  assert.equal(fil.name, 'Fil Hall/Pass 3.5%');
});

import { offerSlugCandidates } from './ica-lib.mjs';
test('adresser till erbjudandesidan', () => {
  assert.deepEqual(offerSlugCandidates('Maxi ICA Stormarknad Högsbo, Göteborg', '1003954'),
    ['maxi-ica-stormarknad-hogsbo-goteborg-1003954', 'maxi-ica-stormarknad-hogsbo-1003954']);
  assert.deepEqual(offerSlugCandidates('ICA Kvantum Mölndal', '1004589'), ['ica-kvantum-molndal-1004589']);
});
