-- Account lifecycle eligibility for every newly inserted commission.
-- Apply after account-lifecycle-hardening.sql and the latest commission RPCs.
-- Existing commission rows and status transitions are not modified.

begin;

do $$
begin
  if to_regclass('public.account_lifecycle') is null
    or to_regclass('public.account_deletion_requests') is null
    or to_regclass('public.commissions') is null then
    raise exception 'Commission lifecycle integration requires account lifecycle and commission tables';
  end if;

  if to_regprocedure('public.is_my_account_writable()') is null then
    raise exception 'Commission lifecycle integration requires public.is_my_account_writable()';
  end if;
end;
$$;

create or replace function public.is_account_writable(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_status text;
begin
  if p_user_id is null then
    return false;
  end if;

  select lifecycle.status
    into v_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = p_user_id
  for key share;

  return v_status = 'ACTIVE'
    and not exists (
      select 1
      from public.account_deletion_requests as request
      where request.user_id = p_user_id
        and request.status in ('PENDING', 'IN_REVIEW', 'APPROVED')
    );
end;
$$;

revoke all on function public.is_account_writable(uuid)
  from public, anon, authenticated;

create or replace function public.require_writable_commission_participants()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public.is_account_writable(new.client_id)
    or not public.is_account_writable(new.artist_id) then
    raise exception using
      errcode = '42501',
      message = 'Both commission participants must have writable accounts';
  end if;

  return new;
end;
$$;

revoke all on function public.require_writable_commission_participants()
  from public, anon, authenticated;

drop trigger if exists commissions_require_writable_participants
  on public.commissions;
create trigger commissions_require_writable_participants
before insert on public.commissions
for each row
execute function public.require_writable_commission_participants();

commit;
