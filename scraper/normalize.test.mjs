import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSize, normalizeBrand, normalizeName, withMatchKeys } from './normalize.mjs';

test('storlekar', () => {
  assert.equal(normalizeSize('1l'), '1000ml');
  assert.equal(normalizeSize('1.5L'), '1500ml');
  assert.equal(normalizeSize('1,5l'), '1500ml');
  assert.equal(normalizeSize('3dl'), '300ml');
  assert.equal(normalizeSize('0.15kg'), '150g');
  assert.equal(normalizeSize('ca: 750g'), '750g');
  assert.equal(normalizeSize('6x33cl'), '6x330ml');
  assert.equal(normalizeSize('10-p'), '10st');
  assert.equal(normalizeSize('Gul lök 500g Klass 1 ICA'), '500g');
  assert.equal(normalizeSize('Mellanmjölk 1,5%'), null); // procent är inte storlek
});

test('varumärken', () => {
  assert.equal(normalizeBrand('Arla Ko®'), 'arla ko');
  assert.equal(normalizeBrand(' ICA '), 'ica');
  assert.equal(normalizeBrand(null), null);
});

test('namn utan varumärke och storlek', () => {
  assert.equal(normalizeName('Färsk mellanmjölk 1,5% 1,5l Arla Ko®', 'Arla Ko'), 'färsk mellanmjölk 1.5%');
  assert.equal(normalizeName('Mellanmjölk Färsk 1,5%', 'Arla Ko'), 'mellanmjölk färsk 1.5%');
  assert.equal(normalizeName('Havredryck iKaffe 3% 1l Oatly', 'Oatly'), 'havredryck ikaffe 3%');
});

test('ICA och Willys får samma nycklar för samma vara', () => {
  const ica = withMatchKeys({ name: 'Färsk mellanmjölk 1,5% 1,5l Arla Ko®', brand: 'Arla Ko', size: '1.5L' });
  const willys = withMatchKeys({ name: 'Mellanmjölk Färsk 1,5%', brand: 'Arla Ko', size: '1,5l' });
  assert.equal(ica.brand_norm, willys.brand_norm);
  assert.equal(ica.size_norm, willys.size_norm);
});
