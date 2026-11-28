create or replace function public.guard_account_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
begin
  if v_user_id is null then
    if v_role = 'service_role' or session_user in ('postgres', 'supabase_admin') then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end if;
    raise exception using
      errcode = '42501',
      message = 'Not authenticated';
  end if;

  select lifecycle.status
    into v_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = v_user_id
  for key share;

  if v_status is distinct from 'ACTIVE'
    or exists (
      select 1
      from public.account_deletion_requests as request
      where request.user_id = v_user_id
        and request.status in ('PENDING', 'IN_REVIEW', 'APPROVED')
    ) then
    raise exception using
      errcode = '42501',
      message = 'This account is deactivated, has a pending deletion request, or is not provisioned';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

alter function public.guard_account_write() owner to postgres;

revoke all on function public.guard_account_write() from public, anon, authenticated;
