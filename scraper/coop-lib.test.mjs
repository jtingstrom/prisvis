import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCoopItem, bestPromotion, storeContextCookie, compareUnit } from './coop-lib.mjs';

const [plain, multi, member] = JSON.parse(readFileSync(new URL('./fixtures/coop-sample.json', import.meta.url)));
const NOV_18 = Date.UTC(2026, 10, 18, 12);

test('butikscookie', () => {
  const v = JSON.parse(Buffer.from(decodeURIComponent(storeContextCookie(255500)), 'base64').toString());
  assert.deepEqual(v, { productionUnitId: '255500', pickupPointId: null, storeName: null });
});

test('vara utan kampanj', () => {
  const i = toCoopItem(plain, NOV_18);
  assert.equal(i.ean, '7300156585004');
  assert.equal(i.price, 7.95);
  assert.equal(i.compare_price, 26.5);
  assert.equal(i.compare_unit, 'l');
  assert.equal(i.size_norm, '300ml');
  assert.equal(i.category, 'Mejeri & Ägg');
  assert.equal(i.promo_price, null);
  assert.equal(i.image_url, 'https://res.cloudinary.com/coopsverige/image/upload/v1728387593/cloud/392409.jpg');
});

test('flerköp räknas om till styckpris, inget slutdatum för långa kampanjer', () => {
  const i = toCoopItem(multi, NOV_18);
  assert.equal(i.promo_price, 14);
  assert.equal(i.promo_text, '2 för 28 kr');
});

test('medlemspris med slutdatum', () => {
  const i = toCoopItem(member, NOV_18);
  assert.equal(i.promo_price, 45);
  assert.equal(i.promo_text, '45 kr · Medlemspris · t.o.m. 22/11');
});

test('kampanj som inte börjat gäller inte', () => {
  assert.equal(bestPromotion(member, Date.UTC(2026, 10, 10)).promo_price, null);
});

test('jämförprisenhet i olika format, och viktvaror', () => {
  assert.equal(compareUnit({ comparativePriceUnit: { unit: 'Kilogram' } }), 'kg');
  assert.equal(compareUnit({ comparativePriceText: 'kr/kg' }), 'kg');
  assert.equal(compareUnit({ comparativePriceUnit: { unit: 'liter', text: 'kr/lit' } }), 'l');
  assert.equal(compareUnit({ comparativePriceUnit: { text: 'kr/st' } }), 'st');
  const apple = toCoopItem({ id: '1', name: 'Äpple', salesUnit: 'Vikt', salesPriceData: { b2cPrice: 34.9 }, comparativePriceUnit: { unit: 'kg', text: 'kr/kg' }, comparativePriceData: { b2cPrice: 34.9 } }, NOV_18);
  assert.equal(apple.price_unit, 'kr/kg');
  assert.equal(apple.compare_unit, 'kg');
});
