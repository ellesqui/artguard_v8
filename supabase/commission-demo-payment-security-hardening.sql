-- ArtGuard Hub: secure the demo-payment switch and simulation-only mutations.
-- Apply after commission-payment-cancellation-coordination.sql,
-- commission-payment-refunds.sql, commission-payment-simulation-lockdown.sql,
-- commission-demo-payments.sql, and the latest commission-start payment gate.
-- This is forward-only and does not change existing payment records.

begin;

create table if not exists public.commission_demo_payment_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.commission_demo_payment_config (singleton, enabled)
values (true, false)
on conflict (singleton) do nothing;

alter table public.commission_demo_payment_config enable row level security;
revoke all on table public.commission_demo_payment_config
  from public, anon, authenticated, service_role;

create or replace function public.simulate_commission_payment_demo_success(
  p_payment_id uuid
)
returns public.commission_payments
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission_id uuid;
  v_commission public.commissions;
  v_payment public.commission_payments;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role
  into v_role
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only client accounts can simulate demo payment';
  end if;

  if not coalesce((
    select config.enabled
    from public.commission_demo_payment_config as config
    where config.singleton
  ), false) then
    raise exception 'DEMO_PAYMENTS_DISABLED';
  end if;

  select payment.commission_id
  into v_commission_id
  from public.commission_payments as payment
  where payment.id = p_payment_id
    and payment.payer_id = v_user;
  if not found then raise exception 'Payment not found or not owned by the current Client'; end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = v_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;

  select payment.*
  into v_payment
  from public.commission_payments as payment
  where payment.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;

  if v_payment.commission_id is distinct from v_commission.id
    or v_payment.payer_id is distinct from v_commission.client_id
    or v_payment.payee_id is distinct from v_commission.artist_id
    or v_payment.payer_id is distinct from v_user then
    raise exception 'Payment does not match the commission participants';
  end if;
  if v_payment.provider_verified_at is not null then
    raise exception 'Provider-verified payments cannot be simulated';
  end if;
  if v_payment.amount is distinct from v_commission.amount
    or v_payment.currency is distinct from v_commission.currency then
    raise exception 'Payment does not match the agreed commission price';
  end if;

  if v_payment.status = 'PAID'
    and v_payment.demo_paid_at is not null
    and v_payment.provider = 'DEMO_SIMULATION' then
    return v_payment;
  end if;

  if (v_payment.provider is not null and v_payment.provider <> 'DEMO_SIMULATION')
    or v_payment.provider_reference is not null then
    raise exception 'Only non-provider payment records can use demo simulation';
  end if;
  if v_commission.status = 'CANCELLED' then
    raise exception 'COMMISSION_CANCELLED';
  end if;
  if v_commission.status <> 'ACCEPTED' then
    raise exception 'Only accepted commissions can be paid';
  end if;
  if v_commission.amount is null
    or v_commission.amount <= 0
    or v_commission.currency is null
    or v_commission.currency !~ '^[A-Z]{3}$' then
    raise exception 'COMMISSION_PRICE_UNAVAILABLE';
  end if;
  if v_payment.status <> 'PENDING' then
    raise exception 'Only pending payments can be simulated as successful';
  end if;
  if v_payment.demo_paid_at is not null then
    raise exception 'Payment already has a demo payment marker';
  end if;

  update public.commission_payments
  set status = 'PAID',
      provider = 'DEMO_SIMULATION',
      paid_at = now(),
      demo_paid_at = now()
  where id = v_payment.id
    and status = 'PENDING'
    and provider_verified_at is null
    and provider_reference is null
    and demo_paid_at is null
  returning * into v_payment;
  if not found then raise exception 'Payment is no longer pending'; end if;

  return v_payment;
end;
$$;

create or replace function public.simulate_commission_payment_failure(p_payment_id uuid)
returns public.commission_payments
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission_id uuid;
  v_commission public.commissions;
  v_payment public.commission_payments;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role into v_role
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only client accounts can simulate payment';
  end if;

  if not coalesce((
    select config.enabled
    from public.commission_demo_payment_config as config
    where config.singleton
  ), false) then
    raise exception 'DEMO_PAYMENTS_DISABLED';
  end if;

  select payment.commission_id into v_commission_id
  from public.commission_payments as payment
  where payment.id = p_payment_id
    and payment.payer_id = v_user;
  if not found then raise exception 'Payment not found or not owned by the current Client'; end if;

  select c.* into v_commission
  from public.commissions as c
  where c.id = v_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.status = 'CANCELLED' then raise exception 'COMMISSION_CANCELLED'; end if;
  if v_commission.status <> 'ACCEPTED' then raise exception 'Only accepted commissions can be paid'; end if;

  select payment.* into v_payment
  from public.commission_payments as payment
  where payment.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;

  if v_payment.commission_id is distinct from v_commission.id
    or v_payment.payer_id is distinct from v_commission.client_id
    or v_payment.payee_id is distinct from v_commission.artist_id
    or v_payment.payer_id is distinct from v_user then
    raise exception 'Payment does not match the commission participants';
  end if;
  if v_payment.provider_verified_at is not null then
    raise exception 'Provider-verified payments cannot be simulated as failed';
  end if;
  if v_payment.provider is not null
    or v_payment.provider_reference is not null
    or v_payment.demo_paid_at is not null then
    raise exception 'Only unassociated mock payments can be simulated as failed';
  end if;
  if v_payment.amount is distinct from v_commission.amount
    or v_payment.currency is distinct from v_commission.currency then
    raise exception 'Payment does not match the agreed commission price';
  end if;
  if v_payment.status <> 'PENDING' then
    raise exception 'Only pending mock payments can be simulated as failed';
  end if;

  update public.commission_payments
  set status = 'FAILED'
  where id = v_payment.id
    and status = 'PENDING'
    and provider is null
    and provider_reference is null
    and provider_verified_at is null
    and demo_paid_at is null
  returning * into v_payment;
  if not found then raise exception 'Payment is no longer eligible for mock failure'; end if;

  return v_payment;
end;
$$;

create or replace function public.simulate_commission_payment_refund(p_payment_id uuid)
returns public.commission_payments
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission_id uuid;
  v_commission public.commissions;
  v_payment public.commission_payments;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role into v_role
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only client accounts can simulate refunds';
  end if;

  if not coalesce((
    select config.enabled
    from public.commission_demo_payment_config as config
    where config.singleton
  ), false) then
    raise exception 'DEMO_PAYMENTS_DISABLED';
  end if;

  select payment.commission_id into v_commission_id
  from public.commission_payments as payment
  where payment.id = p_payment_id
    and payment.payer_id = v_user;
  if not found then raise exception 'Payment not found or not owned by the current Client'; end if;

  select c.* into v_commission
  from public.commissions as c
  where c.id = v_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;

  select payment.* into v_payment
  from public.commission_payments as payment
  where payment.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;

  if v_payment.commission_id is distinct from v_commission.id
    or v_payment.payer_id is distinct from v_commission.client_id
    or v_payment.payee_id is distinct from v_commission.artist_id
    or v_payment.payer_id is distinct from v_user then
    raise exception 'Payment does not match the commission participants';
  end if;
  if v_payment.provider_verified_at is not null then
    raise exception 'Provider-verified payments cannot be simulated as refunded';
  end if;
  if v_payment.provider is distinct from 'DEMO_SIMULATION'
    or v_payment.demo_paid_at is null
    or v_payment.provider_reference is not null then
    raise exception 'Only explicitly marked demo payments can be refunded by simulation';
  end if;
  if v_commission.status <> 'CANCELLED' then
    raise exception 'Only cancelled commissions can be refunded';
  end if;
  if v_payment.status = 'REFUNDED' then
    return v_payment;
  end if;
  if v_payment.status <> 'PAID' then
    raise exception 'Only paid demo payments can be refunded';
  end if;

  update public.commission_payments
  set status = 'REFUNDED',
      refunded_amount = v_payment.amount,
      refunded_at = now()
  where id = v_payment.id
    and status = 'PAID'
    and provider = 'DEMO_SIMULATION'
    and demo_paid_at is not null
    and provider_verified_at is null
    and provider_reference is null
  returning * into v_payment;
  if not found then raise exception 'Payment is no longer eligible for demo refund'; end if;

  return v_payment;
end;
$$;

create or replace function public.require_verified_payment_before_commission_start()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.status = 'IN_PROGRESS'
    and old.status is distinct from 'IN_PROGRESS'
    and (new.service_id is not null or new.public_post_id is not null)
    and not exists (
      select 1
      from public.commission_payments as payment
      where payment.commission_id = new.id
        and payment.payer_id = new.client_id
        and payment.payee_id = new.artist_id
        and payment.amount = new.amount
        and payment.currency = new.currency
        and payment.status = 'PAID'
        and (
          payment.provider_verified_at is not null
          or (
            payment.provider = 'DEMO_SIMULATION'
            and payment.demo_paid_at is not null
            and payment.provider_verified_at is null
            and coalesce((
              select config.enabled
              from public.commission_demo_payment_config as config
              where config.singleton
            ), false)
          )
        )
    ) then
    raise exception 'PAYMENT_PROVIDER_VERIFICATION_REQUIRED';
  end if;

  return new;
end;
$$;

revoke all on function public.simulate_commission_payment_demo_success(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.simulate_commission_payment_demo_success(uuid)
  to authenticated;

revoke all on function public.simulate_commission_payment_failure(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.simulate_commission_payment_failure(uuid)
  to authenticated;

revoke all on function public.simulate_commission_payment_refund(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.simulate_commission_payment_refund(uuid)
  to authenticated;

revoke all on function public.simulate_commission_payment_success(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.simulate_commission_payment_success(uuid)
  to service_role;

commit;
