// Scraper för Coop. Coops priser laddas med JavaScript och gäller per butik, så vi kör en
// riktig webbläsare (Playwright) som besöker kategorisidorna med vald butik, precis som en kund,
// och läser varorna som sidan själv hämtar.
//
// Användning: node scraper/coop.mjs [--max-pages=N] [--dry-run]

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { COOP_BASE, COOP_FOOD_CATEGORIES, storeContextCookie, toCoopItem } from './coop-lib.mjs';

const PAGE_DELAY_MS = 3_000;
const PAGE_SIZE = 48; // så många varor visar Coop per sida
const args = process.argv.slice(2);
const maxPages = Number((args.find((a) => a.startsWith('--max-pages=')) || '').split('=')[1]) || Infinity;
const dryRun = args.includes('--dry-run');

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const SUPABASE_URL = process.env.SUPABASE_URL || config.supabaseUrl;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || config.supabasePublishableKey;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!dryRun && !INGEST_TOKEN) { console.error('Saknar INGEST_TOKEN'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GitHub Actions-anteckningar syns på körningens sida även utan inloggning
const notice = (m) => console.log(`::notice title=Coop::${m}`);
const warn = (m) => console.log(`::warning title=Coop::${m}`);

async function supa(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function scrapeStore(browser, store) {
  const storeNo = store.id.replace(/^coop-/, '');
  console.log(`== ${store.name} (${storeNo})`);
  const context = await browser.newContext({ locale: 'sv-SE' });
  await context.addCookies([{ name: 'coop-storeContext', value: storeContextCookie(storeNo), domain: '.coop.se', path: '/' }]);
  const page = await context.newPage();
  // Spara bandbredd: bilder, typsnitt och media behövs inte
  await page.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  // Fånga varulistorna som sidan hämtar för vald butik
  let pending = [];
  const storesSeen = new Set();
  page.on('response', async (res) => {
    const u = res.url();
    if (!u.includes('/personalization/search/entities/by-attribute')) return;
    const st = new URL(u).searchParams.get('store');
    storesSeen.add(`${st}:${res.status()}`);
    if (st !== storeNo) return;
    try {
      const j = await res.json();
      pending.push({ count: j?.results?.count ?? 0, items: j?.results?.items || [] });
    } catch { /* ignorera */ }
  });

  // Kontrollera att butiksvalet slagit igenom; annars välj butiken via Coops gränssnitt som en kund
  pending = [];
  await page.goto(`${COOP_BASE}/handla/varor/mejeri-agg/mjolk/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let w = 0; w < 30 && !pending.length; w++) await sleep(500);
  if (!pending.length) {
    console.log(`  Butiksvalet via cookie gav: ${[...storesSeen].join(', ') || 'inga varulistor'} – väljer butiken i gränssnittet`);
    try {
      await page.getByRole('button', { name: /Sortiment visas för/ }).first().click({ timeout: 15_000 });
      await page.getByRole('button', { name: /sök efter butik/i }).click({ timeout: 15_000 });
      const input = page.getByLabel(/Postnummer eller butiksnamn/i);
      await input.fill(store.search || store.name.replace(/^Stora Coop\s*/, ''));
      await page.getByText(store.name, { exact: false }).last().click({ timeout: 15_000 });
      await page.getByRole('button', { name: /Välj denna/i }).click({ timeout: 15_000 });
      await sleep(3000);
    } catch (e) {
      warn(`${store.name}: kunde inte välja butik i gränssnittet (${e.message.split('\n')[0]})`);
    }
  }
  const title = await page.title().catch(() => '?');
  console.log(`  Sidtitel: ${title}. Varulistor sedda för butik: ${[...storesSeen].join(', ') || 'inga'}`);

  const runStart = new Date().toISOString();
  const seen = new Set();
  const totals = { total: 0, new: 0, changed: 0, matched: 0 };
  let pages = 0;

  for (const cat of COOP_FOOD_CATEGORIES) {
    for (let p = 1, last = 1; p <= last && pages < maxPages; p++) {
      pending = [];
      const url = `${COOP_BASE}/handla/varor/${cat}/${p > 1 ? `?page=${p}` : ''}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        for (let w = 0; w < 30 && !pending.length; w++) await sleep(500); // vänta på varulistan
      } catch (e) {
        console.warn(`  ${cat} sida ${p}: ${e.message}`);
        continue;
      }
      pages++;
      const batch = pending.sort((a, b) => b.items.length - a.items.length)[0];
      if (!batch) { warn(`${cat} sida ${p}: ingen varulista för butik ${storeNo} (sett: ${[...storesSeen].join(', ') || 'inga'})`); break; }
      last = Math.ceil(batch.count / PAGE_SIZE);
      const now = Date.now();
      const items = batch.items
        .filter((x) => x.ean && !seen.has(x.ean))
        .map((x) => (seen.add(x.ean), toCoopItem(x, now)));
      if (items.length && !dryRun) {
        const r = await supa('rpc/ingest_offers', { p_token: INGEST_TOKEN, p_store: store.id, p_items: items });
        for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
      } else {
        totals.total += items.length;
        if (dryRun && items[0] && pages === 1) console.log('   exempel:', JSON.stringify(items[0]));
      }
      console.log(`  ${cat} sida ${p}/${last}: ${items.length} varor`);
      await sleep(PAGE_DELAY_MS);
    }
  }
  await context.close();

  const complete = pages < maxPages;
  const summary = `${store.name}: ${complete ? 'klart' : 'avbrutet'} – ${pages} sidor, ${totals.total} varor, ${totals.new} nya, ${totals.matched} matchade, ${totals.changed} prisändringar`;
  console.log('  ' + summary);
  notice(summary);
  if (complete && !dryRun && seen.size > 500) {
    const pruned = await supa('rpc/prune_store_offers', { p_token: INGEST_TOKEN, p_store: store.id, p_before: runStart });
    await supa('rpc/mark_store_scraped', { p_token: INGEST_TOKEN, p_store: store.id });
    console.log(`  ${pruned} varor som inte längre finns togs bort`);
  }
}

async function main() {
  const stores = await supa('stores?chain=eq.coop&select=id,name&order=last_scraped_at.asc.nullsfirst');
  console.log(`== Coop: ${stores.length} butiker`);
  const browser = await chromium.launch();
  try {
    for (const s of stores) await scrapeStore(browser, s);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); warn(`Fel: ${e.message}`); process.exit(1); });
