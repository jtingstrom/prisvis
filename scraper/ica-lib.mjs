// Hjälpfunktioner för ICA-scrapern (testbara utan nätverk)
import { withMatchKeys } from './normalize.mjs';

export const ICA_BASE = 'https://handlaprivatkund.ica.se';

// Toppkategorier som inte är livsmedel
export const ICA_SKIP_TOP = new Set([
  'Skönhet', 'Träning & Hälsa', 'Apotek', 'Djur', 'Städ, Tvätt & Papper', 'Kök',
  'Hem & Inredning', 'Fritid', 'Blommor & Trädgård', 'Kläder & Accessoarer', 'Tobak',
]);

/** Plockar ut window.__INITIAL_STATE__ ur en ICA-sida */
export function parseState(html) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

/** Varorna (med detaljer) på en kategorisida */
export function productsFromState(state) {
  const p = state?.data?.products;
  if (!p?.productEntities) return { entities: [], total: 0 };
  const total = Number(p.catalogue?.data?.totalProducts) || 0;
  return { entities: Object.values(p.productEntities), total };
}

/** Bladkategorier (utan underkategorier) bland livsmedel */
export function foodLeaves(tree) {
  const leaves = [];
  const walk = (c, top) => {
    const kids = c.childCategories || [];
    if (!kids.length) leaves.push({ id: c.categoryId, name: c.name, count: c.productCount || 0, top });
    else kids.forEach((k) => walk(k, top));
  };
  for (const c of tree || []) if (!ICA_SKIP_TOP.has(c.name)) walk(c, c.name);
  return leaves;
}

const UNIT_LABELS = { 'fop.price.per.litre': 'l', 'fop.price.per.kg': 'kg', 'fop.price.per.each': 'st' };

/**
 * Kampanjtext -> styckpris.
 * "4 för 55 kr -- Max 1 erbj/hushåll" -> 13.75, "29,90 kr/kg" -> 29.9, "Spara 10 kr" -> pris - 10
 */
export function parseIcaOffer(description, price) {
  if (!description) return null;
  const d = description.replace(/ /g, ' ');
  let m = d.match(/(\d+)\s*för\s*(\d+(?:[.,]\d+)?)\s*kr/i);
  if (m) return Math.round((Number(m[2].replace(',', '.')) / Number(m[1])) * 100) / 100;
  m = d.match(/(\d+(?:[.,]\d+)?)\s*kr\s*\/\s*(st|kg|förp)/i);
  if (m) return Number(m[1].replace(',', '.'));
  m = d.match(/spara\s*(\d+(?:[.,]\d+)?)\s*kr/i);
  if (m && price != null) return Math.round((price - Number(m[1].replace(',', '.'))) * 100) / 100;
  return null;
}

export function toIcaItem(e, accountId) {
  const price = e.price?.current?.amount != null ? Number(e.price.current.amount) : null;
  const unit = e.price?.unit;
  const promoText = e.offer?.description?.replace(/\s*--\s*/g, ' · ') || null;
  return withMatchKeys({
    sku: String(e.retailerProductId || e.productId),
    ean: null, // ICA visar ingen streckkod
    name: e.name,
    brand: e.brand || null,
    size: e.size?.value || null,
    image_url: e.image?.src || null,
    category: (e.categoryPath || [])[0] || null,
    url: `${ICA_BASE}/stores/${accountId}/products/x/${e.retailerProductId}`,
    price,
    price_unit: null,
    compare_price: unit?.current?.amount != null ? Number(unit.current.amount) : null,
    compare_unit: UNIT_LABELS[unit?.label] || null,
    promo_price: parseIcaOffer(e.offer?.description, price),
    promo_text: promoText,
    in_stock: e.available !== false,
  });
}

/** ICA:s butikslista -> rader för ica_stores */
export function toIcaStore(s) {
  return {
    account_id: String(s.accountId),
    store_code: s.id || null,
    name: s.name,
    city: s.city || null,
    street: s.street || null,
    zip: s.zipCode || null,
    format: s.storeFormat || null,
    lat: s.latitude ?? null,
    lng: s.longitude ?? null,
  };
}

// ---------- Erbjudanden från ica.se (butiker utan e-handel) ----------

/**
 * Plockar ut en JSON-array ur sidans skript utan att köra något av sidans kod.
 * Sidans __INITIAL_DATA__ är inte giltig JSON i sin helhet (innehåller t.ex. `new Map`),
 * men listan med erbjudanden är det.
 */
export function extractJsonArray(src, key) {
  const k = src.indexOf(`"${key}":[`);
  if (k < 0) return null;
  const start = src.indexOf('[', k);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(src.slice(start, i + 1).replace(/:undefined([,}\]])/g, ':null$1'));
    }
  }
  return null;
}

const parseSek = (s) => {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(t)) return null; // intervall som "27,81-30,95" ger inget enskilt pris
  return Number(t.replace(',', '.'));
};

/** Veckans erbjudanden -> ett item per streckkod */
export function offersToItems(weeklyOffers, pageUrl) {
  const items = [];
  for (const o of weeklyOffers || []) {
    const d = o.details || {};
    const store = (o.stores || [])[0] || {};
    const regular = parseSek(store.regularPrice);
    const promo = parseIcaOffer(d.mechanicInfo, regular);
    const until = o.validTo ? o.validTo.slice(5, 10).split('-').reverse().map(Number).join('/') : null;
    const traits = o.traits || [];
    const text = [
      d.mechanicInfo,
      traits.includes('Stammis') ? 'Stammispris' : null,
      o.restriction || null,
      until ? `t.o.m. ${until}` : null,
    ].filter(Boolean).join(' · ');
    for (const e of o.eans || []) {
      if (!e.id) continue;
      items.push(withMatchKeys({
        sku: String(e.id),
        ean: /^\d{8,14}$/.test(e.id) ? String(e.id).replace(/^0+(?=\d{13}$)/, '') : null,
        name: e.articleDescription || d.name,
        brand: (d.brand || '').split('.')[0].trim() || null,
        size: d.packageInformation || null,
        image_url: e.image || null,
        category: o.category?.articleGroupName || null,
        url: pageUrl,
        price: regular,
        price_unit: null,
        compare_price: null,
        compare_unit: null,
        promo_price: promo,
        promo_text: text || null,
        in_stock: true,
      }));
    }
  }
  return items;
}
