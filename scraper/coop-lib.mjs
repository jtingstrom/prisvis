// Hjälpfunktioner för Coop-scrapern (testbara utan nätverk)
import { withMatchKeys } from './normalize.mjs';

export const COOP_BASE = 'https://www.coop.se';

// Toppkategorier med livsmedel (kiosk, hem, skönhet m.m. hoppas över)
export const COOP_FOOD_CATEGORIES = [
  'frukt-gronsaker', 'kott-fagel-chark', 'fisk-skaldjur', 'mejeri-agg', 'ost', 'vegetariskt', 'frys',
  'dryck', 'skafferi', 'brod-bageri', 'godis-glass-snacks', 'fardigmat-mellanmal', 'kryddor-smaksattare',
  'barn', 'delikatesser',
];

/** Cookievärdet som coop.se själv sätter när man väljer butik/upphämtning */
export function storeContextCookie(storeId) {
  const json = JSON.stringify({ productionUnitId: String(storeId), pickupPointId: null, storeName: null });
  return encodeURIComponent(Buffer.from(json).toString('base64'));
}

// Coop skriver enheter på flera sätt ("kilo", "Kilogram", "kr/kg", "liter", "kr/lit", "styck")
export function compareUnit(p) {
  const t = `${p.comparativePriceUnit?.unit || ''} ${p.comparativePriceUnit?.text || ''} ${p.comparativePriceText || ''}`.toLowerCase();
  if (/kilo|kg/.test(t)) return 'kg';
  if (/lit|\bl\b/.test(t)) return 'l';
  if (/st/.test(t)) return 'st';
  return null;
}
const isWeighed = (p) => /vikt|kilo|kg/i.test(p.salesUnit || '');

function topCategory(p) {
  let c = (p.navCategories || [])[0];
  while (c?.superCategories?.length) c = c.superCategories[0];
  return c?.name || null;
}

/** Bästa giltiga kampanj -> { promo_price (per styck/kg), promo_text } */
export function bestPromotion(p, now = Date.now()) {
  let best = null;
  for (const pr of p.onlinePromotions || []) {
    const start = pr.startDate ? Date.parse(pr.startDate) : -Infinity;
    const end = pr.endDate ? Date.parse(pr.endDate) : Infinity;
    if (now < start || now > end) continue;
    const total = pr.priceData?.b2cPrice;
    if (total == null) continue;
    const n = Math.max(1, pr.numberOfProductRequired || 1);
    const per = Math.round((total / n) * 100) / 100;
    if (!best || per < best.per) best = { per, n, total, pr, end };
  }
  if (!best) return { promo_price: null, promo_text: null };
  const fmt = (x) => String(x).replace('.', ',');
  const parts = [best.n > 1 ? `${best.n} för ${fmt(best.total)} kr` : `${fmt(best.total)} kr`];
  if (best.pr.medMeraRequired) parts.push('Medlemspris');
  // Visa slutdatum bara för vanliga veckokampanjer, inte för långa "låga priser"
  if (Number.isFinite(best.end) && best.end - now < 45 * 86400_000) {
    const d = new Date(best.end);
    parts.push(`t.o.m. ${d.getUTCDate()}/${d.getUTCMonth() + 1}`);
  }
  return { promo_price: best.per, promo_text: parts.join(' · ') };
}

export function toCoopItem(p, now = Date.now()) {
  const { promo_price, promo_text } = bestPromotion(p, now);
  const ean = p.ean && /^\d{8,14}$/.test(p.ean) ? p.ean : null;
  return withMatchKeys({
    sku: String(p.id || p.ean),
    ean: ean && !ean.startsWith('2') ? ean : null, // 2x = butiksinterna viktkoder
    name: p.name,
    brand: p.manufacturerName || null,
    size: p.packageSizeInformation || null,
    image_url: p.imageUrl ? p.imageUrl.replace(/^http:/, 'https:').replace(/\.tiff?$/, '.jpg') : null,
    category: topCategory(p),
    url: `${COOP_BASE}/handla/sok/?q=${encodeURIComponent(p.ean || p.name)}`,
    price: p.salesPriceData?.b2cPrice ?? null,
    price_unit: isWeighed(p) ? 'kr/kg' : 'kr/st',
    compare_price: p.comparativePriceData?.b2cPrice ?? null,
    compare_unit: compareUnit(p),
    promo_price,
    promo_text,
    in_stock: p.availableOnline !== false,
  });
}
