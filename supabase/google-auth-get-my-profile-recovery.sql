begin;

create or replace function public.get_my_profile()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select to_jsonb(p)
  from public.profiles as p
  where p.id = auth.uid()
$$;

revoke all on function public.get_my_profile() from public, anon, authenticated;
grant execute on function public.get_my_profile() to authenticated;

commit;

notify pgrst, 'reload schema';
