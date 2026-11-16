# Prisvis

Gratis prisjämförelse för livsmedel: Willys, Hemköp, Coop och ICA.

## Så fungerar det

```
GitHub Actions (04:10 UTC varje dag)
   └─ scraper/axfood.mjs  ──►  Supabase (Postgres)  ◄──  index.html (GitHub Pages)
        hämtar priser            ingest_offers()            search_products()
```

- **Scraper** – `scraper/axfood.mjs` hämtar Willys och Hemköp kategori för kategori. Den följer
  kedjornas robots.txt: 10 sekunder mellan anrop och bara mellan 04:00–08:45 UTC.
- **Databas** – Supabase-projektet `prisvis` (eu-north-1). Schemat finns i `supabase/migrations/`.
  Varor paras ihop mellan kedjor via EAN-kod. Prishistorik sparas bara när priset ändras.
- **ICA** – `scraper/ica.mjs` kör 23:30 svensk tid. Användaren väljer sin ICA-butik på webbsidan;
  butiken läggs till och hämtas från nästa natt (ca 1 timme per butik, äldst hämtade först).
  ICA saknar streckkod, så varor matchas på varumärke, storlek och namnlikhet (`scraper/normalize.mjs`).
  ICA-butiker utan e-handel (t.ex. ICA Nära Pedagogen Park) får veckans erbjudanden från
  `ica.se/erbjudanden/<butik>/` – med streckkoder, så de matchas exakt. Utgångna erbjudanden rensas.
  Man kan välja upp till fyra ICA-butiker samtidigt.
- **Webbsida** – `index.html`, en statisk sida som läser direkt från Supabase. Kundvagn och
  valt ICA-butik sparas i webbläsaren.

## Status

| Kedja  | Status |
|--------|--------|
| Willys | ✅ klar |
| Hemköp | ✅ klar |
| Lidl   | ✅ veckans sortiment i butik (lidl.se visar bara ett urval, ca 250 varor) |
| Coop   | ✅ Stora Coop Sisjön – `scraper/coop.mjs` kör Playwright (riktig webbläsare) kl. 04:00, ca 300 sidor |
| ICA    | ✅ valda butiker hämtas nattligen (max 40), matchning på varumärke + storlek + namn |

## Inställningar

- `config.json` – Supabase-adress och publik nyckel (inte hemliga).
- GitHub-secret `INGEST_TOKEN` – hemlig nyckel som krävs för att skriva priser till databasen.

## Köra lokalt

```bash
node --test scraper/*.test.mjs                       # tester
node scraper/axfood.mjs willys --dry-run --max-pages=1 --force   # provkörning utan att spara
```
