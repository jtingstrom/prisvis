-- Supabase startar hämtningen av Willys/Hemköp/Lidl varje morgon, eftersom
-- GitHubs egna schemalagda körningar ofta startar flera timmar sent eller inte alls.
-- GitHub-nyckeln ligger krypterad i Supabase Vault under namnet 'github_token'
-- (läggs in manuellt: select vault.create_secret('<nyckel>', 'github_token');).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function private.start_github_workflow(workflow text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_token';
  if token is null then
    raise warning 'github_token saknas i Vault';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/jtingstrom/prisvis/actions/workflows/' || workflow || '/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'prisvis-supabase'),
    body := '{"ref":"main","inputs":{"auto":"true"}}'::jsonb
  );
end;
$$;
revoke all on function private.start_github_workflow(text) from public, anon, authenticated;

-- 04:30 UTC (05:30 vintertid / 06:30 sommartid) och en reserv 06:30 UTC.
-- Reserven gör ingenting om dagens hämtning redan är klar (jobbet "gate").
select cron.schedule('prisvis-axfood', '30 4 * * *', $$select private.start_github_workflow('scrape.yml')$$);
select cron.schedule('prisvis-axfood-reserv', '30 6 * * *', $$select private.start_github_workflow('scrape.yml')$$);
