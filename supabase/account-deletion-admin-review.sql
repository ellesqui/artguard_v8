-- Admin-only review workflow for private account deletion requests.
-- Apply after profile-access-expand.sql and account-lifecycle-hardening.sql.
-- Approval records a decision only; it never deletes account data.

begin;

do $$
begin
  if to_regclass('public.account_deletion_requests') is null
    or to_regclass('public.account_lifecycle') is null
    or to_regclass('public.commissions') is null
    or to_regclass('public.commission_payments') is null
    or to_regclass('public.commission_posts') is null
    or to_regclass('public.commission_post_applications') is null then
    raise exception 'Account deletion review requires the account lifecycle and commission foundations';
  end if;

  if to_regprocedure('public.is_current_user_admin()') is null then
    raise exception 'Account deletion review requires public.is_current_user_admin() from profile-access-expand.sql';
  end if;

  if to_regprocedure('public.assert_account_has_no_active_work(uuid)') is null then
    raise exception 'Account deletion review requires public.assert_account_has_no_active_work(uuid)';
  end if;
end;
$$;

alter table public.account_deletion_requests
  drop constraint if exists account_deletion_requests_status_check;
alter table public.account_deletion_requests
  add constraint account_deletion_requests_status_check
  check (status in ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'));

drop index if exists public.account_deletion_requests_one_open_per_user_idx;
create unique index account_deletion_requests_one_open_per_user_idx
  on public.account_deletion_requests(user_id)
  where status in ('PENDING', 'IN_REVIEW', 'APPROVED');

create table if not exists public.account_deletion_request_reviews (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.account_deletion_requests(id) on delete restrict,
  reviewer_id uuid not null,
  action text not null check (action in ('IN_REVIEW', 'APPROVED', 'REJECTED')),
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  constraint account_deletion_request_reviews_decision_reason_check
    check (action = 'IN_REVIEW' or nullif(btrim(reason), '') is not null),
  constraint account_deletion_request_reviews_reason_length_check
    check (reason is null or char_length(reason) <= 2000)
);

create unique index if not exists account_deletion_request_reviews_request_action_idx
  on public.account_deletion_request_reviews(request_id, action);
create index if not exists account_deletion_request_reviews_request_created_idx
  on public.account_deletion_request_reviews(request_id, created_at, id);

alter table public.account_deletion_request_reviews enable row level security;
revoke all on public.account_deletion_request_reviews from public, anon, authenticated;
grant all on public.account_deletion_request_reviews to service_role;

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
      message = 'This account is deactivated, has an open deletion request, or is not provisioned';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_account_write() from public, anon, authenticated;

create or replace function public.list_account_deletion_requests_for_admin()
returns table (
  request_id uuid,
  requester_name text,
  requester_username text,
  requester_role text,
  status text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;

  return query
  select
    request.id,
    coalesce(nullif(profile.name, ''), profile.username, 'Unavailable'),
    profile.username,
    profile.role::text,
    request.status,
    request.requested_at
  from public.account_deletion_requests as request
  left join public.profiles as profile on profile.id = request.user_id
  order by
    case when request.status in ('PENDING', 'IN_REVIEW') then 0 else 1 end,
    request.requested_at desc;
end;
$$;

create or replace function public.get_account_deletion_request_review(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;

  select jsonb_build_object(
    'request_id', request.id,
    'status', request.status,
    'requested_at', request.requested_at,
    'reviewed_at', request.reviewed_at,
    'requester', jsonb_build_object(
      'name', coalesce(nullif(profile.name, ''), profile.username, 'Unavailable'),
      'username', profile.username,
      'role', profile.role
    ),
    'account_state', jsonb_build_object(
      'lifecycle_status', coalesce(lifecycle.status, 'UNKNOWN'),
      'active_commissions', (
        select count(*)
        from public.commissions as commission
        where (commission.client_id = request.user_id or commission.artist_id = request.user_id)
          and commission.status in ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED')
      ),
      'pending_payments', (
        select count(*)
        from public.commission_payments as payment
        where (payment.payer_id = request.user_id or payment.payee_id = request.user_id)
          and payment.status = 'PENDING'
      ),
      'open_commission_posts', (
        select count(*)
        from public.commission_posts as post
        where post.client_id = request.user_id
          and post.status in ('OPEN', 'SELECTED')
      ),
      'pending_applications', (
        select count(*)
        from public.commission_post_applications as application
        where application.artist_id = request.user_id
          and application.status = 'PENDING'
      )
    ),
    'review_history', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'action', review.action,
          'reviewer_name', coalesce(nullif(reviewer.name, ''), reviewer.username, 'Unavailable'),
          'reviewed_at', review.created_at,
          'reason', review.reason
        )
        order by review.created_at, review.id
      )
      from public.account_deletion_request_reviews as review
      left join public.profiles as reviewer on reviewer.id = review.reviewer_id
      where review.request_id = request.id
    ), '[]'::jsonb)
  )
    into v_result
  from public.account_deletion_requests as request
  left join public.profiles as profile on profile.id = request.user_id
  left join public.account_lifecycle as lifecycle on lifecycle.user_id = request.user_id
  where request.id = p_request_id;

  if v_result is null then
    raise exception 'Account deletion request not found';
  end if;

  return v_result;
end;
$$;

create or replace function public.review_account_deletion_request(
  p_request_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_admin_id uuid := auth.uid();
  v_requester_id uuid;
  v_status text;
  v_reason text := nullif(btrim(p_reason), '');
  v_reviewed_at timestamptz := clock_timestamp();
begin
  if v_admin_id is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;

  if p_action is null or p_action not in ('IN_REVIEW', 'APPROVED', 'REJECTED') then
    raise exception using errcode = '22023', message = 'Invalid account deletion review action';
  end if;

  if p_action in ('APPROVED', 'REJECTED') and v_reason is null then
    raise exception using errcode = '22023', message = 'A reason is required to approve or reject a request';
  end if;

  if v_reason is not null and char_length(v_reason) > 2000 then
    raise exception using errcode = '22023', message = 'Review reason must be 2000 characters or fewer';
  end if;

  select request.user_id, request.status
    into v_requester_id, v_status
  from public.account_deletion_requests as request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'Account deletion request not found';
  end if;

  if p_action = 'IN_REVIEW' and v_status <> 'PENDING' then
    raise exception 'Only pending requests can be moved into review';
  end if;

  if p_action in ('APPROVED', 'REJECTED') and v_status <> 'IN_REVIEW' then
    raise exception 'Only requests under review can be approved or rejected';
  end if;

  if p_action = 'APPROVED' then
    perform public.assert_account_has_no_active_work(v_requester_id);
  end if;

  update public.account_deletion_requests
  set status = p_action,
      reviewed_at = v_reviewed_at
  where id = p_request_id;

  insert into public.account_deletion_request_reviews (
    request_id,
    reviewer_id,
    action,
    reason,
    created_at
  )
  values (
    p_request_id,
    v_admin_id,
    p_action,
    v_reason,
    v_reviewed_at
  );

  return jsonb_build_object(
    'request_id', p_request_id,
    'status', p_action,
    'reviewed_at', v_reviewed_at
  );
end;
$$;

revoke all on function public.list_account_deletion_requests_for_admin() from public, anon, authenticated;
revoke all on function public.get_account_deletion_request_review(uuid) from public, anon, authenticated;
revoke all on function public.review_account_deletion_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.list_account_deletion_requests_for_admin() to authenticated;
grant execute on function public.get_account_deletion_request_review(uuid) to authenticated;
grant execute on function public.review_account_deletion_request(uuid, text, text) to authenticated;

commit;
