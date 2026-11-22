-- Remove row locking from the account-active helper used by SELECT policies.
-- Apply after account-lifecycle-hardening.sql on databases with the older
-- function body. This leaves write-specific locking in place.

begin;

do $$
begin
  if to_regclass('public.account_lifecycle') is null
    or to_regprocedure('public.is_my_account_active()') is null then
    raise exception 'Read-only account check correction requires the lifecycle table and RPC';
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

commit;
