// Normalisering av varumärke, storlek och namn så att samma vara kan paras ihop
// mellan kedjor som saknar gemensam streckkod (främst ICA).

const UNIT_FACTORS = { kg: ['g', 1000], g: ['g', 1], l: ['ml', 1000], dl: ['ml', 100], cl: ['ml', 10], ml: ['ml', 1] };
const NUM = '(\\d+(?:[.,]\\d+)?)';
const SIZE_RE = new RegExp(`${NUM}\\s*(kg|g|l|dl|cl|ml)(?![a-zåäö])`, 'i');
const MULTI_RE = new RegExp(`(\\d+)\\s*[x×]\\s*${NUM}\\s*(kg|g|l|dl|cl|ml)(?![a-zåäö])`, 'i');
const PIECES_RE = /(\d+)\s*(?:-?p(?:ack)?|st|-pack)(?![a-zåäö])/i;

const num = (s) => Number(String(s).replace(',', '.'));

/** "1,5l" -> "1500ml", "0.15kg" -> "150g", "6x33cl" -> "6x330ml", "10-p" -> "10st" */
export function normalizeSize(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/^ca:?\s*/, '');
  let m = s.match(MULTI_RE);
  if (m) {
    const [unit, f] = UNIT_FACTORS[m[3]];
    return `${Number(m[1])}x${Math.round(num(m[2]) * f)}${unit}`;
  }
  m = s.match(SIZE_RE);
  if (m) {
    const [unit, f] = UNIT_FACTORS[m[2]];
    return `${Math.round(num(m[1]) * f)}${unit}`;
  }
  m = s.match(PIECES_RE);
  if (m) return `${Number(m[1])}st`;
  return null;
}

/** "Arla Ko®" -> "arla ko" */
export function normalizeBrand(brand) {
  if (!brand) return null;
  return String(brand).toLowerCase().replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim() || null;
}

/**
 * Namn utan varumärke och storlek, gemener, utan skiljetecken.
 * "Färsk mellanmjölk 1,5% 1,5l Arla Ko®" -> "färsk mellanmjölk 1.5%"
 */
export function normalizeName(name, brand) {
  if (!name) return null;
  let s = String(name).toLowerCase().replace(/[®™©]/g, ' ');
  const b = normalizeBrand(brand);
  if (b) s = s.split(b).join(' ');
  s = s
    .replace(new RegExp(MULTI_RE.source, 'gi'), ' ')
    .replace(new RegExp(SIZE_RE.source, 'gi'), ' ')
    .replace(/(\d),(\d)/g, '$1.$2')          // 1,5% -> 1.5%
    .replace(/[^a-z0-9åäöéü%.\s]/g, ' ')
    .replace(/\s\.|\.\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/** Lägger till normaliserade fält på ett item som skickas till ingest_offers */
export function withMatchKeys(item) {
  return {
    ...item,
    brand_norm: normalizeBrand(item.brand),
    size_norm: normalizeSize(item.size) ?? normalizeSize(item.name),
    name_norm: normalizeName(item.name, item.brand),
  };
}
