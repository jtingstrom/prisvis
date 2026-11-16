-- Prisvis: grundschema för prisjämförelse av livsmedel

-- Butiker/kedjor. För ICA blir varje referensbutik en egen rad (t.ex. 'ica-1003417').
create table public.stores (
  id          text primary key,
  chain       text not null,             -- 'willys', 'hemkop', 'coop', 'ica'
  name        text not null,
  website     text
);

-- Produkter, gemensamma mellan kedjor. EAN är nyckeln för att para ihop.
create table public.products (
  id          bigint generated always as identity primary key,
  ean         text unique,               -- 13 siffror, null om okänt (t.ex. viktvaror)
  name        text not null,
  brand       text,
  size        text,                      -- "1l", "500g"
  image_url   text,
  category    text,
  created_at  timestamptz not null default now()
);

-- En butiks erbjudande för en vara: aktuellt pris.
create table public.offers (
  store_id       text not null references public.stores(id),
  store_sku      text not null,          -- kedjans eget artikelnummer
  product_id     bigint not null references public.products(id),
  name           text not null,
  url            text,
  price          numeric(10,2),
  price_unit     text,                   -- 'kr/st', 'kr/kg'
  compare_price  numeric(10,2),
  compare_unit   text,                   -- 'l', 'kg', 'st'
  promo_price    numeric(10,2),
  promo_text     text,
  in_stock       boolean,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  primary key (store_id, store_sku)
);
create index offers_product_idx on public.offers(product_id);

-- Prishistorik: en rad bara när pris eller kampanjpris ändras.
create table public.price_history (
  id           bigint generated always as identity primary key,
  store_id     text not null,
  store_sku    text not null,
  price        numeric(10,2),
  promo_price  numeric(10,2),
  observed_at  timestamptz not null default now(),
  foreign key (store_id, store_sku) references public.offers(store_id, store_sku) on delete cascade
);
create index price_history_offer_idx on public.price_history(store_id, store_sku, observed_at desc);

-- Sökning på namn/varumärke
create extension if not exists pg_trgm with schema extensions;
create index products_name_trgm on public.products using gin (name extensions.gin_trgm_ops);

-- Privat schema för hemligheter (exponeras inte via API:t)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.settings (key text primary key, value text not null);

-- RLS: alla får läsa, ingen får skriva via API:t
alter table public.stores        enable row level security;
alter table public.products      enable row level security;
alter table public.offers        enable row level security;
alter table public.price_history enable row level security;
create policy "read stores"   on public.stores        for select to anon, authenticated using (true);
create policy "read products" on public.products      for select to anon, authenticated using (true);
create policy "read offers"   on public.offers        for select to anon, authenticated using (true);
create policy "read history"  on public.price_history for select to anon, authenticated using (true);

-- Inläsning från scrapern. Skyddas med en hemlig nyckel (private.settings 'ingest_token').
-- p_items: [{sku, ean, name, brand, size, image_url, category, url, price, price_unit,
--            compare_price, compare_unit, promo_price, promo_text, in_stock}]
create or replace function public.ingest_offers(p_token text, p_store text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_item jsonb;
  v_pid bigint;
  v_old record;
  v_new int := 0; v_changed int := 0; v_total int := 0;
  v_ean text;
  v_exists boolean;
begin
  if p_token is null or p_token <> (select value from private.settings where key = 'ingest_token') then
    raise exception 'unauthorized';
  end if;
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'unknown store %', p_store;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_total := v_total + 1;
    v_ean := nullif(v_item->>'ean', '');

    -- Hitta befintligt erbjudande
    select o.product_id, o.price, o.promo_price into v_old
      from public.offers o where o.store_id = p_store and o.store_sku = v_item->>'sku';

    v_exists := found;
    if v_exists then
      v_pid := v_old.product_id;
    else
      v_pid := null;
      if v_ean is not null then
        select id into v_pid from public.products where ean = v_ean;
      end if;
      if v_pid is null then
        insert into public.products (ean, name, brand, size, image_url, category)
        values (v_ean, v_item->>'name', v_item->>'brand', v_item->>'size', v_item->>'image_url', v_item->>'category')
        returning id into v_pid;
      end if;
    end if;

    -- Fyll på saknade produktfält
    update public.products set
      brand = coalesce(brand, v_item->>'brand'),
      size = coalesce(size, v_item->>'size'),
      image_url = coalesce(image_url, v_item->>'image_url'),
      category = coalesce(category, v_item->>'category')
    where id = v_pid and (brand is null or size is null or image_url is null or category is null);

    insert into public.offers as o (store_id, store_sku, product_id, name, url, price, price_unit,
        compare_price, compare_unit, promo_price, promo_text, in_stock, last_seen)
    values (p_store, v_item->>'sku', v_pid, v_item->>'name', v_item->>'url',
        (v_item->>'price')::numeric, v_item->>'price_unit',
        (v_item->>'compare_price')::numeric, v_item->>'compare_unit',
        (v_item->>'promo_price')::numeric, v_item->>'promo_text',
        (v_item->>'in_stock')::boolean, now())
    on conflict (store_id, store_sku) do update set
        name = excluded.name, url = excluded.url, price = excluded.price, price_unit = excluded.price_unit,
        compare_price = excluded.compare_price, compare_unit = excluded.compare_unit,
        promo_price = excluded.promo_price, promo_text = excluded.promo_text,
        in_stock = excluded.in_stock, last_seen = now();

    if not v_exists or v_old.price is distinct from (v_item->>'price')::numeric
       or v_old.promo_price is distinct from (v_item->>'promo_price')::numeric then
      insert into public.price_history (store_id, store_sku, price, promo_price)
      values (p_store, v_item->>'sku', (v_item->>'price')::numeric, (v_item->>'promo_price')::numeric);
      if not v_exists then v_new := v_new + 1; else v_changed := v_changed + 1; end if;
    end if;
  end loop;

  return jsonb_build_object('total', v_total, 'new', v_new, 'changed', v_changed);
end;
$$;
revoke all on function public.ingest_offers(text, text, jsonb) from public;
grant execute on function public.ingest_offers(text, text, jsonb) to anon, authenticated;

-- Sökning för webbsidan: produkter med alla butikers erbjudanden
create or replace function public.search_products(q text, max_results int default 40)
returns table (
  product_id bigint, ean text, name text, brand text, size text, image_url text, category text,
  offers jsonb, min_price numeric
)
language sql stable
set search_path = public, extensions
as $$
  with hits as (
    select p.* from public.products p
    where p.name ilike '%' || q || '%' or p.brand ilike '%' || q || '%' or p.ean = q
    order by similarity(p.name, q) desc
    limit greatest(1, least(max_results, 100))
  )
  select h.id, h.ean, h.name, h.brand, h.size, h.image_url, h.category,
    coalesce(jsonb_agg(jsonb_build_object(
        'store_id', o.store_id, 'chain', s.chain, 'store', s.name, 'price', o.price,
        'promo_price', o.promo_price, 'promo_text', o.promo_text,
        'compare_price', o.compare_price, 'compare_unit', o.compare_unit,
        'url', o.url, 'in_stock', o.in_stock, 'last_seen', o.last_seen)
      order by coalesce(o.promo_price, o.price)) filter (where o.store_id is not null), '[]'::jsonb),
    min(coalesce(o.promo_price, o.price))
  from hits h
  left join public.offers o on o.product_id = h.id
  left join public.stores s on s.id = o.store_id
  group by h.id, h.ean, h.name, h.brand, h.size, h.image_url, h.category
  order by count(o.store_id) desc, min(coalesce(o.promo_price, o.price));
$$;
grant execute on function public.search_products(text, int) to anon, authenticated;

insert into public.stores (id, chain, name, website) values
  ('willys', 'willys', 'Willys', 'https://www.willys.se'),
  ('hemkop', 'hemkop', 'Hemköp', 'https://www.hemkop.se');
