// Avgör om en schemalagd körning ska göra något.
// GitHub startar schemalagda körningar ofta flera timmar sent, så arbetsflödet
// triggas varje timme och det här skriptet släpper bara igenom körningar som
//  1) ligger inom Axfoods besökstid 04:00–08:45 UTC (gäller willys/hemkop), och
//  2) inte redan har hämtats färdigt i dag (stores.last_scraped_at).
// Skriver run=true/false till $GITHUB_OUTPUT. Avslutar alltid med kod 0.
import { readFileSync, appendFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const chains = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.AUTO !== 'true';

const now = new Date();
const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
// Lämna marginal så att en hel hämtning (~25 min) hinner klart före 08:45
const anyTime = process.argv.includes('--any-time');
const inWindow = anyTime || minutes >= 4 * 60 && minutes <= 8 * 60 + 10;
const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

async function doneToday(ids) {
  const url = `${config.supabaseUrl}/rest/v1/stores?select=id,last_scraped_at&id=in.(${ids.join(',')})`;
  let res;
  try { res = await fetch(url, { headers: { apikey: config.supabasePublishableKey } }); }
  catch { return false; } // vid tvekan: kör
  if (!res.ok) return false;
  const rows = await res.json();
  return ids.every((id) => {
    const r = rows.find((x) => x.id === id);
    return r?.last_scraped_at && Date.parse(r.last_scraped_at) >= todayStart;
  });
}

let run = true, reason = 'ok';
if (manual) reason = 'manuell start';
else if (!inWindow) { run = false; reason = `${now.toISOString().slice(11, 16)} UTC är utanför besökstiden 04:00–08:10 UTC`; }
else if (await doneToday(chains)) { run = false; reason = 'redan hämtat i dag'; }

console.log(`${chains.join(', ')}: ${run ? 'kör' : 'hoppar över'} (${reason})`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
