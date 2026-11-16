// Hjälpfunktioner för Lidl-scrapern (testbara utan nätverk).
// Lidl har ingen e-handel för mat; lidl.se visar veckans och nästa veckas sortiment i butik.
import { withMatchKeys } from './normalize.mjs';

export const LIDL_BASE = 'https://www.lidl.se';
export const LIDL_FOOD_CATEGORY = '10068374'; // "Mat & dryck"

// "66,33 kr/kg" -> { value: 66.33, unit: 'kg' }
export function parseBasePrice(text) {
  const m = String(text || '').replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)kr\/(kg|l|st)/i);
  return m ? { value: Number(m[1].replace(',', '.')), unit: m[2].toLowerCase() } : { value: null, unit: null };
}

/** Giltighetsperiod från märkningen "I butik 19/11 - 22/11" */
export function validity(d) {
  const b = d.stockAvailability?.badgeInfoV2?.[0];
  if (!b) return { from: null, until: null, text: null };
  return {
    from: b.validFrom ? b.validFrom * 1000 : null,
    until: b.validUntil ? b.validUntil * 1000 : null,
    text: b.badges?.[0]?.text || null,
  };
}

/** Lidl-vara -> item. now = tidpunkt för hämtningen (ms). Varor som börjar gälla senare hoppas över. */
export function toLidlItem(d, now = Date.now()) {
  const v = validity(d);
  if (v.from && v.from > now) return null;   // gäller först längre fram
  if (v.until && v.until < now) return null; // har redan gått ut

  const p = d.price || {};
  const lp = (d.lidlPlus || [])[0]?.price;
  const base = parseBasePrice((p.basePrice || lp?.basePrice || {}).text);

  let price = p.price ?? null;
  let promo = null;
  const texts = [];
  if (p.oldPrice && p.price && p.oldPrice > p.price) {
    price = p.oldPrice;            // ordinarie pris
    promo = p.price;               // erbjudandepris
    if (p.discount?.percentageDiscount) texts.push(`-${p.discount.percentageDiscount}%`);
  }
  if (lp?.price != null) {
    if (price == null) price = null; // ordinarie pris saknas när bara Lidl Plus-pris visas
    promo = promo == null ? lp.price : Math.min(promo, lp.price);
    texts.push((d.lidlPlus[0].lidlPlusText || 'Med Lidl Plus') + (d.lidlPlus[0].highlightText ? ` ${d.lidlPlus[0].highlightText}` : ''));
  }
  if (v.text) texts.push(v.text);

  const category = (d.keyfacts?.wonCategoryPrimary || '').split('/').slice(-2, -1)[0] || null;
  const brand = d.brand?.name && d.brand.name !== '-' ? d.brand.name : null;
  return withMatchKeys({
    sku: String(d.erpNumber || d.productId),
    ean: null,
    name: d.fullTitle,
    brand,
    size: p.packaging?.text || lp?.packaging?.text || null,
    image_url: d.image || null,
    category,
    url: LIDL_BASE + d.canonicalUrl,
    price,
    price_unit: null,
    compare_price: base.value,
    compare_unit: base.unit,
    promo_price: promo,
    promo_text: texts.join(' · ') || null,
    in_stock: true,
  });
}
