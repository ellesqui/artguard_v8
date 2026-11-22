-- Account lifecycle hardening.
-- Apply after the profile, commission, payment, artwork, chat, and notification
-- foundations exist. This migration never hard-deletes user data.

begin;

do $$
declare
  v_table_name text;
  v_rls_enabled boolean;
begin
  foreach v_table_name in array array[
    'profiles',
    'conversations',
    'conversation_participants',
    'messages',
    'commissions',
    'commission_payments',
    'commission_milestones',
    'commission_deliverables',
    'revision_requests',
    'commission_progress_updates',
    'commission_posts',
    'commission_post_applications',
    'artworks',
    'notifications',
    'artist_commission_services'
  ]
  loop
    if to_regclass(format('public.%I', v_table_name)) is null then
      raise exception 'Account lifecycle migration requires public.% to exist', v_table_name;
    end if;

    select c.relrowsecurity
      into v_rls_enabled
    from pg_class as c
    where c.oid = to_regclass(format('public.%I', v_table_name));

    if v_rls_enabled is distinct from true then
      raise exception 'Account lifecycle migration requires RLS enabled on public.%', v_table_name;
    end if;
  end loop;

  if to_regclass('storage.objects') is null then
    raise exception 'Account lifecycle migration requires storage.objects to exist';
  end if;

  select c.relrowsecurity
    into v_rls_enabled
  from pg_class as c
  where c.oid = to_regclass('storage.objects');

  if v_rls_enabled is distinct from true then
    raise exception 'Account lifecycle migration requires RLS enabled on storage.objects';
  end if;

  foreach v_table_name in array array[
    'artist_reviews',
    'artwork_likes',
    'artwork_comments',
    'artwork_protection_settings',
    'commission_post_comments',
    'conversation_notification_preferences',
    'user_blocks'
  ]
  loop
    if to_regclass(format('public.%I', v_table_name)) is not null then
      select c.relrowsecurity
        into v_rls_enabled
      from pg_class as c
      where c.oid = to_regclass(format('public.%I', v_table_name));

      if v_rls_enabled is distinct from true then
        raise exception 'Account lifecycle migration requires RLS enabled on public.%', v_table_name;
      end if;
    end if;
  end loop;
end;
$$;

create table if not exists public.account_lifecycle (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'DEACTIVATED')),
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_lifecycle_status_timestamp_check check (
    (status = 'ACTIVE' and deactivated_at is null)
    or (status = 'DEACTIVATED' and deactivated_at is not null)
  )
);

insert into public.account_lifecycle (user_id)
select p.id
from public.profiles as p
on conflict (user_id) do nothing;

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz
);

alter table public.account_deletion_requests
  drop constraint if exists account_deletion_requests_status_check;
alter table public.account_deletion_requests
  add constraint account_deletion_requests_status_check
  check (status in ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'));

drop index if exists public.account_deletion_requests_one_open_per_user_idx;
create unique index account_deletion_requests_one_open_per_user_idx
  on public.account_deletion_requests(user_id)
  where status in ('PENDING', 'IN_REVIEW', 'APPROVED');

alter table public.account_lifecycle enable row level security;
revoke all on public.account_lifecycle from public, anon, authenticated;
grant all on public.account_lifecycle to service_role;

alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant all on public.account_deletion_requests to service_role;
grant select (status, requested_at, reviewed_at, completed_at)
  on public.account_deletion_requests to authenticated;

drop policy if exists "users can read their own account deletion requests"
  on public.account_deletion_requests;
create policy "users can read their own account deletion requests"
on public.account_deletion_requests for select
to authenticated
using (user_id = auth.uid());

create or replace function public.ensure_account_lifecycle_row()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.account_lifecycle (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.ensure_account_lifecycle_row() from public, anon, authenticated;
drop trigger if exists profiles_ensure_account_lifecycle_row on public.profiles;
create trigger profiles_ensure_account_lifecycle_row
after insert on public.profiles
for each row execute function public.ensure_account_lifecycle_row();

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

revoke all on function public.is_my_account_active() from public, anon;
grant execute on function public.is_my_account_active() to authenticated;

create or replace function public.is_my_account_writable()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
begin
  if v_user_id is null then
    return false;
  end if;

  select lifecycle.status
    into v_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = v_user_id
  for key share;

  return v_status = 'ACTIVE'
    and not exists (
      select 1
      from public.account_deletion_requests as request
      where request.user_id = v_user_id
        and request.status in ('PENDING', 'IN_REVIEW', 'APPROVED')
    );
end;
$$;

revoke all on function public.is_my_account_writable() from public, anon;
grant execute on function public.is_my_account_writable() to authenticated;

create or replace function public.assert_account_has_no_active_work(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.commissions as commission
    where (commission.client_id = p_user_id or commission.artist_id = p_user_id)
      and commission.status in ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED')
  ) then
    raise exception 'Resolve active commissions before deactivating or requesting deletion';
  end if;

  if exists (
    select 1
    from public.commission_payments as payment
    where (payment.payer_id = p_user_id or payment.payee_id = p_user_id)
      and payment.status = 'PENDING'
  ) then
    raise exception 'Resolve pending payments before deactivating or requesting deletion';
  end if;

  if exists (
    select 1
    from public.commission_payments as payment
    join public.commissions as commission on commission.id = payment.commission_id
    where (payment.payer_id = p_user_id or payment.payee_id = p_user_id)
      and payment.status = 'PAID'
      and commission.status = 'CANCELLED'
  ) then
    raise exception 'Resolve pending simulated refunds before deactivating or requesting deletion';
  end if;

  if exists (
    select 1
    from public.commission_posts as post
    where post.client_id = p_user_id
      and post.status in ('OPEN', 'SELECTED')
  ) then
    raise exception 'Close active commission posts before deactivating or requesting deletion';
  end if;

  if exists (
    select 1
    from public.commission_post_applications as application
    where application.artist_id = p_user_id
      and application.status = 'PENDING'
  ) then
    raise exception 'Resolve pending commission applications before deactivating or requesting deletion';
  end if;
end;
$$;

revoke all on function public.assert_account_has_no_active_work(uuid)
  from public, anon, authenticated;

create or replace function public.deactivate_my_account()
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_deactivated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select lifecycle.status, lifecycle.deactivated_at
    into v_status, v_deactivated_at
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = v_user_id
  for update;

  if not found then
    raise exception 'Account lifecycle record not found';
  end if;

  if v_status = 'DEACTIVATED' then
    return v_deactivated_at;
  end if;

  perform public.assert_account_has_no_active_work(v_user_id);

  update public.artist_commission_services
  set is_active = false
  where artist_id = v_user_id
    and is_active;

  update public.account_lifecycle
  set status = 'DEACTIVATED',
      deactivated_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where user_id = v_user_id
  returning deactivated_at into v_deactivated_at;

  return v_deactivated_at;
end;
$$;

revoke all on function public.deactivate_my_account() from public, anon;
grant execute on function public.deactivate_my_account() to authenticated;

create or replace function public.request_my_account_deletion()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.account_deletion_requests;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  perform 1
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Account lifecycle record not found';
  end if;

  perform public.assert_account_has_no_active_work(v_user_id);

  select request.*
    into v_request
  from public.account_deletion_requests as request
  where request.user_id = v_user_id
    and request.status in ('PENDING', 'IN_REVIEW', 'APPROVED')
  order by request.requested_at desc
  limit 1;

  if not found then
    insert into public.account_deletion_requests (user_id)
    values (v_user_id)
    returning * into v_request;
  end if;

  return jsonb_build_object(
    'id', v_request.id,
    'status', v_request.status,
    'requested_at', v_request.requested_at
  );
end;
$$;

revoke all on function public.request_my_account_deletion() from public, anon;
grant execute on function public.request_my_account_deletion() to authenticated;

create or replace function public.guard_account_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_role text := current_setting('request.jwt.claim.role', true);
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

revoke all on function public.guard_account_write() from public, anon, authenticated;

do $$
declare
  v_table_name text;
begin
  foreach v_table_name in array array[
    'profiles',
    'conversations',
    'conversation_participants',
    'messages',
    'commissions',
    'commission_payments',
    'commission_milestones',
    'commission_deliverables',
    'revision_requests',
    'commission_progress_updates',
    'commission_posts',
    'commission_post_applications',
    'artworks',
    'notifications',
    'artist_commission_services',
    'artist_reviews',
    'artwork_likes',
    'artwork_comments',
    'artwork_protection_settings',
    'commission_post_comments',
    'conversation_notification_preferences',
    'user_blocks'
  ]
  loop
    if to_regclass(format('public.%I', v_table_name)) is not null then
      execute format('drop trigger if exists artguard_account_write_guard on public.%I', v_table_name);
      if v_table_name = 'profiles' then
        execute format(
          'create trigger artguard_account_write_guard before update or delete on public.%I for each row execute function public.guard_account_write()',
          v_table_name
        );
      else
        execute format(
          'create trigger artguard_account_write_guard before insert or update or delete on public.%I for each row execute function public.guard_account_write()',
          v_table_name
        );
      end if;
    end if;
  end loop;
end;
$$;

-- A restrictive policy composes with existing ownership policies without
-- changing the permissions of active users.
do $$
declare
  v_table_name text;
  v_has_rls boolean;
begin
  foreach v_table_name in array array[
    'profiles',
    'conversations',
    'conversation_participants',
    'messages',
    'commissions',
    'commission_payments',
    'commission_milestones',
    'commission_deliverables',
    'revision_requests',
    'commission_progress_updates',
    'commission_posts',
    'commission_post_applications',
    'artworks',
    'notifications',
    'artist_commission_services',
    'artist_reviews',
    'artwork_likes',
    'artwork_comments',
    'artwork_protection_settings',
    'commission_post_comments',
    'conversation_notification_preferences',
    'user_blocks'
  ]
  loop
    if to_regclass(format('public.%I', v_table_name)) is not null then
      select c.relrowsecurity
        into v_has_rls
      from pg_class as c
      where c.oid = to_regclass(format('public.%I', v_table_name));

      if v_has_rls then
        execute format('drop policy if exists artguard_active_account_access on public.%I', v_table_name);
        execute format(
          'create policy artguard_active_account_access on public.%I as restrictive for all to authenticated using (public.is_my_account_active()) with check (public.is_my_account_active())',
          v_table_name
        );
      end if;
    end if;
  end loop;
end;
$$;

-- Only ArtGuard-managed private storage buckets are gated; other Supabase
-- Storage buckets retain their existing policy behavior.
drop policy if exists artguard_active_account_storage_access on storage.objects;
create policy artguard_active_account_storage_access
on storage.objects as restrictive
for all
to authenticated
using (
  bucket_id not in ('artworks', 'chat-attachments')
  or public.is_my_account_writable()
)
with check (
  bucket_id not in ('artworks', 'chat-attachments')
  or public.is_my_account_writable()
);

commit;
