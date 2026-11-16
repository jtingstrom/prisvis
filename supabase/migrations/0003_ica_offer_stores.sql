-- ICA-butiker utan e-handel: bara veckans erbjudanden från ica.se/erbjudanden/<slug>/

alter table public.stores
  add column coverage text not null default 'full' check (coverage in ('full', 'offers')),
  add column ica_offers_slug text unique;

-- Ta bort erbjudanden som inte sågs i senaste hämtningen (utgångna kampanjer)
create or replace function public.prune_store_offers(p_token text, p_store text, p_before timestamptz)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.check_token(p_token);
  delete from public.offers where store_id = p_store and last_seen < p_before;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.prune_store_offers(text, text, timestamptz) from public;
grant execute on function public.prune_store_offers(text, text, timestamptz) to anon, authenticated;

insert into public.stores (id, chain, name, website, coverage, ica_offers_slug, requested_at, request_count)
values ('ica-o1051007', 'ica', 'ICA Nära Pedagogen Park', 'https://www.ica.se/erbjudanden/ica-nara-pedagogen-park-1051007/',
        'offers', 'ica-nara-pedagogen-park-1051007', now(), 1)
on conflict (id) do nothing;
