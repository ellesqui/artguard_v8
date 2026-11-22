-- Authenticated content reports and private Admin moderation workflow.
-- Apply after the profile, account-lifecycle, artwork-publication,
-- commission-post, and real commission foundations.
-- This migration records reports and decisions only; it performs no punitive
-- actions and does not change content, account, commission, or payment state.

begin;

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.artworks') is null
    or to_regclass('public.commission_posts') is null
    or to_regclass('public.commissions') is null
    or to_regclass('auth.users') is null
    or to_regprocedure('auth.uid()') is null
    or to_regprocedure('public.is_current_user_admin()') is null
    or to_regprocedure('public.is_my_account_writable()') is null then
    raise exception 'Reports require profiles, account lifecycle, and reportable content foundations';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'artworks'
      and column_name = 'visibility'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'artworks'
      and column_name = 'protected_storage_path'
  ) then
    raise exception 'Reports require artwork-publication.sql and protected artwork paths';
  end if;

  if exists (
    select required.table_name, required.column_name
    from (values
      ('artworks', 'owner_id'),
      ('artworks', 'title'),
      ('artworks', 'status'),
      ('commission_posts', 'client_id'),
      ('commission_posts', 'title'),
      ('commission_posts', 'status'),
      ('commissions', 'client_id'),
      ('commissions', 'artist_id'),
      ('commissions', 'order_ref'),
      ('commissions', 'title')
    ) as required(table_name, column_name)
    where not exists (
      select 1 from information_schema.columns as actual
      where actual.table_schema = 'public'
        and actual.table_name = required.table_name
        and actual.column_name = required.column_name
    )
  ) then
    raise exception 'Reports require the expected artwork, commission-post, and commission columns';
  end if;
end;
$$;

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  target_type text not null
    check (target_type in ('PROFILE', 'ARTWORK', 'COMMISSION_POST', 'COMMISSION')),
  target_id uuid not null,
  target_owner_id uuid,
  target_label text not null,
  category text not null
    check (category in ('SPAM', 'HARASSMENT', 'SCAM', 'INAPPROPRIATE', 'COPYRIGHT', 'OTHER')),
  details text,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_reports_details_length_check
    check (details is null or char_length(details) <= 2000),
  constraint content_reports_target_label_not_blank
    check (length(btrim(target_label)) > 0)
);

create index if not exists content_reports_queue_idx
  on public.content_reports(status, target_type, created_at desc);
create index if not exists content_reports_reporter_created_idx
  on public.content_reports(reporter_id, created_at desc);
create unique index if not exists content_reports_one_open_target_per_reporter_idx
  on public.content_reports(reporter_id, target_type, target_id)
  where reporter_id is not null and status in ('OPEN', 'IN_REVIEW');

create table if not exists public.content_report_reviews (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null
    references public.content_reports(id) on delete restrict,
  reviewer_id uuid references auth.users(id) on delete set null,
  action text not null
    check (action in ('IN_REVIEW', 'RESOLVED', 'DISMISSED')),
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  constraint content_report_reviews_decision_reason_check
    check (action = 'IN_REVIEW' or nullif(btrim(reason), '') is not null),
  constraint content_report_reviews_reason_length_check
    check (reason is null or char_length(reason) <= 2000)
);

create unique index if not exists content_report_reviews_report_action_idx
  on public.content_report_reviews(report_id, action);
create index if not exists content_report_reviews_history_idx
  on public.content_report_reviews(report_id, created_at, id);

alter table public.content_reports enable row level security;
alter table public.content_report_reviews enable row level security;

revoke all on table public.content_reports from public, anon, authenticated;
revoke all on table public.content_report_reviews from public, anon, authenticated;
grant all on table public.content_reports to service_role;
grant all on table public.content_report_reviews to service_role;

grant select (id, target_type, category, status, created_at, updated_at)
  on public.content_reports to authenticated;

drop policy if exists "reporters can read their own report status"
  on public.content_reports;
create policy "reporters can read their own report status"
on public.content_reports for select
to authenticated
using (reporter_id = (select auth.uid()));

create or replace function public.submit_content_report(
  p_target_type text,
  p_target_id uuid,
  p_category text,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_reporter_id uuid := auth.uid();
  v_reporter_role text;
  v_target_owner_id uuid;
  v_target_label text;
  v_other_party_id uuid;
  v_target_title text;
  v_details text := nullif(btrim(p_details), '');
  v_report public.content_reports;
  v_recent_count integer;
begin
  if v_reporter_id is null then
    raise exception using errcode = '28000', message = 'Not authenticated';
  end if;
  if not public.is_my_account_writable() then
    raise exception using errcode = '42501', message = 'This account cannot submit reports right now';
  end if;
  if p_target_type is null
    or p_target_type not in ('PROFILE', 'ARTWORK', 'COMMISSION_POST', 'COMMISSION') then
    raise exception using errcode = '22023', message = 'Invalid report target type';
  end if;
  if p_target_id is null then
    raise exception using errcode = '22023', message = 'A report target is required';
  end if;
  if p_category is null
    or p_category not in ('SPAM', 'HARASSMENT', 'SCAM', 'INAPPROPRIATE', 'COPYRIGHT', 'OTHER') then
    raise exception using errcode = '22023', message = 'Select a valid report category';
  end if;
  if v_details is not null and char_length(v_details) > 2000 then
    raise exception using errcode = '22023', message = 'Report details must be 2000 characters or fewer';
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = v_reporter_id
  for update;
  if not found then
    raise exception using errcode = '28000', message = 'Authenticated account not found';
  end if;

  select profile.role
    into v_reporter_role
  from public.profiles as profile
  where profile.id = v_reporter_id;
  if v_reporter_role is null then
    raise exception using errcode = '42501', message = 'A completed profile is required to submit reports';
  end if;

  case p_target_type
    when 'PROFILE' then
      select profile.id,
             'Profile: ' || coalesce(nullif(btrim(profile.name), ''), profile.username, 'Unavailable')
        into v_target_owner_id, v_target_label
      from public.profiles as profile
      where profile.id = p_target_id;

    when 'ARTWORK' then
      select artwork.owner_id,
             'Artwork: ' || coalesce(nullif(btrim(artwork.title), ''), 'Untitled')
        into v_target_owner_id, v_target_label
      from public.artworks as artwork
      where artwork.id = p_target_id
        and artwork.status = 'ready'
        and artwork.protected_storage_path is not null
        and artwork.visibility in ('portfolio', 'discover');

    when 'COMMISSION_POST' then
      select post.client_id,
             'Commission post: ' || coalesce(nullif(btrim(post.title), ''), 'Untitled')
        into v_target_owner_id, v_target_label
      from public.commission_posts as post
      where post.id = p_target_id
        and post.status = 'OPEN';

    when 'COMMISSION' then
      select commission.client_id, commission.artist_id,
             'Commission ' || commission.order_ref || ': ' || commission.title
        into v_target_owner_id, v_other_party_id, v_target_label
      from public.commissions as commission
      where commission.id = p_target_id
        and v_reporter_id in (commission.client_id, commission.artist_id);

      if v_target_owner_id is not null and v_other_party_id is not null then
        if v_reporter_id = v_target_owner_id then
          v_target_owner_id := v_other_party_id;
        end if;
      end if;
  end case;

  if v_target_label is null then
    raise exception using errcode = '22023', message = 'Reportable content was not found or is unavailable';
  end if;
  if p_target_type <> 'COMMISSION' and v_target_owner_id = v_reporter_id then
    raise exception using errcode = '22023', message = 'You cannot report your own content or profile';
  end if;

  select count(*)
    into v_recent_count
  from public.content_reports as report
  where report.reporter_id = v_reporter_id
    and report.created_at >= clock_timestamp() - interval '24 hours';
  if v_recent_count >= 10 then
    raise exception using errcode = '22023', message = 'Report limit reached; try again later';
  end if;

  insert into public.content_reports (
    reporter_id, target_type, target_id, target_owner_id, target_label, category, details
  )
  values (
    v_reporter_id, p_target_type, p_target_id, v_target_owner_id, v_target_label, p_category, v_details
  )
  returning * into v_report;

  return jsonb_build_object(
    'id', v_report.id,
    'status', v_report.status,
    'created_at', v_report.created_at
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'You already have an open report for this content';
end;
$$;

create or replace function public.list_content_reports_for_admin(
  p_status text default null,
  p_target_type text default null
)
returns table (
  report_id uuid,
  target_type text,
  target_id uuid,
  target_label text,
  category text,
  status text,
  created_at timestamptz,
  reporter_name text,
  reporter_username text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
begin
  if auth.uid() is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;
  if p_status is not null
    and p_status not in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED') then
    raise exception using errcode = '22023', message = 'Invalid report status filter';
  end if;
  if p_target_type is not null
    and p_target_type not in ('PROFILE', 'ARTWORK', 'COMMISSION_POST', 'COMMISSION') then
    raise exception using errcode = '22023', message = 'Invalid report type filter';
  end if;

  return query
  select report.id,
         report.target_type,
         report.target_id,
         report.target_label,
         report.category,
         report.status,
         report.created_at,
         coalesce(nullif(btrim(profile.name), ''), profile.username, 'Unavailable'),
         profile.username
  from public.content_reports as report
  left join public.profiles as profile on profile.id = report.reporter_id
  where (p_status is null or report.status = p_status)
    and (p_target_type is null or report.target_type = p_target_type)
  order by case when report.status in ('OPEN', 'IN_REVIEW') then 0 else 1 end,
           report.created_at desc
  limit 100;
end;
$$;

create or replace function public.get_content_report_detail(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_detail jsonb;
begin
  if auth.uid() is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;

  select jsonb_build_object(
    'report_id', report.id,
    'target_type', report.target_type,
    'target_id', report.target_id,
    'target_label', report.target_label,
    'category', report.category,
    'details', report.details,
    'status', report.status,
    'created_at', report.created_at,
    'updated_at', report.updated_at,
    'reporter', jsonb_build_object(
      'name', coalesce(nullif(btrim(profile.name), ''), profile.username, 'Unavailable'),
      'username', profile.username
    ),
    'review_history', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'action', review.action,
          'reviewer_name', coalesce(nullif(btrim(reviewer.name), ''), reviewer.username, 'Unavailable'),
          'reason', review.reason,
          'reviewed_at', review.created_at
        )
        order by review.created_at, review.id
      )
      from public.content_report_reviews as review
      left join public.profiles as reviewer on reviewer.id = review.reviewer_id
      where review.report_id = report.id
    ), '[]'::jsonb)
  )
    into v_detail
  from public.content_reports as report
  left join public.profiles as profile on profile.id = report.reporter_id
  where report.id = p_report_id;

  if v_detail is null then
    raise exception using errcode = '22023', message = 'Report not found';
  end if;

  return v_detail;
end;
$$;

create or replace function public.review_content_report(
  p_report_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_admin_id uuid := auth.uid();
  v_status text;
  v_reason text := nullif(btrim(p_reason), '');
  v_reviewed_at timestamptz := clock_timestamp();
begin
  if v_admin_id is null or coalesce(public.is_current_user_admin(), false) is not true then
    raise exception using errcode = '42501', message = 'Admin access required';
  end if;
  if p_action is null or p_action not in ('IN_REVIEW', 'RESOLVED', 'DISMISSED') then
    raise exception using errcode = '22023', message = 'Invalid moderation action';
  end if;
  if p_action in ('RESOLVED', 'DISMISSED') and v_reason is null then
    raise exception using errcode = '22023', message = 'An explanation is required to resolve or dismiss a report';
  end if;
  if v_reason is not null and char_length(v_reason) > 2000 then
    raise exception using errcode = '22023', message = 'Moderation explanation must be 2000 characters or fewer';
  end if;

  select report.status
    into v_status
  from public.content_reports as report
  where report.id = p_report_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Report not found';
  end if;

  if p_action = 'IN_REVIEW' and v_status <> 'OPEN' then
    raise exception using errcode = '22023', message = 'Only open reports can be moved into review';
  end if;
  if p_action in ('RESOLVED', 'DISMISSED') and v_status <> 'IN_REVIEW' then
    raise exception using errcode = '22023', message = 'Only reports under review can be resolved or dismissed';
  end if;

  update public.content_reports
  set status = p_action,
      updated_at = v_reviewed_at
  where id = p_report_id;

  insert into public.content_report_reviews (report_id, reviewer_id, action, reason, created_at)
  values (p_report_id, v_admin_id, p_action, v_reason, v_reviewed_at);

  return jsonb_build_object(
    'report_id', p_report_id,
    'status', p_action,
    'updated_at', v_reviewed_at
  );
end;
$$;

revoke all on function public.submit_content_report(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.list_content_reports_for_admin(text, text)
  from public, anon, authenticated;
revoke all on function public.get_content_report_detail(uuid)
  from public, anon, authenticated;
revoke all on function public.review_content_report(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.submit_content_report(text, uuid, text, text)
  to authenticated;
grant execute on function public.list_content_reports_for_admin(text, text)
  to authenticated;
grant execute on function public.get_content_report_detail(uuid)
  to authenticated;
grant execute on function public.review_content_report(uuid, text, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
