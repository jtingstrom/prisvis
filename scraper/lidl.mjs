// Scraper för Lidl: veckans sortiment i "Mat & dryck" från lidl.se (några få anrop).
// Användning: node scraper/lidl.mjs [--dry-run]

import { readFileSync } from 'node:fs';
import { LIDL_BASE, LIDL_FOOD_CATEGORY, toLidlItem } from './lidl-lib.mjs';

const USER_AGENT = 'PrisvisBot/0.1 (+https://github.com/jtingstrom/prisvis)';
const PAGE_SIZE = 60;
const DELAY_MS = 3_000;
const dryRun = process.argv.includes('--dry-run');

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const SUPABASE_URL = process.env.SUPABASE_URL || config.supabaseUrl;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || config.supabasePublishableKey;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!dryRun && !INGEST_TOKEN) { console.error('Saknar INGEST_TOKEN'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function supa(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function main() {
  const runStart = new Date().toISOString();
  const raw = [];
  for (let offset = 0, total = Infinity; offset < total; offset += PAGE_SIZE) {
    const url = `${LIDL_BASE}/q/api/search?assortment=SE&locale=sv_SE&version=v2.0.0&category.id=${LIDL_FOOD_CATEGORY}&fetchsize=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Lidl ${res.status} på offset ${offset}`);
    const j = await res.json();
    total = j.numFound ?? 0;
    raw.push(...(j.items || []).map((i) => i.gridbox?.data).filter(Boolean));
    await sleep(DELAY_MS);
  }
  const now = Date.now();
  const items = raw.map((d) => toLidlItem(d, now)).filter(Boolean);
  console.log(`Lidl: ${raw.length} varor på sajten, ${items.length} gäller nu`);
  if (dryRun) { console.log('exempel:', JSON.stringify(items[0])); return; }
  if (!items.length) { console.warn('Inga varor – rensar inte.'); return; }

  const r = await supa('ingest_offers', { p_token: INGEST_TOKEN, p_store: 'lidl', p_items: items });
  const pruned = await supa('prune_store_offers', { p_token: INGEST_TOKEN, p_store: 'lidl', p_before: runStart });
  await supa('mark_store_scraped', { p_token: INGEST_TOKEN, p_store: 'lidl' });
  console.log(`${r.new} nya, ${r.matched} matchade mot andra kedjor, ${r.changed} prisändringar, ${pruned} utgångna borttagna`);
}

main().catch((e) => { console.error(e); process.exit(1); });
