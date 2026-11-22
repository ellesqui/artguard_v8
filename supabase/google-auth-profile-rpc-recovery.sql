-- Narrow recovery for the missing Google-auth profile RPCs.
-- Use only after read-only diagnostics confirm a required function is absent.
-- This preserves the caller-only JSONB profile response and guarded signup
-- role behavior from the existing reviewed migrations.
-- No profile table SELECT grants or RLS policies are changed here.
--
-- Run as the trusted migration role (normally postgres in Supabase). A new
-- function is owned by the executing role; CREATE OR REPLACE preserves an
-- existing function owner.

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

create or replace function public.set_my_signup_role(p_role text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('artist', 'client') then
    raise exception 'Invalid profile role'
      using errcode = '22023';
  end if;

  update public.profiles
  set role = p_role
  where id = v_user_id
    and onboarded = false
    and coalesce(cardinality(interests), 0) = 0;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.set_my_signup_role(text) from public, anon, authenticated;
grant execute on function public.set_my_signup_role(text) to authenticated;

commit;

notify pgrst, 'reload schema';
