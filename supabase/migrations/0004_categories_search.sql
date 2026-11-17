-- Gemensamma kategorier för alla kedjor, synonymer och bättre sökrankning

create or replace function public.category_group(c text) returns text
language sql immutable as $$
  select case
    when c is null then 'Övrigt'
    when c ~* 'djur' then 'Djur'
    when c ~* 'apotek|hälsa|skönhet|hygien|drogeri' then 'Hälsa & skönhet'
    when c ~* 'hem|städ|hushåll|blommor' then 'Hem & hushåll'
    when c ~* 'kött|chark|fågel' then 'Kött, chark & fågel'
    when c ~* 'fisk|skaldjur' then 'Fisk & skaldjur'
    when c ~* 'mejeri|ost|ägg' then 'Mejeri, ost & ägg'
    when c ~* 'frukt|grönt|grönsak' then 'Frukt & grönt'
    when c ~* 'bröd|bageri|kakor|kex' then 'Bröd & bageri'
    when c ~* 'frys|fryst' then 'Fryst'
    when c ~* 'godis|glass|snacks' then 'Godis, glass & snacks'
    when c ~* 'dryck|vin' then 'Dryck'
    when c ~* 'färdigmat|färdigrätt|mellanmål|delikates' then 'Färdigmat & deli'
    when c ~* 'vegetarisk' then 'Vegetariskt'
    when c ~* 'barn' then 'Barn'
    when c ~* 'skafferi|krydd|smaksätt|olj|såser|müsli|pålägg|matförråd' then 'Skafferi'
    when c ~* 'färskvaror' then 'Färskvaror'
    else 'Övrigt'
  end
$$;

alter table public.products
  add column category_group text generated always as (public.category_group(category)) stored;
create index products_category_group_idx on public.products (category_group);

-- Synonymer: ett sökord kan även betyda andra ord, och har ofta en "rätt" kategori
create table public.search_synonyms (
  term      text primary key,          -- gemener, t.ex. 'köttfärs'
  also      text[] not null default '{}',
  category  text                       -- föredragen category_group
);
alter table public.search_synonyms enable row level security;
create policy "read synonyms" on public.search_synonyms for select to anon, authenticated using (true);

insert into public.search_synonyms (term, also, category) values
  ('köttfärs',  array['nötfärs','blandfärs','fläskfärs'], 'Kött, chark & fågel'),
  ('färs',      array['nötfärs','blandfärs','fläskfärs','kycklingfärs','lammfärs'], 'Kött, chark & fågel'),
  ('kyckling',  array['kycklingfilé','kycklinglårfilé','kycklingbröst'], 'Kött, chark & fågel'),
  ('mjölk',     array['mellanmjölk','standardmjölk','lättmjölk','minimjölk'], 'Mejeri, ost & ägg'),
  ('smör',      array['bregott','normalsaltat'], 'Mejeri, ost & ägg'),
  ('ägg',       array['frigående','ekologiska ägg'], 'Mejeri, ost & ägg'),
  ('ost',       array['hushållsost','herrgård','präst','grevé'], 'Mejeri, ost & ägg'),
  ('kaffe',     array['bryggkaffe','mellanrost','mörkrost'], 'Dryck'),
  ('bröd',      array['limpa','rostbröd','formbröd'], 'Bröd & bageri'),
  ('pasta',     array['spaghetti','penne','makaroner','fusilli'], 'Skafferi'),
  ('ris',       array['jasminris','basmatiris','långkornigt'], 'Skafferi'),
  ('bananer',   array['banan'], 'Frukt & grönt'),
  ('äpple',     array['äpplen'], 'Frukt & grönt'),
  ('potatis',   array['fast potatis','mjölig potatis'], 'Frukt & grönt'),
  ('lax',       array['laxfilé'], 'Fisk & skaldjur'),
  ('kattmat',   array['katt'], 'Djur'),
  ('hundmat',   array['hund'], 'Djur');

-- Ny sökning med rankning och valfritt kategorifilter
drop function if exists public.search_products(text, int);
create or replace function public.search_products(q text, max_results int default 60, p_category text default null)
returns table (
  product_id bigint, ean text, name text, brand text, size text, image_url text, category text,
  category_group text, offers jsonb, min_price numeric, rank int
)
language sql stable
set search_path = public, extensions
as $$
  with input as (
    select lower(trim(regexp_replace(q, '[^[:alnum:]åäöÅÄÖéü %.,-]', '', 'g'))) as t
  ),
  syn as (
    select i.t, s.also, s.category,
           array_prepend(i.t, coalesce(s.also, '{}')) as terms
    from input i left join public.search_synonyms s on s.term = i.t
  ),
  hits as (
    select p.*,
      (select min(
         case
           when lower(p.name) ~ ('^' || x || '(\M|$)') then 0             -- börjar med ordet
           when lower(p.name) ~ ('\m' || x || '\M') then 1                -- hela ordet finns
           when lower(p.name) like '%' || x || '%' then 3                 -- del av ett längre ord
           else 9 end)
       from unnest(syn.terms) x) as name_rank,
      case
        when syn.category is not null and p.category_group = syn.category then 0
        when p.category_group = 'Djur' and coalesce(syn.category, '') <> 'Djur' then 4   -- djurmat sist
        when p.category_group in ('Hälsa & skönhet', 'Hem & hushåll') then 3
        else 1 end as cat_rank
    from public.products p, syn
    where (p.name ilike any (select '%' || x || '%' from unnest(syn.terms) x)
           or p.brand ilike '%' || syn.t || '%' or p.ean = syn.t)
      and (p_category is null or p.category_group = p_category)
  ),
  ranked as (
    select h.*, (h.name_rank * 2 + h.cat_rank) as rank
    from hits h
    where h.name_rank < 9 or h.brand ilike '%' || (select t from input) || '%' or h.ean = (select t from input)
    order by rank, length(h.name), h.name
    limit greatest(1, least(max_results, 150))
  )
  select r.id, r.ean, r.name, r.brand, r.size, r.image_url, r.category, r.category_group,
    coalesce(jsonb_agg(jsonb_build_object(
        'store_id', o.store_id, 'chain', s.chain, 'store', s.name, 'price', o.price,
        'promo_price', o.promo_price, 'promo_text', o.promo_text,
        'compare_price', o.compare_price, 'compare_unit', o.compare_unit,
        'url', o.url, 'in_stock', o.in_stock, 'last_seen', o.last_seen)
      order by coalesce(o.promo_price, o.price)) filter (where o.store_id is not null), '[]'::jsonb),
    min(coalesce(o.promo_price, o.price)),
    r.rank
  from ranked r
  left join public.offers o on o.product_id = r.id
  left join public.stores s on s.id = o.store_id
  group by r.id, r.ean, r.name, r.brand, r.size, r.image_url, r.category, r.category_group, r.rank
  order by r.rank, count(o.store_id) desc, min(coalesce(o.promo_price, o.price));
$$;
grant execute on function public.search_products(text, int, text) to anon, authenticated;
