-- ArtGuard Hub: authenticated simulated commission payments for demonstrations.
-- Apply after commission-payment-simulation-lockdown.sql and the current
-- commission-start payment guard. This records no real charge or transfer.

begin;

alter table public.commission_payments
  add column if not exists demo_paid_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'commission_payments_demo_marker_check'
      and conrelid = 'public.commission_payments'::regclass
  ) then
    alter table public.commission_payments
      add constraint commission_payments_demo_marker_check
      check (
        demo_paid_at is null
        or (
          status in ('PAID', 'REFUNDED')
          and provider = 'DEMO_SIMULATION'
          and provider_verified_at is null
          and paid_at is not null
        )
      );
  end if;
end;
$$;

revoke insert (demo_paid_at), update (demo_paid_at)
  on table public.commission_payments from public, anon, authenticated;

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

  -- Keep the lock order consistent with cancellation and payment creation:
  -- commission first, then payment.
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

  if v_payment.provider is not null and v_payment.provider <> 'DEMO_SIMULATION' then
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

  update public.commission_payments
  set status = 'PAID',
      provider = 'DEMO_SIMULATION',
      paid_at = now(),
      demo_paid_at = now()
  where id = v_payment.id
    and status = 'PENDING'
    and provider_verified_at is null
  returning * into v_payment;
  if not found then raise exception 'Payment is no longer pending'; end if;

  return v_payment;
end;
$$;

revoke all on function public.simulate_commission_payment_demo_success(uuid)
  from public, anon, authenticated;
grant execute on function public.simulate_commission_payment_demo_success(uuid)
  to authenticated;

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
            payment.demo_paid_at is not null
            and payment.provider = 'DEMO_SIMULATION'
            and payment.provider_verified_at is null
          )
        )
    ) then
    raise exception 'PAYMENT_PROVIDER_VERIFICATION_REQUIRED';
  end if;

  return new;
end;
$$;

create or replace function public.list_my_demo_commission_earnings()
returns table (
  payment_id uuid,
  commission_id uuid,
  client_name text,
  commission_title text,
  amount numeric,
  currency text,
  payment_status text,
  paid_at timestamptz,
  refunded_at timestamptz,
  commission_status text,
  earnings_category text
)
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select
    payment.id,
    commission.id,
    client.name,
    commission.title,
    payment.amount,
    payment.currency,
    payment.status,
    payment.paid_at,
    payment.refunded_at,
    commission.status,
    case
      when payment.status = 'REFUNDED' then 'REFUNDED'
      when commission.status = 'CANCELLED' then 'CANCELLED'
      when commission.status = 'COMPLETED' then 'COMPLETED'
      else 'PENDING'
    end
  from public.commission_payments as payment
  join public.commissions as commission
    on commission.id = payment.commission_id
  join public.profiles as client
    on client.id = payment.payer_id
  where auth.uid() is not null
    and payment.payee_id = auth.uid()
    and payment.demo_paid_at is not null
    and payment.status in ('PAID', 'REFUNDED')
    and exists (
      select 1
      from public.profiles as viewer
      where viewer.id = auth.uid()
        and viewer.role = 'artist'
    )
  order by payment.paid_at desc nulls last;
$$;

revoke all on function public.list_my_demo_commission_earnings()
  from public, anon, authenticated;
grant execute on function public.list_my_demo_commission_earnings()
  to authenticated;

commit;
