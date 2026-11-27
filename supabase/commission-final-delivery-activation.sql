begin;

create or replace function public.create_commission_request(
  p_artist_id uuid,
  p_title text,
  p_description text,
  p_target_deadline date default null,
  p_client_budget numeric default null,
  p_client_budget_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_client_id uuid := auth.uid();
  v_client_role text;
  v_artist_role text;
  v_client_name text;
  v_accepting_commissions boolean;
  v_existing public.commissions;
  v_created public.commissions;
  v_title text := nullif(btrim(p_title), '');
  v_description text := nullif(btrim(p_description), '');
  v_currency text := upper(nullif(btrim(p_client_budget_currency), ''));
  v_order_ref text := 'CM-' || gen_random_uuid()::text;
begin
  if v_client_id is null then raise exception 'Not authenticated'; end if;
  if p_artist_id is null or p_artist_id = v_client_id then raise exception 'Invalid artist'; end if;
  if v_title is null then raise exception 'Commission title is required'; end if;
  if v_description is null then raise exception 'Commission description is required'; end if;
  if p_target_deadline is not null
    and p_target_deadline < (now() at time zone 'UTC')::date then
    raise exception 'TARGET_DEADLINE_IN_PAST';
  end if;

  if p_client_budget is null then
    if v_currency is not null then raise exception 'DIRECT_BUDGET_CURRENCY_WITHOUT_AMOUNT'; end if;
  elsif p_client_budget <= 0
    or p_client_budget::text in ('NaN', 'Infinity', '-Infinity')
    or p_client_budget <> round(p_client_budget, 2)
    or v_currency is null
    or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'DIRECT_BUDGET_INVALID';
  end if;

  select profile.role, profile.name into v_client_role, v_client_name
  from public.profiles as profile
  where profile.id = v_client_id;
  select profile.role into v_artist_role
  from public.profiles as profile
  where profile.id = p_artist_id;

  if v_client_role is distinct from 'client' then
    raise exception 'Only client accounts can create commission requests';
  end if;
  if v_artist_role is distinct from 'artist' then
    raise exception 'The selected account is not an artist';
  end if;

  select profile.accepting_commissions into v_accepting_commissions
  from public.profiles as profile
  where profile.id = p_artist_id
  for update;
  if not found then raise exception 'Artist profile not found'; end if;

  select commission.* into v_existing
  from public.commissions as commission
  where commission.client_id = v_client_id
    and commission.artist_id = p_artist_id
    and commission.status in ('REQUESTED', 'ACCEPTED')
  order by commission.requested_at desc
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('commission_id', v_existing.id, 'created', false);
  end if;
  if v_accepting_commissions is distinct from true then
    raise exception 'ARTIST_NOT_ACCEPTING_COMMISSIONS';
  end if;

  insert into public.commissions (
    order_ref, client_id, artist_id, title, description, status, requested_at,
    target_deadline, client_budget, client_budget_currency, quote_status,
    final_delivery_required
  )
  values (
    v_order_ref, v_client_id, p_artist_id, v_title, v_description, 'REQUESTED', now(),
    p_target_deadline, p_client_budget, v_currency, 'AWAITING_ARTIST', true
  )
  returning * into v_created;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    p_artist_id,
    'commission',
    'New Commission Request',
    'You received a new commission request from ' || coalesce(v_client_name, 'a client') || '.',
    v_created.id,
    '/home/workspace/' || v_created.id::text
  );

  return jsonb_build_object('commission_id', v_created.id, 'created', true);
end;
$$;

alter function public.create_commission_request(uuid, text, text, date, numeric, text) owner to postgres;
revoke all on function public.create_commission_request(uuid, text, text, date, numeric, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_commission_request(uuid, text, text, date, numeric, text)
  to authenticated, postgres;

create or replace function public.select_commission_post_applicant(
  p_commission_post_id uuid,
  p_application_id uuid,
  p_amount numeric,
  p_currency text,
  p_target_deadline date default null,
  p_estimated_working_hours numeric default null
)
returns public.commissions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_owner_name text;
  v_post public.commission_posts;
  v_application public.commission_post_applications;
  v_applicant_role text;
  v_client_id uuid;
  v_artist_id uuid;
  v_created public.commissions;
begin
  if v_user is null then raise exception 'SELECTION_NOT_AUTHORIZED'; end if;
  if p_target_deadline is not null
    and p_target_deadline < (now() at time zone 'UTC')::date then
    raise exception 'TARGET_DEADLINE_IN_PAST';
  end if;

  select profile.role, profile.name into v_role, v_owner_name
  from public.profiles as profile
  where profile.id = v_user;
  if v_role not in ('client', 'artist') or v_role is null then
    raise exception 'SELECTION_NOT_AUTHORIZED';
  end if;

  select post.* into v_post
  from public.commission_posts as post
  where post.id = p_commission_post_id
  for update;
  if not found then raise exception 'SELECTION_POST_NOT_FOUND'; end if;
  if v_post.owner_id <> v_user or v_post.owner_role <> v_role then
    raise exception 'SELECTION_NOT_AUTHORIZED';
  end if;
  if v_post.status <> 'OPEN' then raise exception 'SELECTION_POST_NOT_OPEN'; end if;

  select application.* into v_application
  from public.commission_post_applications as application
  where application.id = p_application_id
    and application.commission_post_id = v_post.id
  for update;
  if not found then raise exception 'SELECTION_APPLICATION_NOT_FOUND'; end if;
  if v_application.applicant_role = v_post.owner_role
    or v_application.applicant_role not in ('client', 'artist') then
    raise exception 'SELECTION_APPLICATION_ROLE_INVALID';
  end if;
  if v_application.status <> 'PENDING' then
    raise exception 'SELECTION_APPLICATION_NOT_PENDING';
  end if;

  select profile.role into v_applicant_role
  from public.profiles as profile
  where profile.id = v_application.applicant_id;
  if v_applicant_role is distinct from v_application.applicant_role then
    raise exception 'SELECTION_APPLICATION_ROLE_INVALID';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <> round(p_amount, 2) then
    raise exception 'SELECTION_INVALID_AMOUNT';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'SELECTION_INVALID_CURRENCY';
  end if;
  if v_post.currency is not null and p_currency <> v_post.currency then
    raise exception 'SELECTION_CURRENCY_MISMATCH';
  end if;
  if v_post.budget_min is not null and p_amount < v_post.budget_min then
    raise exception 'SELECTION_AMOUNT_BELOW_BUDGET';
  end if;
  if v_post.budget_max is not null and p_amount > v_post.budget_max then
    raise exception 'SELECTION_AMOUNT_ABOVE_BUDGET';
  end if;

  if v_post.owner_role = 'artist' then
    if p_estimated_working_hours is null
      or p_estimated_working_hours <= 0
      or p_estimated_working_hours::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'SELECTION_ESTIMATED_HOURS_REQUIRED';
    end if;
  elsif p_estimated_working_hours is not null then
    raise exception 'Only the Artist may provide an estimated working-hours value';
  end if;

  if v_post.owner_role = 'client' then
    v_client_id := v_post.owner_id;
    v_artist_id := v_application.applicant_id;
  else
    v_artist_id := v_post.owner_id;
    v_client_id := v_application.applicant_id;
  end if;

  insert into public.commissions (
    order_ref, client_id, artist_id, title, description, status,
    requested_at, service_id, amount, currency, public_post_id,
    target_deadline, estimated_working_hours, final_delivery_required
  )
  values (
    'CM-' || gen_random_uuid()::text,
    v_client_id,
    v_artist_id,
    v_post.title,
    v_post.description,
    'REQUESTED',
    now(),
    null,
    p_amount,
    p_currency,
    v_post.id,
    p_target_deadline,
    p_estimated_working_hours,
    true
  )
  on conflict (public_post_id) where public_post_id is not null do nothing
  returning * into v_created;
  if not found then raise exception 'SELECTION_ALREADY_COMPLETED'; end if;

  update public.commission_post_applications as application
  set status = 'SELECTED'
  where application.id = v_application.id
    and application.commission_post_id = v_post.id
    and application.status = 'PENDING';
  if not found then raise exception 'SELECTION_APPLICATION_NOT_PENDING'; end if;

  update public.commission_post_applications as application
  set status = 'REJECTED'
  where application.commission_post_id = v_post.id
    and application.id <> v_application.id
    and application.status = 'PENDING';

  update public.commission_posts as post
  set status = 'SELECTED'
  where post.id = v_post.id
    and post.owner_id = v_user
    and post.owner_role = v_role
    and post.status = 'OPEN';
  if not found then raise exception 'SELECTION_POST_NOT_OPEN'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    case when v_post.owner_role = 'client'
      then v_created.artist_id
      else v_created.client_id
    end,
    'commission',
    case when v_post.owner_role = 'client'
      then 'New Commission Request'
      else 'Public Commission Request Selected'
    end,
    coalesce(v_owner_name, 'A user') || ' selected your request for "' || v_post.title || '".',
    v_created.id,
    '/home/workspace/' || v_created.id::text
  );

  return v_created;
end;
$$;

alter function public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric) owner to postgres;
revoke all on function public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric)
  to authenticated, postgres;

commit;
