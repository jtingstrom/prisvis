// Hjälpfunktioner för Axfood-scrapern (testbara utan nätverk)
import { withMatchKeys } from './normalize.mjs';

// "11,90 kr" -> 11.9
export function parseKr(s) {
  if (s == null || s === '') return null;
  const m = String(s).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// EAN ligger i bildens filnamn: .../07393061001462_C1L1_s02 (GTIN-14)
export function eanFromImage(url) {
  const m = url && url.match(/\/(\d{14})_/);
  if (!m) return null;
  const ean = m[1].replace(/^0/, '');
  // Prefix 2 = butiksinterna koder/viktvaror, inte globalt unika
  if (ean.startsWith('2')) return null;
  return ean;
}

export function promoFrom(p) {
  const promo = (p.potentialPromotions || [])[0];
  if (!promo) return { promo_price: null, promo_text: null };
  // Styckpris: rewardLabel "69,90/st" eller "29,90/kg".
  // Flerköp: conditionLabel "2 för", rewardLabel "89,00" -> 44,50 per st.
  const qualifying = promo.qualifyingCount || 1;
  const reward = promo.rewardLabel || '';
  const value = parseKr(reward);
  let price = null;
  let text;
  if (/\/(st|kg)/.test(reward)) {
    price = value;
    text = [promo.conditionLabel, reward, promo.redeemLimitLabel];
  } else if (qualifying > 1 && value) {
    price = Math.round((value / qualifying) * 100) / 100;
    text = [`${qualifying} för ${reward} kr`, promo.redeemLimitLabel];
  } else {
    text = [promo.conditionLabel, reward, promo.redeemLimitLabel];
  }
  text = text.filter(Boolean).join(' · ');
  return { promo_price: price, promo_text: text || null };
}

export function toItem(p, category, base) {
  const { promo_price, promo_text } = promoFrom(p);
  return withMatchKeys({
    sku: p.code,
    ean: eanFromImage(p.image?.url),
    name: p.name,
    brand: p.manufacturer || null,
    size: p.displayVolume || null,
    image_url: p.image?.url || null,
    category,
    url: `${base}/produkt/${encodeURIComponent(p.code)}`,
    price: p.priceValue ?? parseKr(p.price),
    price_unit: p.priceUnit || null,
    compare_price: parseKr(p.comparePrice),
    compare_unit: p.comparePriceUnit || null,
    promo_price,
    promo_text,
    in_stock: !p.outOfStock,
  });
}

