// Scraper för Axfood-kedjorna (Willys, Hemköp).
// Hämtar varor kategori för kategori via webbplatsens JSON och skickar dem till Supabase.
// Följer robots.txt: Crawl-delay 10 s och besökstid 04:00–08:45 UTC.
//
// Användning: node scraper/axfood.mjs willys|hemkop [--max-pages=N] [--dry-run]

import { readFileSync } from 'node:fs';
import { toItem } from './lib.mjs';

const CHAINS = {
  willys: { base: 'https://www.willys.se' },
  hemkop: { base: 'https://www.hemkop.se' },
};

// Kategorier vi hoppar över (inte livsmedel eller inte relevanta)
const SKIP_CATEGORIES = new Set(['tobak', 'apotek', 'blommor-och-tradgard', 'kiosk']);

const PAGE_SIZE = 100;
const DELAY_MS = 10_000;          // Crawl-delay: 10
const USER_AGENT = 'PrisvisBot/0.1 (+https://github.com/jtingstrom/prisvis)';

const args = process.argv.slice(2);
const chainId = args.find((a) => !a.startsWith('--'));
const maxPages = Number((args.find((a) => a.startsWith('--max-pages=')) || '').split('=')[1]) || Infinity;
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

// robots.txt: Visit-time 0400-0845 UTC
const now = new Date();
const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
if (!force && (minutes < 4 * 60 || minutes > 8 * 60 + 45)) {
  console.error(`Klockan är ${now.toISOString().slice(11, 16)} UTC – utanför Axfoods besökstid 04:00–08:45 UTC. Avbryter (använd --force för att köra ändå).`);
  process.exit(1);
}

if (!CHAINS[chainId]) {
  console.error(`Okänd kedja "${chainId}". Välj: ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}
const { base } = CHAINS[chainId];

// Publik konfiguration (adress och publik nyckel) ligger i config.json; bara INGEST_TOKEN är hemlig.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const SUPABASE_URL = process.env.SUPABASE_URL || config.supabaseUrl;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || config.supabasePublishableKey;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!dryRun && (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN)) {
  console.error('Saknar SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY eller INGEST_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function getJson(path) {
  const wait = lastRequest + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastRequest = Date.now();
    const res = await fetch(base + path, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (res.ok) return res.json();
    console.warn(`  ${res.status} på ${path} (försök ${attempt})`);
    if (res.status === 404) return null;
    await sleep(DELAY_MS * attempt * 3);
  }
  throw new Error(`Gav upp på ${path}`);
}

async function ingest(items) {
  if (dryRun || items.length === 0) return { total: items.length, new: 0, changed: 0 };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_offers`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_token: INGEST_TOKEN, p_store: chainId, p_items: items }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`== ${chainId}: startar ${new Date().toISOString()}`);
  const tree = await getJson('/leftMenu/categorytree');
  const categories = (tree?.children || [])
    .map((c) => ({ slug: String(c.url).replace(/^\//, ''), title: c.title }))
    .filter((c) => !SKIP_CATEGORIES.has(c.slug));
  console.log(`Kategorier: ${categories.map((c) => c.slug).join(', ')}`);

  const seen = new Set();
  const totals = { total: 0, new: 0, changed: 0 };
  let pagesFetched = 0;

  for (const cat of categories) {
    let page = 0;
    let pages = 1;
    while (page < pages && pagesFetched < maxPages) {
      const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      if (!force && m > 8 * 60 + 45) {
        console.warn('Besökstiden 08:45 UTC har passerats – avslutar i förtid.');
        console.log(`== ${chainId}: avbrutet. ${totals.total} varor, ${totals.new} nya, ${totals.changed} prisändringar.`);
        return;
      }
      const data = await getJson(`/c/${cat.slug}?size=${PAGE_SIZE}&page=${page}`);
      pagesFetched++;
      if (!data) break;
      pages = data.pagination?.numberOfPages ?? 0;
      const items = (data.results || [])
        .filter((p) => p.code && !seen.has(p.code))
        .map((p) => (seen.add(p.code), toItem(p, cat.title, base)));
      const r = await ingest(items);
      totals.total += r.total; totals.new += r.new; totals.changed += r.changed;
      console.log(`  ${cat.slug} sida ${page + 1}/${pages}: ${items.length} varor (nya ${r.new}, ändrade ${r.changed})`);
      if (dryRun && items[0]) console.log('   exempel:', JSON.stringify(items[0]));
      page++;
    }
    if (pagesFetched >= maxPages) break;
  }

  console.log(`== ${chainId}: klart. ${totals.total} varor, ${totals.new} nya, ${totals.changed} prisändringar.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
