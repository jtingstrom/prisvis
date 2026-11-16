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
- **Webbsida** – `index.html`, en statisk sida som läser direkt från Supabase.

## Status

| Kedja  | Status |
|--------|--------|
| Willys | ✅ klar |
| Hemköp | ✅ klar |
| Coop   | ⏳ nästa (schema.org-data + sitemap) |
| ICA    | ⏳ senare (pris per butik, matchning på namn) |

## Inställningar

- `config.json` – Supabase-adress och publik nyckel (inte hemliga).
- GitHub-secret `INGEST_TOKEN` – hemlig nyckel som krävs för att skriva priser till databasen.

## Köra lokalt

```bash
node --test scraper/*.test.mjs                       # tester
node scraper/axfood.mjs willys --dry-run --max-pages=1 --force   # provkörning utan att spara
```
