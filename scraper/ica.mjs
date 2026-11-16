// Scraper för ICA. Varje ICA-butik har egna priser, så vi hämtar bara de butiker
// som användare har valt (tabellen stores, chain = 'ica'), äldst hämtade först.
//
// Användning: node scraper/ica.mjs [--max-stores=N] [--max-pages=N] [--budget-min=300] [--dry-run]

import { readFileSync } from 'node:fs';
import { ICA_BASE, parseState, productsFromState, foodLeaves, toIcaItem, toIcaStore, extractJsonArray, offersToItems } from './ica-lib.mjs';

const DELAY_MS = 3_000; // ICA anger ingen crawl-delay; vi håller ändå en lugn takt
const USER_AGENT = 'PrisvisBot/0.1 (+https://github.com/jtingstrom/prisvis)';
const REFRESH_HOURS = 20; // butiker som hämtats senare än så hoppas över

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};
const maxStores = opt('max-stores', Infinity);
const maxPages = opt('max-pages', Infinity);
const budgetMs = opt('budget-min', 300) * 60_000;
const dryRun = args.includes('--dry-run');
const started = Date.now();

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const SUPABASE_URL = process.env.SUPABASE_URL || config.supabaseUrl;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || config.supabasePublishableKey;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!dryRun && !INGEST_TOKEN) {
  console.error('Saknar INGEST_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function icaFetch(path, { json = false } = {}) {
  const wait = lastRequest + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastRequest = Date.now();
    const res = await fetch(ICA_BASE + path, {
      headers: { 'user-agent': USER_AGENT, accept: json ? 'application/json' : 'text/html' },
    });
    if (res.ok) return json ? res.json() : res.text();
    console.warn(`  ${res.status} på ${path} (försök ${attempt})`);
    if (res.status === 404) return null;
    await sleep(DELAY_MS * attempt * 5);
  }
  throw new Error(`Gav upp på ${path}`);
}

async function supa(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function refreshStoreCatalog() {
  const res = await fetch('https://handla.ica.se/api/store/v1?customerType=B2C', {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Butikslistan gav ${res.status}`);
  const stores = (await res.json()).filter((s) => s.accountId).map(toIcaStore);
  if (!dryRun) await supa('rpc/ingest_ica_stores', { p_token: INGEST_TOKEN, p_items: stores });
  console.log(`Butikskatalog: ${stores.length} ICA-butiker med e-handel`);
}

async function scrapeStore(store) {
  const acc = store.ica_account;
  console.log(`== ${store.name} (${acc})`);
  const tree = await icaFetch(`/stores/${acc}/api/webproductpagews/v1/categories?categoryDepth=4`, { json: true });
  const leaves = foodLeaves(tree);
  console.log(`  ${leaves.length} kategorier, ca ${leaves.reduce((s, l) => s + l.count, 0)} varor`);

  const seen = new Set();
  const totals = { total: 0, new: 0, changed: 0, matched: 0 };
  let pages = 0;

  for (const leaf of leaves) {
    if (Date.now() - started > budgetMs) return { done: false, totals };
    if (pages >= maxPages) return { done: false, totals };
    // En sida visar högst 50 varor med detaljer; större kategorier hämtas även i omvänd prisordning
    const sorts = leaf.count > 50 ? ['priceAscending', 'priceDescending'] : [null];
    for (const sort of sorts) {
      const html = await icaFetch(`/stores/${acc}/categories/x/${leaf.id}${sort ? `?sortBy=${sort}` : ''}`);
      pages++;
      if (!html) continue;
      const { entities } = productsFromState(parseState(html));
      const items = entities
        .filter((e) => e.retailerProductId && !seen.has(e.retailerProductId))
        .map((e) => (seen.add(e.retailerProductId), toIcaItem(e, acc)));
      if (!items.length) continue;
      if (dryRun) {
        totals.total += items.length;
        if (pages === 1) console.log('   exempel:', JSON.stringify(items[0]));
        continue;
      }
      const r = await supa('rpc/ingest_offers', { p_token: INGEST_TOKEN, p_store: store.id, p_items: items });
      for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
    }
    if (pages % 50 === 0) console.log(`  ${pages} sidor, ${seen.size} varor hittills`);
  }
  return { done: true, totals };
}

// Butiker utan e-handel: bara veckans erbjudanden från ica.se (en sida per butik)
async function scrapeOfferStores() {
  const stores = await supa('stores?chain=eq.ica&coverage=eq.offers&select=id,name,ica_offers_slug');
  for (const store of stores) {
    const runStart = new Date().toISOString();
    const pageUrl = `https://www.ica.se/erbjudanden/${store.ica_offers_slug}/`;
    const wait = lastRequest + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(pageUrl, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
    if (!res.ok) { console.warn(`  ${store.name}: ${res.status}`); continue; }
    const offers = extractJsonArray(await res.text(), 'weeklyOffers');
    const items = offersToItems(offers, pageUrl);
    console.log(`== ${store.name}: ${offers?.length ?? 0} erbjudanden, ${items.length} varor`);
    if (dryRun) { if (items[0]) console.log('   exempel:', JSON.stringify(items[0])); continue; }
    if (!items.length) continue; // rensa inte om sidan av någon anledning var tom
    const r = await supa('rpc/ingest_offers', { p_token: INGEST_TOKEN, p_store: store.id, p_items: items });
    const pruned = await supa('rpc/prune_store_offers', { p_token: INGEST_TOKEN, p_store: store.id, p_before: runStart });
    await supa('rpc/mark_store_scraped', { p_token: INGEST_TOKEN, p_store: store.id });
    console.log(`  ${r.new} nya, ${r.changed} ändrade, ${pruned} utgångna borttagna`);
  }
}

async function main() {
  console.log(`== ICA: startar ${new Date().toISOString()}`);
  await refreshStoreCatalog();
  await scrapeOfferStores();

  const stores = await supa('stores?chain=eq.ica&coverage=eq.full&select=id,name,ica_account,last_scraped_at&order=last_scraped_at.asc.nullsfirst');
  const cutoff = Date.now() - REFRESH_HOURS * 3600_000;
  const due = stores.filter((s) => !s.last_scraped_at || Date.parse(s.last_scraped_at) < cutoff).slice(0, maxStores);
  console.log(`${stores.length} valda ICA-butiker, ${due.length} att hämta nu`);

  for (const store of due) {
    if (Date.now() - started > budgetMs) {
      console.log('Tidsbudgeten är slut – resten hämtas nästa natt.');
      break;
    }
    const { done, totals } = await scrapeStore(store);
    console.log(`  ${done ? 'klart' : 'avbrutet'}: ${totals.total} varor, ${totals.new} nya, ${totals.matched} matchade mot andra kedjor, ${totals.changed} prisändringar`);
    if (done && !dryRun) await supa('rpc/mark_store_scraped', { p_token: INGEST_TOKEN, p_store: store.id });
  }
  console.log(`== ICA: klart efter ${Math.round((Date.now() - started) / 60000)} min`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
