-- ICA: butikskatalog, butiksval och matchning utan streckkod

-- Normaliserade fält för matchning mellan kedjor
alter table public.products
  add column brand_norm text,
  add column size_norm  text,
  add column name_norm  text;
create index products_match_idx on public.products (brand_norm, size_norm);

-- Spårade butiker
alter table public.stores
  add column ica_account     text unique,
  add column requested_at    timestamptz,
  add column request_count   int not null default 0,
  add column last_scraped_at timestamptz;

-- Alla ICA-butiker med e-handel (fylls i av scrapern varje natt)
create table public.ica_stores (
  account_id  text primary key,
  store_code  text,
  name        text not null,
  city        text,
  street      text,
  zip         text,
  format      text,
  lat         double precision,
  lng         double precision,
  updated_at  timestamptz not null default now()
);
alter table public.ica_stores enable row level security;
create policy "read ica_stores" on public.ica_stores for select to anon, authenticated using (true);

-- Max antal ICA-butiker som hämtas (skydd mot överbelastning)
insert into private.settings (key, value) values ('max_ica_stores', '40') on conflict do nothing;

create or replace function private.check_token(p_token text) returns void
language plpgsql security definer set search_path = private as $$
begin
  if p_token is null or p_token <> (select value from private.settings where key = 'ingest_token') then
    raise exception 'unauthorized';
  end if;
end $$;

-- Scrapern: uppdatera butikskatalogen
create or replace function public.ingest_ica_stores(p_token text, p_items jsonb)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.check_token(p_token);
  insert into public.ica_stores (account_id, store_code, name, city, street, zip, format, lat, lng, updated_at)
  select x->>'account_id', x->>'store_code', x->>'name', x->>'city', x->>'street', x->>'zip', x->>'format',
         (x->>'lat')::float8, (x->>'lng')::float8, now()
  from jsonb_array_elements(p_items) x
  on conflict (account_id) do update set
    store_code = excluded.store_code, name = excluded.name, city = excluded.city, street = excluded.street,
    zip = excluded.zip, format = excluded.format, lat = excluded.lat, lng = excluded.lng, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Webbsidan: användaren väljer en ICA-butik. Butiken börjar hämtas från nästa natt.
create or replace function public.request_ica_store(p_account text)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  v_store public.ica_stores;
  v_id text := 'ica-' || p_account;
  v_row public.stores;
  v_max int := coalesce((select value::int from private.settings where key = 'max_ica_stores'), 40);
begin
  select * into v_store from public.ica_stores where account_id = p_account;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into v_row from public.stores where id = v_id;
  if found then
    update public.stores set request_count = request_count + 1 where id = v_id;
  else
    if (select count(*) from public.stores where chain = 'ica') >= v_max then
      return jsonb_build_object('status', 'full', 'store_id', v_id);
    end if;
    insert into public.stores (id, chain, name, website, ica_account, requested_at, request_count)
    values (v_id, 'ica', v_store.name, 'https://handlaprivatkund.ica.se/stores/' || p_account, p_account, now(), 1)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'status', case when v_row.last_scraped_at is null then 'pending' else 'ready' end,
    'store_id', v_id, 'name', v_row.name, 'last_scraped_at', v_row.last_scraped_at);
end $$;
revoke all on function public.request_ica_store(text) from public;
grant execute on function public.request_ica_store(text) to anon, authenticated;

-- Scrapern: markera att en butik är färdighämtad
create or replace function public.mark_store_scraped(p_token text, p_store text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.check_token(p_token);
  update public.stores set last_scraped_at = now() where id = p_store;
end $$;

revoke all on function public.ingest_ica_stores(text, jsonb) from public;
revoke all on function public.mark_store_scraped(text, text) from public;
grant execute on function public.ingest_ica_stores(text, jsonb) to anon, authenticated;
grant execute on function public.mark_store_scraped(text, text) to anon, authenticated;

-- Inläsning: nu med matchning på varumärke + storlek + namnlikhet när streckkod saknas
create or replace function public.ingest_offers(p_token text, p_store text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions
as $$
declare
  v_item jsonb;
  v_pid bigint;
  v_old record;
  v_new int := 0; v_changed int := 0; v_total int := 0; v_matched int := 0;
  v_ean text; v_bn text; v_sn text; v_nn text;
  v_exists boolean;
begin
  perform private.check_token(p_token);
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'unknown store %', p_store;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_total := v_total + 1;
    v_ean := nullif(v_item->>'ean', '');
    v_bn := nullif(v_item->>'brand_norm', '');
    v_sn := nullif(v_item->>'size_norm', '');
    v_nn := nullif(v_item->>'name_norm', '');

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
      -- Utan streckkod: samma varumärke och storlek, liknande namn, och inte redan såld i den här butiken
      if v_pid is null and v_ean is null and v_bn is not null and v_sn is not null and v_nn is not null then
        select p.id into v_pid
        from public.products p
        where p.brand_norm = v_bn and p.size_norm = v_sn and p.name_norm is not null
          and similarity(p.name_norm, v_nn) >= 0.45
          and not exists (select 1 from public.offers o2 where o2.product_id = p.id and o2.store_id = p_store)
        order by similarity(p.name_norm, v_nn) desc
        limit 1;
        if v_pid is not null then v_matched := v_matched + 1; end if;
      end if;
      if v_pid is null then
        insert into public.products (ean, name, brand, size, image_url, category, brand_norm, size_norm, name_norm)
        values (v_ean, v_item->>'name', v_item->>'brand', v_item->>'size', v_item->>'image_url', v_item->>'category', v_bn, v_sn, v_nn)
        returning id into v_pid;
      end if;
    end if;

    update public.products set
      brand = coalesce(brand, v_item->>'brand'),
      size = coalesce(size, v_item->>'size'),
      image_url = coalesce(image_url, v_item->>'image_url'),
      category = coalesce(category, v_item->>'category'),
      brand_norm = coalesce(brand_norm, v_bn),
      size_norm = coalesce(size_norm, v_sn),
      name_norm = coalesce(name_norm, v_nn)
    where id = v_pid and (brand is null or size is null or image_url is null or category is null
                          or brand_norm is null or size_norm is null or name_norm is null);

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

  return jsonb_build_object('total', v_total, 'new', v_new, 'changed', v_changed, 'matched', v_matched);
end;
$$;
