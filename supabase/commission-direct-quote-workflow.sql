-- Add budget and quote metadata for new direct commissions while preserving
-- legacy, service, and public-post records. Apply after
-- commission-target-deadline.sql and the existing commission/payment RPCs.
-- This file is prepared locally only; it is not applied automatically.

begin;

alter table public.commissions
  add column if not exists client_budget numeric,
  add column if not exists client_budget_currency text,
  add column if not exists proposed_amount numeric,
  add column if not exists proposed_currency text,
  add column if not exists estimated_working_hours numeric,
  add column if not exists quote_status text not null default 'NOT_REQUIRED',
  add column if not exists quote_accepted_at timestamptz;

comment on column public.commissions.client_budget is
  'Optional client spending guide; never an agreed price or payment amount.';
comment on column public.commissions.proposed_amount is
  'Artist-proposed direct commission price; copied to amount only after client acceptance.';
comment on column public.commissions.estimated_working_hours is
  'Optional artist estimate of labor hours; not calendar days or a guaranteed deadline.';
comment on column public.commissions.quote_status is
  'Direct quote state; NOT_REQUIRED preserves legacy, service, and public-post commissions.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'commissions_direct_budget_valid'
      and conrelid = 'public.commissions'::regclass
  ) then
    alter table public.commissions
      add constraint commissions_direct_budget_valid check (
        (client_budget is null and client_budget_currency is null)
        or (
          client_budget > 0
          and client_budget::text not in ('NaN', 'Infinity', '-Infinity')
          and client_budget = round(client_budget, 2)
          and client_budget_currency is not null
          and client_budget_currency ~ '^[A-Z]{3}$'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'commissions_working_hours_valid'
      and conrelid = 'public.commissions'::regclass
  ) then
    alter table public.commissions
      add constraint commissions_working_hours_valid check (
        estimated_working_hours is null
        or (
          estimated_working_hours > 0
          and estimated_working_hours::text not in ('NaN', 'Infinity', '-Infinity')
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'commissions_direct_quote_valid'
      and conrelid = 'public.commissions'::regclass
  ) then
    alter table public.commissions
      add constraint commissions_direct_quote_valid check (
        (proposed_amount is null and proposed_currency is null)
        or (
          proposed_amount > 0
          and proposed_amount::text not in ('NaN', 'Infinity', '-Infinity')
          and proposed_amount = round(proposed_amount, 2)
          and proposed_currency is not null
          and proposed_currency ~ '^[A-Z]{3}$'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'commissions_quote_state_valid'
      and conrelid = 'public.commissions'::regclass
  ) then
    alter table public.commissions
      add constraint commissions_quote_state_valid check (
        (
          quote_status = 'NOT_REQUIRED'
          and proposed_amount is null
          and proposed_currency is null
          and quote_accepted_at is null
        )
        or (
          quote_status = 'AWAITING_ARTIST'
          and proposed_amount is null
          and proposed_currency is null
          and estimated_working_hours is null
          and quote_accepted_at is null
        )
        or (
          quote_status = 'PENDING_CLIENT'
          and proposed_amount is not null
          and proposed_currency is not null
          and estimated_working_hours is not null
          and quote_accepted_at is null
        )
        or (
          quote_status = 'ACCEPTED'
          and proposed_amount is not null
          and proposed_currency is not null
          and estimated_working_hours is not null
          and quote_accepted_at is not null
          and amount is not null
          and currency is not null
          and amount = proposed_amount
          and currency = proposed_currency
        )
      );
  end if;
end;
$$;

-- Keep commission changes RPC-only. Existing definer functions continue to
-- perform authorized writes; authenticated clients cannot edit quote fields.
revoke insert, update, delete on public.commissions from public, anon, authenticated;

-- Replace the deadline-aware overload with the budget-aware direct request.
drop function public.create_commission_request(uuid, text, text, date);
create function public.create_commission_request(
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
    target_deadline, client_budget, client_budget_currency, quote_status
  )
  values (
    v_order_ref, v_client_id, p_artist_id, v_title, v_description, 'REQUESTED', now(),
    p_target_deadline, p_client_budget, v_currency, 'AWAITING_ARTIST'
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

revoke all on function public.create_commission_request(uuid, text, text, date, numeric, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_commission_request(uuid, text, text, date, numeric, text)
  to authenticated;

create function public.propose_direct_commission_quote(
  p_commission_id uuid,
  p_amount numeric,
  p_currency text,
  p_estimated_working_hours numeric
)
returns public.commissions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_artist_name text;
  v_commission public.commissions;
  v_currency text := upper(nullif(btrim(p_currency), ''));
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role, profile.name into v_role, v_artist_name
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'artist' then
    raise exception 'Only artists can propose direct commission quotes';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.artist_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.service_id is not null or v_commission.public_post_id is not null then
    raise exception 'Quotes are only available for direct commissions';
  end if;
  if v_commission.status <> 'REQUESTED'
    or v_commission.quote_status <> 'AWAITING_ARTIST' then
    raise exception 'This direct commission is not awaiting an artist quote';
  end if;
  if p_amount is null or p_amount <= 0
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <> round(p_amount, 2)
    or v_currency is null
    or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'DIRECT_QUOTE_PRICE_INVALID';
  end if;
  if p_estimated_working_hours is null
    or p_estimated_working_hours <= 0
    or p_estimated_working_hours::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'DIRECT_QUOTE_HOURS_INVALID';
  end if;

  update public.commissions as commission
  set proposed_amount = p_amount,
      proposed_currency = v_currency,
      estimated_working_hours = p_estimated_working_hours,
      quote_status = 'PENDING_CLIENT'
  where commission.id = v_commission.id
    and commission.status = 'REQUESTED'
    and commission.quote_status = 'AWAITING_ARTIST'
  returning commission.* into v_commission;
  if not found then raise exception 'This direct commission is no longer awaiting an artist quote'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.client_id,
    'commission',
    'Artist Quote Received',
    coalesce(v_artist_name, 'The artist') || ' sent a proposed price for "' || v_commission.title || '". Review it before accepting.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return v_commission;
end;
$$;

revoke all on function public.propose_direct_commission_quote(uuid, numeric, text, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.propose_direct_commission_quote(uuid, numeric, text, numeric)
  to authenticated;

create function public.accept_direct_commission_quote(p_commission_id uuid)
returns public.commissions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_client_name text;
  v_commission public.commissions;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role, profile.name into v_role, v_client_name
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only clients can accept direct commission quotes';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.service_id is not null or v_commission.public_post_id is not null then
    raise exception 'This commission does not use direct quote acceptance';
  end if;
  if v_commission.quote_status = 'ACCEPTED' then
    if v_commission.status = 'ACCEPTED'
      and v_commission.quote_accepted_at is not null
      and v_commission.accepted_at is not null
      and v_commission.proposed_amount is not null
      and v_commission.proposed_currency is not null
      and v_commission.amount is not distinct from v_commission.proposed_amount
      and v_commission.currency is not distinct from v_commission.proposed_currency
      and v_commission.estimated_working_hours is not null then
      return v_commission;
    end if;
    raise exception 'The accepted quote no longer matches its saved proposal';
  end if;
  if v_commission.status <> 'REQUESTED'
    or v_commission.quote_status <> 'PENDING_CLIENT'
    or v_commission.proposed_amount is null
    or v_commission.proposed_currency is null
    or v_commission.estimated_working_hours is null then
    raise exception 'No valid artist quote is awaiting acceptance';
  end if;

  update public.commissions as commission
  set amount = commission.proposed_amount,
      currency = commission.proposed_currency,
      quote_status = 'ACCEPTED',
      quote_accepted_at = now(),
      status = 'ACCEPTED',
      accepted_at = now()
  where commission.id = v_commission.id
    and commission.status = 'REQUESTED'
    and commission.quote_status = 'PENDING_CLIENT'
    and commission.proposed_amount is not distinct from v_commission.proposed_amount
    and commission.proposed_currency is not distinct from v_commission.proposed_currency
  returning commission.* into v_commission;
  if not found then raise exception 'The quote changed before it could be accepted'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.artist_id,
    'commission',
    'Commission Quote Accepted',
    coalesce(v_client_name, 'The client') || ' accepted your quote for "' || v_commission.title || '". Simulated payment is required before work can start.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return v_commission;
end;
$$;

revoke all on function public.accept_direct_commission_quote(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_direct_commission_quote(uuid)
  to authenticated;

-- Keep legacy direct acceptance intact but prevent it bypassing a new quote.
create or replace function public.accept_commission_request(p_commission_id uuid)
returns public.commissions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission public.commissions;
  v_artist_name text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role, profile.name into v_role, v_artist_name
  from public.profiles as profile
  where profile.id = v_user;

  select commission.* into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.status <> 'REQUESTED' then
    raise exception 'Only requested commissions can be accepted';
  end if;
  if v_role is distinct from 'artist' then
    raise exception 'Only artists can accept commission requests';
  end if;
  if v_commission.artist_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.service_id is null
    and v_commission.public_post_id is null
    and v_commission.quote_status <> 'NOT_REQUIRED' then
    raise exception 'DIRECT_COMMISSION_QUOTE_REQUIRED';
  end if;

  update public.commissions as commission
  set status = 'ACCEPTED', accepted_at = now()
  where commission.id = p_commission_id
    and commission.status = 'REQUESTED'
  returning commission.* into v_commission;
  if not found then raise exception 'Only requested commissions can be accepted'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.client_id,
    'commission',
    'Commission Request Accepted',
    'Your commission request has been accepted by ' || coalesce(v_artist_name, 'the artist') || '.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return v_commission;
end;
$$;

revoke all on function public.accept_commission_request(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_commission_request(uuid)
  to authenticated;

-- Preserve the symmetric public-post selection flow. An Artist who owns the
-- post supplies the estimate; a Client selector cannot invent the Artist's hours.
drop function public.select_commission_post_applicant(uuid, uuid, numeric, text, date);
create function public.select_commission_post_applicant(
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
    target_deadline, estimated_working_hours
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
    p_estimated_working_hours
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

revoke all on function public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric)
  to authenticated;

-- Existing direct requests with quote_status NOT_REQUIRED retain their
-- previous start behavior. New quote-required requests need payment after quote acceptance.
create or replace function public.start_commission(p_commission_id uuid)
returns public.commissions
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission public.commissions;
  v_post_owner_id uuid;
  v_post_owner_role text;
  v_paid_payment_id uuid;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'artist' then
    raise exception 'Only artists can start commissions';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.artist_id <> v_user then raise exception 'Not authorized for this commission'; end if;
  if v_commission.status <> 'ACCEPTED' then raise exception 'Only accepted commissions can be started'; end if;
  if v_commission.service_id is null
    and v_commission.public_post_id is null
    and v_commission.quote_status in ('AWAITING_ARTIST', 'PENDING_CLIENT') then
    raise exception 'DIRECT_COMMISSION_QUOTE_PENDING_BEFORE_START';
  end if;

  if v_commission.public_post_id is not null then
    select post.owner_id, post.owner_role into v_post_owner_id, v_post_owner_role
    from public.commission_posts as post
    where post.id = v_commission.public_post_id
    for share;
    if not found then raise exception 'PUBLIC_POST_PROVENANCE_MISMATCH'; end if;

    if v_post_owner_role = 'client' and not exists (
      select 1 from public.commission_post_applications as application
      where application.commission_post_id = v_commission.public_post_id
        and application.applicant_id = v_commission.artist_id
        and application.applicant_role = 'artist'
        and application.status = 'SELECTED'
        and v_commission.client_id = v_post_owner_id
    ) then
      raise exception 'PUBLIC_POST_PROVENANCE_MISMATCH';
    elsif v_post_owner_role = 'artist' and not exists (
      select 1 from public.commission_post_applications as application
      where application.commission_post_id = v_commission.public_post_id
        and application.applicant_id = v_commission.client_id
        and application.applicant_role = 'client'
        and application.status = 'SELECTED'
        and v_commission.artist_id = v_post_owner_id
    ) then
      raise exception 'PUBLIC_POST_PROVENANCE_MISMATCH';
    elsif v_post_owner_role not in ('client', 'artist') then
      raise exception 'PUBLIC_POST_PROVENANCE_MISMATCH';
    end if;
  end if;

  if v_commission.service_id is not null
    or v_commission.public_post_id is not null
    or v_commission.quote_status = 'ACCEPTED' then
    if v_commission.amount is null
      or v_commission.amount <= 0
      or v_commission.amount::text in ('NaN', 'Infinity', '-Infinity')
      or v_commission.currency is null
      or v_commission.currency !~ '^[A-Z]{3}$' then
      raise exception 'COMMISSION_PRICE_UNAVAILABLE';
    end if;

    -- PAID excludes REFUNDED and VOIDED; refund metadata also rejects inconsistent rows.
    select payment.id into v_paid_payment_id
    from public.commission_payments as payment
    where payment.commission_id = v_commission.id
      and payment.payer_id = v_commission.client_id
      and payment.payee_id = v_commission.artist_id
      and payment.amount = v_commission.amount
      and payment.currency = v_commission.currency
      and payment.status = 'PAID'
      and payment.refunded_at is null
      and coalesce(payment.refunded_amount, 0) = 0
      and (
        v_commission.service_id is not null
        or v_commission.public_post_id is not null
        or (
          v_commission.service_id is null
          and v_commission.public_post_id is null
          and v_commission.quote_status = 'ACCEPTED'
          and payment.amount = v_commission.proposed_amount
          and payment.currency = v_commission.proposed_currency
          and payment.provider = 'DEMO_SIMULATION'
          and payment.demo_paid_at is not null
          and payment.paid_at is not null
          and payment.provider_reference is null
        )
      )
    for share;
    if not found then raise exception 'PAYMENT_REQUIRED_BEFORE_START'; end if;
  end if;

  update public.commissions as commission
  set status = 'IN_PROGRESS', started_at = now()
  where commission.id = p_commission_id
  returning commission.* into v_commission;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  select
    v_commission.client_id,
    'commission',
    'Commission Started',
    coalesce((select profile.name from public.profiles as profile where profile.id = v_user), 'Your artist') || ' has started working on your commission.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text;

  return v_commission;
end;
$$;

revoke all on function public.start_commission(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.start_commission(uuid)
  to authenticated;

commit;
