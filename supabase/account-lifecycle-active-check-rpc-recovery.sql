-- Narrow recovery for PostgREST PGRST202 on is_my_account_active().
-- Use only when public.account_lifecycle and the full account-lifecycle
-- protections are already installed. Otherwise apply the full
-- account-lifecycle-hardening.sql migration after validating its prerequisites.
-- Run as a trusted migration role. This does not alter account state or RLS.

begin;

do $$
begin
  if to_regclass('public.account_lifecycle') is null then
    raise exception 'Account lifecycle recovery requires public.account_lifecycle';
  end if;
  if to_regprocedure('public.is_my_account_writable()') is null
    or to_regprocedure('public.guard_account_write()') is null then
    raise exception 'Apply the full account lifecycle migration before this RPC recovery';
  end if;
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = to_regclass('public.profiles')
      and tgname = 'artguard_account_write_guard'
      and not tgisinternal
  ) then
    raise exception 'Account lifecycle profile write guard is not installed';
  end if;
  if not exists (
    select 1
    from pg_policy
    where polrelid = to_regclass('public.profiles')
      and polname = 'artguard_active_account_access'
      and not polpermissive
  ) then
    raise exception 'Account lifecycle restrictive profile policy is not installed';
  end if;
end;
$$;

create or replace function public.is_my_account_active()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    return false;
  end if;

  select lifecycle.status
    into v_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = auth.uid();

  return v_status = 'ACTIVE';
end;
$$;

revoke all on function public.is_my_account_active() from public, anon, authenticated;
grant execute on function public.is_my_account_active() to authenticated;

commit;

notify pgrst, 'reload schema';
